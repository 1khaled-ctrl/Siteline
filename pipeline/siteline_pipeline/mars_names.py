"""Mars feature names, read from the shapefile that USGS publishes for the IAU Gazetteer of Planetary Nomenclature."""

import hashlib
import json
import re
import struct
import urllib.request
import zipfile
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path

from .kernels import PIPELINE

URL = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MARS_nomenclature_center_pts.zip"
RAW_PATH = PIPELINE / "raw" / "usgs" / "MARS_nomenclature_center_pts.zip"
OUT_PATH = PIPELINE / "out" / "names" / "mars_names.json"
FORMAT = "siteline-mars-names-1"
CITATION = (
    'International Astronomical Union Working Group for Planetary System Nomenclature. "Gazetteer of Planetary '
    'Nomenclature." (access date). http://planetarynames.wr.usgs.gov/.'
)
ADOPTED = "Adopted by IAU"


def ensure_zip() -> Path:
    if not RAW_PATH.exists():
        RAW_PATH.parent.mkdir(parents=True, exist_ok=True)
        part = RAW_PATH.with_name(RAW_PATH.name + ".part")
        urllib.request.urlretrieve(URL, part)
        part.replace(RAW_PATH)
    return RAW_PATH


def read_dbf(data: bytes) -> list[dict[str, str]]:
    """Every record of a dBase table as text, keyed by field name (the shapefile says its text is UTF-8)."""
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields: list[tuple[str, int]] = []
    at = 32
    while data[at] != 0x0D:
        fields.append((data[at : at + 11].split(b"\0")[0].decode("ascii"), data[at + 16]))
        at += 32
    rows = []
    for i in range(count):
        record = data[header_len + i * record_len : header_len + (i + 1) * record_len]
        if record[:1] == b"*":  # deleted
            continue
        row = {}
        pos = 1
        for name, length in fields:
            row[name] = record[pos : pos + length].decode("utf-8").strip()
            pos += length
        rows.append(row)
    return rows


def wrap_lon_deg(lon_deg: float) -> float:
    """0 to 360 east becomes -180 to 180 east."""
    return lon_deg - 360 if lon_deg > 180 else lon_deg


def build_features(rows: list[dict[str, str]]) -> list[list[str | float]]:
    """[name, latDeg, lonDeg, diameterKm, IAU feature type], largest first; only names the IAU has adopted, once each."""
    features: list[list[str | float]] = []
    for row in rows:
        if row["approval"] != ADOPTED:
            continue
        features.append(
            [
                row["name"],
                round(float(row["center_lat"]), 4),
                round(wrap_lon_deg(float(row["center_lon"])), 4),
                round(float(row["diameter"]), 2),
                # The download writes "Crater, craters": the descriptor term, then its plural.
                row["type"].split(",")[0].strip(),
            ]
        )
    # USGS lists a few features twice with identical values (Bohar, for one); keep the first.
    unique = {tuple(f): f for f in reversed(features)}
    features = list(reversed(unique.values()))
    features.sort(key=lambda f: -float(f[3]))
    return features


def use_constraint(zip_file: zipfile.ZipFile) -> str:
    """What the download's own metadata says about reuse; it must say public domain or we stop."""
    name = next(n for n in zip_file.namelist() if n.endswith(".xml"))
    match = re.search(r"<useconst>(.*?)</useconst>", zip_file.read(name).decode("utf-8", "replace"), re.DOTALL)
    text = match.group(1).strip() if match else ""
    if "public domain" not in text.lower():
        raise SystemExit(f"the USGS metadata no longer says public domain (it says {text!r}); check the licence first")
    return text


def build() -> dict:
    path = ensure_zip()
    data = path.read_bytes()
    with zipfile.ZipFile(BytesIO(data)) as zf:
        constraint = use_constraint(zf)
        rows = read_dbf(zf.read(next(n for n in zf.namelist() if n.endswith(".dbf"))))
    features = build_features(rows)
    result = {
        "format": FORMAT,
        "source": {
            "name": "IAU Gazetteer of Planetary Nomenclature, Mars, approved features (USGS Astrogeology Science Center)",
            "url": URL,
            "accessedUtc": datetime.now(UTC).strftime("%Y-%m-%d"),
            "sha256": hashlib.sha256(data).hexdigest(),
            "useConstraints": constraint,
            "citation": CITATION,
            "coordinates": "planetocentric latitude, east longitude (-180 to 180)",
        },
        "columns": ["name", "latDeg", "lonDeg", "diameterKm", "type"],
        "features": features,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return result


def main() -> None:
    result = build()
    size_kb = OUT_PATH.stat().st_size / 1e3
    print(f"mars names: {len(result['features'])} adopted features, {size_kb:.0f} kB -> {OUT_PATH}")


if __name__ == "__main__":
    main()
