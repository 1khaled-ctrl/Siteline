"""Close-up terrain for the Moon's south-pole landing sites, cut from NASA's finest models.

For each Moon mission inside 83 degrees south, the finest source that covers it: one of the 13 Artemis III candidate
regions at 5 m (dataset a3clr-sfs-5m), else LOLA's 10 m terrain (lola-spole-10m). The patch is written the way the
close-up view already reads the Landfall demo's patches (sitePatch.ts): a PNG of 16-bit metres in red and green with
32768 as zero, on a grid of latitude rows and longitude columns, plus its entry in sites.json. Near the pole a
degree of longitude is a few hundred metres, so the entry carries a separate longitude half-width (`lonHalf`) that
keeps the patch square on the ground, and the source's resolution (`pixM`) so the camera stops where it runs out.

Each Artemis region is opened from the first quarter megabyte of its elevation model, enough for its header, and
the whole model (about 70 MB of a 1 to 4 GB archive) is fetched only when a site needs it. The 10 m file gives up
only the tiles a window needs. Nothing here needs GDAL.
"""

import hashlib
import json
import zlib
from collections.abc import Callable

import numpy as np

from . import config, tiff, zipdir
from .kernels import PIPELINE
from .mars_normal import git_commit
from .pngio import write_png_rgb

MOON_RADIUS_M = 1_737_400.0
DEG = np.pi / 180
MISSIONS_PATH = PIPELINE.parent / "data" / "missions.json"
DEMO_SITES_PATH = PIPELINE / "raw" / "landfall" / "data" / "sites.json"
OUT_DIR = PIPELINE / "out" / "sites"
MANIFEST_PATH = OUT_DIR / "sites.manifest.json"
HEIGHT_OFFSET_M = 32768
# Each patch is this many pixels on a side.
PATCH_PX = 2048
# Half the patch's width on the ground: as much as fits inside an Artemis region, up to this, and this much from
# the 10 m terrain. A region that cannot give at least MIN_HALF_M around the site is left to the 10 m terrain.
ARTEMIS_HALF_M = 8_000.0
FALLBACK_HALF_M = 10_000.0
MIN_HALF_M = 3_000.0
# Sites this far north of the pole are judged by the 10 m terrain's reach.
SOUTH_LIMIT_DEG = -83.0
# The demo's patches, by body: their resolution, from CREDITS.md (1/256 and 1/128 of a degree).
DEMO_PIX_M = {"moon": 118.0, "mars": 462.0}
# How much of a zip member is enough to read the model's header.
HEAD_BYTES = 256 << 10


def polar_xy(lat_deg: np.ndarray, lon_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """LOLA's south polar stereographic plane, in metres, as the app's `polarXY`: x = rho sin(lon), y = rho cos(lon)."""
    lat = np.asarray(lat_deg, dtype=np.float64) * DEG
    lon = np.asarray(lon_deg, dtype=np.float64) * DEG
    k = 2 * MOON_RADIUS_M / (1 - np.sin(lat))
    return k * np.cos(lat) * np.sin(lon), k * np.cos(lat) * np.cos(lon)


class Region:
    """One terrain source: where it sits on the plane, and its grid, fetched whole only when first read."""

    def __init__(self, dataset_id: str, name: str, head: tiff.Grid, load: Callable[[], tuple[tiff.Grid, dict]]):
        self.dataset_id = dataset_id
        self.name = name
        self.x0, self.y0 = head.origin_x, head.origin_y
        self.x1 = head.origin_x + head.width * head.pixel_m
        self.y1 = head.origin_y - head.height * head.pixel_m
        self.pixel_m = head.pixel_m
        self._load = load
        self._grid: tiff.Grid | None = None
        self.input: dict | None = None

    @property
    def grid(self) -> tiff.Grid:
        if self._grid is None:
            self._grid, self.input = self._load()
        return self._grid

    def room(self, x: float, y: float) -> float:
        """How far a square around (x, y) can reach before leaving this source, in metres."""
        return min(x - self.x0, self.x1 - x, self.y0 - y, y - self.y1)


def artemis_regions() -> list[Region]:
    """Every Artemis region, opened from the head of its elevation model inside its zip on the bucket."""
    cfg = config.load("a3clr-sfs-5m")
    base = config.text(cfg, "baseUrl")
    suffix = config.text(cfg, "member")
    regions = []
    for line in config.names(cfg, "files"):
        name, size_text = line.split()
        url = f"{base}/{name}.zip"
        total = zipdir.content_length(url)
        if total != int(size_text):
            raise ValueError(f"{name}.zip is {total} bytes on the bucket, the config says {size_text}")
        archive = zipdir.Archive.remote(url, total)
        member = archive.find(suffix)
        start = archive.data_offset(member)
        head = zlib.decompressobj(-15).decompress(archive.fetch(start, min(HEAD_BYTES, member.compressed)))

        def load(archive: zipdir.Archive = archive, member: zipdir.Member = member, name: str = name) -> tuple:
            data = archive.read(member)
            record = {"archive": f"{name}.zip", "member": member.name, "bytes": len(data), "sha256": sha256(data)}
            return tiff.open_grid(tiff.BytesSource(data)), record

        regions.append(Region("a3clr-sfs-5m", name, tiff.open_grid(tiff.BytesSource(head)), load))
    return regions


def fallback_region() -> Region:
    cfg = config.load("lola-spole-10m")
    url = config.text(cfg, "url")
    total = zipdir.content_length(url)
    if total != config.number(cfg, "bytes"):
        raise ValueError(
            f"the 10 m terrain is {total} bytes on the bucket, the config says {config.number(cfg, 'bytes')}"
        )
    grid = tiff.open_grid(tiff.UrlSource(url))
    record = {"file": url.rsplit("/", 1)[-1], "bytes": total, "read": "by tile, as needed"}
    return Region("lola-spole-10m", "LDEM_83S_10MPP_ADJ", grid, lambda: (grid, record))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def candidates(regions: list[Region], fallback: Region, lat_deg: float, lon_deg: float) -> list[tuple[Region, float]]:
    """Every source and half-width worth trying around a site, finest first.

    An Artemis model's footprint is not a full rectangle, so a square that fits its bounds can still reach cells with
    no data: each region is tried at the widest square its bounds allow, then smaller, down to MIN_HALF_M, before
    the 10 m terrain.
    """
    xa, ya = polar_xy(np.array(lat_deg), np.array(lon_deg))
    x, y = float(xa), float(ya)
    out: list[tuple[Region, float]] = []
    for region in sorted(regions, key=lambda r: -r.room(x, y)):
        half = min(region.room(x, y), ARTEMIS_HALF_M)
        while half >= MIN_HALF_M:
            out.append((region, half))
            half *= 0.75
    room = fallback.room(x, y)
    if room >= MIN_HALF_M:
        out.append((fallback, min(room, FALLBACK_HALF_M)))
    return out


def cut(region: Region, lat_deg: float, lon_deg: float, half_m: float, px: int = PATCH_PX) -> tuple[np.ndarray, dict]:
    """Heights on a latitude-longitude grid `px` on a side, square on the ground, sampled bilinearly from the source."""
    half_lat = half_m / (MOON_RADIUS_M * DEG)
    half_lon = half_m / (MOON_RADIUS_M * np.cos(lat_deg * DEG) * DEG)
    lats = lat_deg + half_lat - (np.arange(px) + 0.5) / px * 2 * half_lat
    lons = lon_deg - half_lon + (np.arange(px) + 0.5) / px * 2 * half_lon
    x, y = polar_xy(lats[:, None], lons[None, :])
    col, row = region.grid.cell_of(x, y)
    pad = 2
    c0, c1 = int(np.floor(col.min())) - pad, int(np.ceil(col.max())) + pad + 1
    r0, r1 = int(np.floor(row.min())) - pad, int(np.ceil(row.max())) + pad + 1
    window = tiff.read_window(region.grid, c0, r0, c1, r1)
    fc, fr = col - c0, row - r0
    ic = np.clip(np.floor(fc).astype(int), 0, window.shape[1] - 2)
    ir = np.clip(np.floor(fr).astype(int), 0, window.shape[0] - 2)
    ac, ar = fc - ic, fr - ir
    heights = (window[ir, ic] * (1 - ac) + window[ir, ic + 1] * ac) * (1 - ar) + (
        window[ir + 1, ic] * (1 - ac) + window[ir + 1, ic + 1] * ac
    ) * ar
    meta = {
        "lat": round(lat_deg, 4),
        "lon": round(lon_deg, 4),
        "half": float(half_lat),
        "lonHalf": float(half_lon),
        # What the patch resolves: the source's cell, or the patch's own spacing where that is coarser.
        "pixM": round(max(region.pixel_m, 2 * half_m / px), 2),
        "src": region.dataset_id,
    }
    return heights, meta


def encode(heights_m: np.ndarray) -> np.ndarray:
    """Metres as a 16-bit number in red (high byte) and green (low byte), with 32768 as zero; blue unused."""
    value = np.clip(np.rint(heights_m) + HEIGHT_OFFSET_M, 0, 65535).astype(np.uint32)
    red = (value >> 8).astype(np.uint8)
    green = (value & 255).astype(np.uint8)
    return np.stack([red, green, np.zeros_like(red)], axis=-1)


def missions() -> list[dict]:
    data = json.loads(MISSIONS_PATH.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else data["missions"]


def demo_sites() -> dict:
    """The demo's entries, each told its resolution so the camera's zoom limit applies to them too."""
    sites = json.loads(DEMO_SITES_PATH.read_text(encoding="utf-8")) if DEMO_SITES_PATH.exists() else {}
    for key, entry in sites.items():
        entry.setdefault("pixM", DEMO_PIX_M.get(key.split("_", 1)[0]))
    return sites


def build() -> dict:
    regions = artemis_regions()
    fallback = fallback_region()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sites = demo_sites()
    made, skipped = [], []
    for m in missions():
        lat, lon = m.get("lat"), m.get("lon")
        if str(m.get("b", "")).lower() != "moon" or lat is None or lon is None or lat > SOUTH_LIMIT_DEG:
            continue
        key = f"moon_{m.get('patch') or m['id']}"
        found = None
        for region, half_m in candidates(regions, fallback, float(lat), float(lon)):
            heights, meta = cut(region, float(lat), float(lon), half_m)
            if not np.isnan(heights).any():
                found = region, half_m, heights, meta
                break
        if found is None:
            skipped.append({"mission": m["id"], "why": "no source has data all around the site"})
            continue
        region, half_m, heights, meta = found
        png = write_png_rgb(encode(heights))
        (OUT_DIR / f"{key}.png").write_bytes(png)
        sites[key] = {"min": float(heights.min()), "max": float(heights.max()), **meta}
        # A check against a second NASA product: the 10 m terrain's height at the site, beside the patch's own.
        # The Artemis models are a separate shape-from-shading solution, so the two agreeing is not a given.
        reference, _ = cut(fallback, float(lat), float(lon), 30.0, px=3)
        made.append(
            {
                "mission": m["id"],
                "key": key,
                "source": region.name,
                "halfM": half_m,
                "bytes": len(png),
                "centreM": float(
                    heights[PATCH_PX // 2 - 1 : PATCH_PX // 2 + 1, PATCH_PX // 2 - 1 : PATCH_PX // 2 + 1].mean()
                ),
                "lola10mCentreM": float(reference[1, 1]),
            }
        )
        print(
            f"{key}: {region.name} at {region.pixel_m:g} m, {2 * half_m / 1000:.1f} km across, {len(png) / 1e6:.1f} MB"
        )
    (OUT_DIR / "sites.json").write_text(json.dumps(sites, indent=1) + "\n", encoding="utf-8")
    manifest = {
        "output": "sites.json and one PNG per close-up",
        "derivedBy": (
            "siteline_pipeline.site_patches: bilinear resampling of each source onto a latitude-longitude grid, "
            "nothing else"
        ),
        "patchPx": PATCH_PX,
        "made": made,
        "skipped": skipped,
        "inputs": [r.input for r in [*regions, fallback] if r.input is not None],
        "configs": ["a3clr-sfs-5m.yaml", "lola-spole-10m.yaml"],
        "gitCommit": git_commit(),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    manifest = build()
    print(f"{len(manifest['made'])} close-ups written to {OUT_DIR}; {len(manifest['skipped'])} sites skipped")


if __name__ == "__main__":
    main()
