"""The south pole's long-term sunlight, Earth view and permanent shadow, from NASA's PGDA product 69.

The app's "long-term" readings and its sunlight, Earth-view and never-lit layers came from a 186 x 186 grid at 2.4 km
that the Landfall demo derived itself. This reads NASA's own maps instead (dataset pgda-69-illumination): average Sun
and Earth visibility and the permanently shadowed regions, 5058 x 5058 at 60 m, and writes them in the layout the
app's `mapsFromBytes` already reads, plus a fourth plane: the distance from each cell to the nearest permanently
shadowed cell. That distance is a proxy and is named as one: a cold trap is where ice can persist, not where ice is
known to be.

The maps are averaged down 6 to 1, to 360 m, so the file stays a few megabytes; the app reads it whole. Each image
is read by numpy from its own label's numbers (size, sample type, scaling); nothing here needs GDAL.
"""

import base64
import hashlib
import json
import urllib.request
from pathlib import Path

import numpy as np

from . import config
from .kernels import PIPELINE
from .mars_height import label_value
from .mars_normal import git_commit

DATASET_ID = "pgda-69-illumination"
RAW_DIR = PIPELINE / "raw" / "illumination"
OUT_PATH = PIPELINE / "out" / "illumination" / "maps.json"
MANIFEST_PATH = OUT_PATH.with_suffix(".manifest.json")
# Cells averaged into one, each way: 5058 / 6 = 843, an odd number, so the middle cell sits on the pole as the
# app's node-registered reader expects.
BLOCK = 6
# The distance plane's unit: a quarter of a kilometre, so 255 reaches 63.75 km; anything further reads as that.
DISTANCE_UNIT_KM = 0.25
USER_AGENT = "siteline-pipeline"


def fetch(url: str, into: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request) as response, into.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)


def ensure_files() -> list[tuple[Path, Path]]:
    """The three images and their labels, each image checked against the sha256 of NASA's own file."""
    cfg = config.load(DATASET_ID)
    r2 = config.text(cfg, "baseUrl")
    nasa = config.text(cfg, "nasaUrl")
    size = config.number(cfg, "bytes")
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for line in config.names(cfg, "files"):
        name, digest, host = line.split()
        img, label = RAW_DIR / f"{name}.img", RAW_DIR / f"{name}.lbl"
        if not label.exists():
            fetch(f"{r2}/{name}.lbl", label)
        if not (img.exists() and img.stat().st_size == size and sha256_of(img) == digest):
            part = img.with_name(img.name + ".part")
            fetch(f"{nasa}/{name.upper()}.IMG" if host == "nasa" else f"{r2}/{name}.img", part)
            got = sha256_of(part)
            if got != digest:
                part.unlink()
                raise ValueError(f"{img.name}: sha256 {got[:12]} is not NASA's {digest[:12]}")
            part.replace(img)
        files.append((img, label))
    return files


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


class Map:
    """One PDS3 image of the product, scaled to its physical values by its own label."""

    def __init__(self, img: Path, label_text: str) -> None:
        self.name = img.stem
        kind = (label_value(label_text, "SAMPLE_TYPE"), label_value(label_text, "SAMPLE_BITS"))
        if kind != ("LSB_INTEGER", "16"):
            raise ValueError(f"{self.name}: expected little-endian 16-bit samples, the label says {kind}")
        self.rows = int(label_value(label_text, "LINES"))
        self.cols = int(label_value(label_text, "LINE_SAMPLES"))
        self.pixel_m = float(label_value(label_text, "MAP_SCALE"))
        self.scale = float(label_value(label_text, "SCALING_FACTOR"))
        self.offset = float(label_value(label_text, "OFFSET"))
        if img.stat().st_size != self.rows * self.cols * 2:
            raise ValueError(f"{self.name}: {img.stat().st_size} bytes is not {self.rows} x {self.cols} samples")
        raw = np.fromfile(img, dtype="<i2").reshape(self.rows, self.cols)
        # A label that states its range is held to it: a file stitched from others fails here, not in the app.
        low, high = label_number(label_text, "DERIVED_MINIMUM"), label_number(label_text, "DERIVED_MAXIMUM")
        if low is not None and high is not None and (raw.min() < low or raw.max() > high):
            raise ValueError(f"{self.name}: samples {raw.min()}..{raw.max()} outside its label's {low:g}..{high:g}")
        self.values = raw.astype(np.float32) * self.scale + self.offset


def label_number(label_text: str, key: str) -> float | None:
    """A number from the label, or None if the label does not give one."""
    try:
        return float(label_value(label_text, key))
    except ValueError:
        return None


def block_mean(values: np.ndarray, block: int) -> np.ndarray:
    rows, cols = values.shape
    if rows % block or cols % block:
        raise ValueError(f"{rows} x {cols} does not divide into blocks of {block}")
    return values.reshape(rows // block, block, cols // block, block).mean(axis=(1, 3))


def distance_transform(mask: np.ndarray, cell_m: float) -> np.ndarray:
    """Exact Euclidean distance in metres from every cell to the nearest cell where `mask` is true.

    Felzenszwalb and Huttenlocher's lower-envelope transform, once along rows and once along columns.
    """
    inf = float(np.finfo(np.float64).max / 4)
    f = np.where(mask, 0.0, inf)

    def transform_1d(row: np.ndarray) -> np.ndarray:
        n = row.size
        v = np.zeros(n, dtype=int)
        z = np.full(n + 1, 0.0)
        z[0], z[1] = -np.inf, np.inf
        k = 0
        for q in range(1, n):
            s = ((row[q] + q * q) - (row[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
            while s <= z[k]:
                k -= 1
                s = ((row[q] + q * q) - (row[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
            k += 1
            v[k] = q
            z[k] = s
            z[k + 1] = np.inf
        out = np.empty(n)
        k = 0
        for q in range(n):
            while z[k + 1] < q:
                k += 1
            out[q] = (q - v[k]) ** 2 + row[v[k]]
        return out

    d = np.apply_along_axis(transform_1d, 1, f)
    d = np.apply_along_axis(transform_1d, 0, d)
    return np.sqrt(d) * cell_m


def build() -> dict:
    files = ensure_files()
    maps = {img.stem: Map(img, label.read_text()) for img, label in files}
    sun = maps["avgvisib_85s_060m_201608"]
    earth = maps["avgvisib_85s_060m_201608_earth"]
    shadow = maps["lpsr_85s_060m_201608"]
    for m in (earth, shadow):
        if (m.rows, m.cols, m.pixel_m) != (sun.rows, sun.cols, sun.pixel_m):
            raise ValueError(f"{m.name} is not on {sun.name}'s grid")
    n = sun.rows // BLOCK
    pixel_m = sun.pixel_m * BLOCK
    sun_pct = block_mean(sun.values, BLOCK) * 100
    earth_pct = block_mean(earth.values, BLOCK) * 100
    # A cell is in permanent shadow when most of the 60 m cells inside it are.
    shadowed = block_mean(shadow.values, BLOCK) > 0.5
    distance_km = distance_transform(shadowed, pixel_m) / 1000
    planes = [
        np.clip(np.rint(sun_pct * 2), 0, 255).astype(np.uint8),
        np.clip(np.rint(earth_pct * 2), 0, 255).astype(np.uint8),
        shadowed.astype(np.uint8),
        np.clip(np.rint(distance_km / DISTANCE_UNIT_KM), 0, 255).astype(np.uint8),
    ]
    payload = b"".join(p.tobytes() for p in planes)
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    cfg = config.load(DATASET_ID)
    OUT_PATH.write_text(
        json.dumps(
            {
                "what": (
                    f"{n}x{n} uint8 x4: sunlight % x2, Earth-in-view % x2, permanent-shadow flag, distance to the "
                    f"nearest permanent shadow in quarter kilometres; {pixel_m:g} m grid averaged from NASA's 60 m "
                    "PGDA product 69 (2016-08)"
                ),
                "n": n,
                "pixM": pixel_m,
                "planes": 4,
                "distanceUnitKm": DISTANCE_UNIT_KM,
                "datasetId": DATASET_ID,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
                "b64": base64.b64encode(payload).decode("ascii"),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    manifest = {
        "output": OUT_PATH.name,
        "derivedBy": (
            "siteline_pipeline.illumination: NASA's maps averaged 6 to 1, the shadow flag by majority, and a "
            "distance-to-shadow plane computed from it; nothing else"
        ),
        "datasetId": DATASET_ID,
        "config": config.path_of(DATASET_ID).name,
        "licence": config.text(cfg, "licence"),
        "citation": config.text(cfg, "citation"),
        "n": n,
        "pixelM": pixel_m,
        "inputs": [
            {"file": img.name, "sha256": hashlib.sha256(img.read_bytes()).hexdigest(), "pixelM": maps[img.stem].pixel_m}
            for img, _ in files
        ],
        "shadowedShare": float(shadowed.mean()),
        "gitCommit": git_commit(),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    manifest = build()
    print(
        f"illumination maps: {OUT_PATH.stat().st_size / 1e6:.1f} MB -> {OUT_PATH} ({manifest['n']} x {manifest['n']} at {manifest['pixelM']:g} m)"
    )


if __name__ == "__main__":
    main()
