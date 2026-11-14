"""Writes pgda69_points.json: NASA's long-term sunlight (PGDA product 69, Mazarico et al. 2011) at the three points
`horizon30m.validation.test.ts` checks, read from NASA's own 60 m file.

Run from the repository root: `uv run --no-project --with numpy python tests/reference/pgda69_points.py`. It downloads
the file once into pipeline/raw/illumination/ and refuses any bytes but NASA's (the project's R2 copy of this file is
corrupt; see CREDITS.md, pgda-69-illumination).
"""

import hashlib
import json
import math
import pathlib
import urllib.request

import numpy as np

URL = "http://imbrium.mit.edu/EXTRAS/ILLUMINATION/IMG/AVGVISIB_85S_060M_201608.IMG"
SHA256 = "82dadf321dee28f1947c1fed81858d4cf50fe8eb2aa405aae114e8ab21c1efe1"
ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "pipeline" / "raw" / "illumination" / "avgvisib_85s_060m_201608.img"
OUT = pathlib.Path(__file__).with_name("pgda69_points.json")
# From the file's PDS3 label: 5058 x 5058 little-endian int16, 60 m, projection offsets 2528.5, DN x 0.00004.
N, PIX_M, OFFSET, SCALE = 5058, 60.0, 2528.5, 0.00004
MOON_RADIUS_M = 1_737_400.0
POINTS = [
    ("A, Shackleton ridge", -89.68, -166.0),
    ("B, peak near the ridge", -89.44, -141.8),
    ("D, near Shackleton rim", -88.79, 124.5),
]


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    if not RAW.exists() or sha256(RAW) != SHA256:
        RAW.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            URL, headers={"User-Agent": "siteline-pipeline"}
        )
        with urllib.request.urlopen(request) as response:
            RAW.write_bytes(response.read())
    if sha256(RAW) != SHA256:
        raise SystemExit(f"{RAW.name} is not NASA's file")
    sun = np.fromfile(RAW, dtype="<i2").reshape(N, N).astype(np.float64) * SCALE * 100
    rows = []
    for name, lat_deg, lon_deg in POINTS:
        lat, lon = math.radians(lat_deg), math.radians(lon_deg)
        k = 2 * MOON_RADIUS_M / (1 - math.sin(lat))
        x, y = k * math.cos(lat) * math.sin(lon), k * math.cos(lat) * math.cos(lon)
        col, row = round(OFFSET + x / PIX_M - 0.5), round(OFFSET - y / PIX_M - 0.5)
        window = sun[row - 1 : row + 2, col - 1 : col + 2]
        rows.append(
            {
                "point": name,
                "latDeg": lat_deg,
                "lonDeg": lon_deg,
                "cellPct": round(float(sun[row, col]), 2),
                "windowMinPct": round(float(window.min()), 2),
                "windowMaxPct": round(float(window.max()), 2),
            }
        )
    OUT.write_text(
        json.dumps(
            {
                "source": URL,
                "sha256": SHA256,
                "datasetId": "pgda-69-illumination",
                "rows": rows,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        f"wrote {OUT.name}: " + ", ".join(f"{r['point']} {r['cellPct']}%" for r in rows)
    )


if __name__ == "__main__":
    main()
