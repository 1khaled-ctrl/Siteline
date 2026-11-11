import urllib.request
from pathlib import Path

import spiceypy as sp

PIPELINE = Path(__file__).resolve().parents[1]
SPICE_DIR = PIPELINE / "raw" / "spice"
NAIF = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
KERNELS = [
    "lsk/naif0012.tls",
    "pck/pck00011.tpc",
    "pck/gm_de440.tpc",
    "spk/planets/de440s.bsp",
    "pck/moon_pa_de440_200625.bpc",
    "fk/satellites/moon_de440_250416.tf",
    "pck/earth_latest_high_prec.bpc",
]


def ensure_kernels() -> list[Path]:
    SPICE_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for rel in KERNELS:
        path = SPICE_DIR / rel.rsplit("/", 1)[-1]
        if not path.exists():
            part = path.with_name(path.name + ".part")
            urllib.request.urlretrieve(NAIF + rel, part)
            part.replace(path)
        paths.append(path)
    return paths


def load_kernels() -> list[str]:
    sp.kclear()
    names = []
    for path in ensure_kernels():
        sp.furnsh(str(path))
        names.append(path.name)
    return names
