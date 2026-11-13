"""The Mars height map, mosaicked from NASA's MOLA MEGDR tiles at 128 pixels per degree.

The Landfall demo's `mars_height.png` was 1025 x 513 (about 21 km a pixel), resampled from someone else's copy of this
same data. This reads NASA's own product instead: 16 PDS3 tiles covering 88 degrees north to 88 degrees south at
1/128 of a degree (about 463 m at the equator), mirrored in the project's R2 bucket.

The tiles are plain big-endian 16-bit rasters with a detached label, so numpy reads them directly; nothing here needs
GDAL. Every number a tile is placed by comes from its own label, never from an assumption about its name.
"""

import hashlib
import json
import re
import urllib.request
from pathlib import Path

import numpy as np

from . import config
from .kernels import PIPELINE
from .mars_normal import git_commit
from .pngio import write_png_rgb

# The URLs, sizes, licence and citation live in pipeline/configs/mola-megdr-128.yaml, as every fetched input does.
DATASET_ID = "mola-megdr-128"
CONFIG = config.load(DATASET_ID)
BASE_URL = config.text(CONFIG, "baseUrl")
TILES = config.names(CONFIG, "files")
TILE_BYTES = config.number(CONFIG, "tileBytes")
RAW_DIR = PIPELINE / "raw" / "mola" / "megt128"
OUT_PATH = PIPELINE / "out" / "mars" / "mars_height.png"
MANIFEST_PATH = OUT_PATH.with_suffix(".manifest.json")
# The map the web app reads, 16 bits of metres in red and green. Wider than the band the tiles cover, so the grid
# stays a whole globe: 8192 x 4096 keeps a degree of longitude about 23 pixels wide, close to the source's 128 only
# near the pole, and holds the file to a few megabytes.
OUTPUT_SIZE = (8192, 4096)
# MEGDR's 128 pixel-per-degree tiles stop here; the caps beyond come from the coarse map (see `build`).
BAND_LAT_DEG = 88.0
COARSE_PATH = PIPELINE / "raw" / "landfall" / "img" / "mars_height.png"
# What `decode_heights` in mars_normal.py (and the web app's reader) subtracts.
HEIGHT_OFFSET_M = 32768


def label_value(label: str, key: str) -> str:
    """One `KEY = VALUE` from a PDS3 label, without its quotes or unit."""
    match = re.search(rf"^\s*{re.escape(key)}\s*=\s*\"?([^\"\n]+?)\"?\s*(<[^>]+>)?\s*$", label, re.MULTILINE)
    if match is None:
        raise ValueError(f"the label has no {key}")
    return match.group(1).strip()


class Tile:
    """One MEGDR tile: its heights, and where its first sample sits on the global grid."""

    def __init__(self, name: str, img: Path, label_text: str) -> None:
        self.name = name
        kind = (label_value(label_text, "SAMPLE_TYPE"), label_value(label_text, "SAMPLE_BITS"))
        if kind != ("MSB_INTEGER", "16"):
            raise ValueError(f"{name}: expected big-endian 16-bit samples, the label says {kind}")
        self.rows = int(label_value(label_text, "LINES"))
        self.cols = int(label_value(label_text, "LINE_SAMPLES"))
        self.resolution = float(label_value(label_text, "MAP_RESOLUTION"))
        if img.stat().st_size != self.rows * self.cols * 2:
            raise ValueError(f"{name}: {img.stat().st_size} bytes is not {self.rows} x {self.cols} samples")
        # The label places the tile by where the projection's origin falls in it, in pixels from its first sample.
        self.line_offset = float(label_value(label_text, "LINE_PROJECTION_OFFSET"))
        self.sample_offset = float(label_value(label_text, "SAMPLE_PROJECTION_OFFSET"))
        self.centre_lon = float(label_value(label_text, "CENTER_LONGITUDE"))
        self.north_lat = float(label_value(label_text, "MAXIMUM_LATITUDE"))
        self.west_lon = float(label_value(label_text, "WESTERNMOST_LONGITUDE"))
        self.heights = np.fromfile(img, dtype=">i2").reshape(self.rows, self.cols)

    def place(self, grid: np.ndarray, grid_north_lat: float, resolution: float) -> None:
        """Copy this tile onto a global grid whose first row is `grid_north_lat` and whose pixels are 1/resolution."""
        if self.resolution != resolution:
            raise ValueError(f"{self.name}: {self.resolution} pixels a degree, not {resolution}")
        row = round((grid_north_lat - self.north_lat) * resolution)
        col = round((self.west_lon % 360) * resolution)
        grid[row : row + self.rows, col : col + self.cols] = self.heights


def fetch(url: str, into: Path) -> None:
    """Download a file. The bucket's CDN turns away urllib's default name, so the request carries a plain one."""
    request = urllib.request.Request(url, headers={"User-Agent": "siteline-pipeline"})
    with urllib.request.urlopen(request) as response, into.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)


def ensure_tiles() -> list[tuple[Path, Path]]:
    """The 16 tiles and their labels, downloaded to `RAW_DIR` if they are not already there at the right size."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for name in TILES:
        img = RAW_DIR / f"{name}.img"
        label = RAW_DIR / f"{name}.lbl"
        for path, url, size in ((img, f"{BASE_URL}/{name}.img", TILE_BYTES), (label, f"{BASE_URL}/{name}.lbl", None)):
            if path.exists() and (size is None or path.stat().st_size == size):
                continue
            part = path.with_name(path.name + ".part")
            fetch(url, part)
            if size is not None and part.stat().st_size != size:
                got = part.stat().st_size
                part.unlink()
                raise ValueError(f"{path.name}: downloaded {got} bytes, expected {size}")
            part.replace(path)
        files.append((img, label))
    return files


def mosaic(tiles: list[Tile]) -> tuple[np.ndarray, float]:
    """The tiles on one grid of the band they cover, and the resolution they agree on, in pixels a degree."""
    resolution = tiles[0].resolution
    north = max(t.north_lat for t in tiles)
    rows = round(2 * north * resolution)
    cols = round(360 * resolution)
    grid = np.zeros((rows, cols), dtype=np.int16)
    for tile in tiles:
        tile.place(grid, north, resolution)
    return grid, resolution


def resample_band(band: np.ndarray, north_lat: float, width: int, height: int) -> np.ndarray:
    """The band's heights at the centres of a whole-globe width x height image, nearest row and column.

    Rows outside the band keep their nearest row inside it, which only matters for the caps `build` overwrites.
    """
    lat = 90 - (np.arange(height) + 0.5) / height * 180
    lon = (np.arange(width) + 0.5) / width * 360
    rows = np.clip(np.rint((north_lat - lat) * band.shape[0] / (2 * north_lat)).astype(int), 0, band.shape[0] - 1)
    cols = np.clip(np.rint(lon * band.shape[1] / 360).astype(int), 0, band.shape[1] - 1)
    return band[np.ix_(rows, cols)]


def read_coarse_caps(width: int, height: int, north_lat: float) -> np.ndarray | None:
    """The old coarse map's heights wherever the MEGDR band does not reach, or None if that map is not here."""
    if not COARSE_PATH.exists():
        return None
    from .pngio import read_png_rgb

    rgb = read_png_rgb(COARSE_PATH.read_bytes())
    coarse = rgb[..., 0].astype(np.float64) * 256 + rgb[..., 1] - HEIGHT_OFFSET_M
    rows, cols = coarse.shape
    lat = 90 - (np.arange(height) + 0.5) / height * 180
    lon = (np.arange(width) + 0.5) / width * 360
    r = np.clip(np.rint((90 - lat) / 180 * (rows - 1)).astype(int), 0, rows - 1)
    c = np.clip(np.rint(lon / 360 * (cols - 1)).astype(int), 0, cols - 1)
    out = coarse[np.ix_(r, c)]
    out[np.abs(lat) <= north_lat, :] = 0
    return out


def encode(heights_m: np.ndarray) -> np.ndarray:
    """Metres above the areoid as a 16-bit number in red (high byte) and green (low byte), with 32768 as zero."""
    value = np.clip(np.rint(heights_m) + HEIGHT_OFFSET_M, 0, 65535).astype(np.uint32)
    red = (value >> 8).astype(np.uint8)
    green = (value & 255).astype(np.uint8)
    return np.stack([red, green, np.zeros_like(red)], axis=-1)


def build() -> dict:
    files = ensure_tiles()
    tiles = [Tile(img.stem, img, label.read_text()) for img, label in files]
    band, resolution = mosaic(tiles)
    width, height = OUTPUT_SIZE
    north = max(t.north_lat for t in tiles)
    heights = resample_band(band, north, width, height).astype(np.float64)
    caps = read_coarse_caps(width, height, north)
    lat = 90 - (np.arange(height) + 0.5) / height * 180
    outside = np.abs(lat) > north
    if caps is not None:
        heights[outside, :] = caps[outside, :]
    png = write_png_rgb(encode(heights))
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_bytes(png)
    manifest = {
        "output": OUT_PATH.name,
        "outputSha256": hashlib.sha256(png).hexdigest(),
        "derivedBy": (
            "siteline_pipeline.mars_height: NASA's MEGDR tiles placed on one grid by their labels and resampled, "
            "nothing else"
        ),
        "datasetId": DATASET_ID,
        "config": config.path_of(DATASET_ID).name,
        "licence": config.text(CONFIG, "licence"),
        "citation": config.text(CONFIG, "citation"),
        "gitCommit": git_commit(),
        "resolutionPixelsPerDegree": resolution,
        "bandLatitudeDeg": north,
        "capsFrom": "mola-mars-relief" if caps is not None else None,
        "outputSize": list(OUTPUT_SIZE),
        "inputs": [{"file": img.name, "sha256": hashlib.sha256(img.read_bytes()).hexdigest()} for img, _ in files],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1) + "\n")
    return manifest


def main() -> None:
    manifest = build()
    size_mb = OUT_PATH.stat().st_size / 1e6
    print(f"mars height map: {size_mb:.1f} MB -> {OUT_PATH} ({manifest['resolutionPixelsPerDegree']:g} px/degree)")


if __name__ == "__main__":
    main()
