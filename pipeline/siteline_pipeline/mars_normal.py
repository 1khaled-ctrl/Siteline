"""The slope map the Mars globe is shaded with, computed from the MOLA height map and nothing else.

For each point it works out how steeply the ground tilts east and north, from the heights of the points around it, and
stores the tilt of the surface normal in the red and green channels the way the globe's shader reads them. The
height map is `mars_height.png` (NASA MGS MOLA MEGDR, dataset `mola-mars-relief`): the mosaic `mars_height.py`
builds from NASA's own tiles where that has been run, else the Landfall demo's coarse copy.
"""

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np

from .kernels import PIPELINE
from .pngio import read_png_rgb, write_png_rgb

# The sphere the globe is drawn on (IAU volumetric mean radius), so slopes are metres of height per metre of ground.
MARS_RADIUS_M = 3_389_500.0
# East-west distances shrink to nothing at the poles; keep them from dividing by zero. This only matters within
# 3° of a pole, where the map has no heights finer than a few kilometres anyway.
MIN_COS_LAT = 0.05
# The app downloads this map; at 2048 wide it stays a few megabytes, and its source is now 463 m anyway.
OUTPUT_SIZE = (2048, 1024)
# NASA's own MEGDR mosaic, built by `mars_height.py`; the Landfall demo's coarse map until that has been run.
FINE_HEIGHT_PATH = PIPELINE / "out" / "mars" / "mars_height.png"
COARSE_HEIGHT_PATH = PIPELINE / "raw" / "landfall" / "img" / "mars_height.png"


def height_path() -> Path:
    """The finest height map that has been built."""
    return FINE_HEIGHT_PATH if FINE_HEIGHT_PATH.exists() else COARSE_HEIGHT_PATH


OUT_PATH = PIPELINE / "out" / "mars" / "mars_normal.png"
MANIFEST_PATH = OUT_PATH.with_suffix(".manifest.json")


def decode_heights(rgb: np.ndarray) -> np.ndarray:
    """Metres above the areoid: a 16-bit number in red (high byte) and green (low byte), with 32768 as zero."""
    return rgb[..., 0].astype(np.float64) * 256 + rgb[..., 1] - 32768


def tilt(heights_m: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """East, north and up parts of the unit surface normal at every point of an equirectangular height grid.

    The grid has its corner points on the map's edges: longitude -180° to 180° in the columns (the last column repeats
    the first) and latitude 90° to -90° in the rows. A surface rising to the east tilts its normal west.
    """
    rows, cols = heights_m.shape
    d_lat = np.pi / (rows - 1)
    d_lon = 2 * np.pi / (cols - 1)
    lat = np.pi / 2 - np.arange(rows) * d_lat
    north_m = MARS_RADIUS_M * d_lat
    east_m = MARS_RADIUS_M * np.maximum(np.cos(lat), MIN_COS_LAT) * d_lon
    ring = heights_m[:, :-1]
    g_east_ring = (np.roll(ring, -1, axis=1) - np.roll(ring, 1, axis=1)) / (2 * east_m[:, None])
    g_east = np.concatenate([g_east_ring, g_east_ring[:, :1]], axis=1)
    # Rows run from north to south, so the northward slope is the negative of the change per row.
    g_north = -np.gradient(heights_m, north_m, axis=0)
    norm = np.sqrt(1 + g_east**2 + g_north**2)
    return -g_east / norm, -g_north / norm, 1 / norm


def resample(field: np.ndarray, width: int, height: int) -> np.ndarray:
    """Bilinear values of a node-registered grid at the centres of a width × height image of the whole map."""
    rows, cols = field.shape
    u = (np.arange(width) + 0.5) / width * (cols - 1)
    v = (np.arange(height) + 0.5) / height * (rows - 1)
    c0 = np.floor(u).astype(int)
    r0 = np.floor(v).astype(int)
    fc = (u - c0)[None, :]
    fr = (v - r0)[:, None]
    top = field[np.ix_(r0, c0)] * (1 - fc) + field[np.ix_(r0, c0 + 1)] * fc
    bottom = field[np.ix_(r0 + 1, c0)] * (1 - fc) + field[np.ix_(r0 + 1, c0 + 1)] * fc
    return top * (1 - fr) + bottom * fr


def encode(n_east: np.ndarray, n_north: np.ndarray, n_up: np.ndarray) -> np.ndarray:
    """Red and green hold each tilt as sign · sqrt(|tilt|), which keeps fine detail in gentle slopes; blue holds up."""

    def squash(n: np.ndarray) -> np.ndarray:
        return np.rint((np.sign(n) * np.sqrt(np.abs(n)) + 1) / 2 * 255)

    return np.stack([squash(n_east), squash(n_north), np.rint(n_up * 255)], axis=-1).astype(np.uint8)


def decode_tilt(channel: np.ndarray) -> np.ndarray:
    """What the globe's shader does with a red or green value: back to a tilt between -1 and 1."""
    s = channel.astype(np.float64) / 255 * 2 - 1
    return np.sign(s) * s * s


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PIPELINE, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def build() -> dict:
    source = height_path()
    data = source.read_bytes()
    heights = decode_heights(read_png_rgb(data))
    width, height = OUTPUT_SIZE
    fields = [resample(f, width, height) for f in tilt(heights)]
    png = write_png_rgb(encode(*fields))
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_bytes(png)
    manifest = {
        "output": OUT_PATH.name,
        "outputSha256": hashlib.sha256(png).hexdigest(),
        "derivedBy": "siteline_pipeline.mars_normal: height-to-normal conversion of the input, nothing else",
        "input": {
            "file": source.name,
            "path": str(source.relative_to(PIPELINE)),
            "sha256": hashlib.sha256(data).hexdigest(),
            "datasetId": "mola-mars-relief",
        },
        "marsRadiusM": MARS_RADIUS_M,
        "minCosLat": MIN_COS_LAT,
        "outputSize": list(OUTPUT_SIZE),
        "gitCommit": git_commit(),
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=1) + "\n")
    return manifest


def main() -> None:
    manifest = build()
    print(
        f"mars normal map: {OUT_PATH.stat().st_size / 1e6:.1f} MB -> {OUT_PATH} (input sha256 {manifest['input']['sha256'][:12]})"
    )


if __name__ == "__main__":
    main()
