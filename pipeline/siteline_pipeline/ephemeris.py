"""Hourly Sun and Earth positions relative to the Moon's centre in MOON_ME, and golden values from SPICE."""

import hashlib
import json
import math
import struct
from datetime import UTC, datetime

import numpy as np
import spiceypy as sp

from .kernels import PIPELINE, load_kernels

REPO = PIPELINE.parent
FRAME = "MOON_ME"
ABCORR = "LT+S"
TABLE_PATH = PIPELINE / "out" / "ephemeris" / "moon_sun_earth.bin"
GOLDEN_PATH = REPO / "tests" / "reference" / "sun_earth_golden.json"
START_UTC = "2026-01-01T00:00:00Z"
END_UTC = "2036-01-01T00:00:00Z"
HOUR_MS = 3_600_000
MOON_RADIUS_KM = 1737.4


def utc_ms(iso: str) -> int:
    return int(datetime.fromisoformat(iso).timestamp() * 1000)


def et_at(t_utc_ms: int) -> float:
    stamp = datetime.fromtimestamp(t_utc_ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")
    return sp.str2et(stamp)


def build_table(kernels: list[str]) -> dict:
    t0 = utc_ms(START_UTC)
    count = (utc_ms(END_UTC) - t0) // HOUR_MS + 1
    ets = [et_at(t0 + k * HOUR_MS) for k in range(count)]
    sun, _ = sp.spkpos("SUN", ets, FRAME, ABCORR, "MOON")
    earth, _ = sp.spkpos("EARTH", ets, FRAME, ABCORR, "MOON")
    data = np.hstack([np.asarray(sun), np.asarray(earth)]).astype("<f4").tobytes()
    header = {
        "format": "siteline-ephem-1",
        "frame": FRAME,
        "centre": "MOON",
        "abcorr": ABCORR,
        "bodies": ["SUN", "EARTH"],
        "units": "km",
        "startUtc": START_UTC,
        "startUtcMs": t0,
        "stepMs": HOUR_MS,
        "count": count,
        "kernels": kernels,
        "dataSha256": hashlib.sha256(data).hexdigest(),
    }
    head = json.dumps(header, separators=(",", ":")).encode()
    pad = b" " * ((-(4 + len(head))) % 4)
    TABLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TABLE_PATH.write_bytes(struct.pack("<I", len(head)) + head + pad + data)
    return header


def local_frame(lat_deg: float, lon_deg: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    phi = math.radians(lat_deg)
    lam = math.radians(0.0 if abs(lat_deg) == 90 else lon_deg)
    u = np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])
    e = np.array([-math.sin(lam), math.cos(lam), 0.0])
    return u, e, np.cross(u, e)


def build_golden(kernels: list[str], n_sites: int = 25, n_dates: int = 40, seed: int = 2026) -> int:
    rng = np.random.default_rng(seed)
    lats = np.concatenate([[-90.0], rng.uniform(-90, -80, n_sites - 1)])
    lons = np.concatenate([[0.0], rng.uniform(-180, 180, n_sites - 1)])
    heights = rng.uniform(-4000, 4000, n_sites)
    times = np.sort(rng.integers(utc_ms(START_UTC), utc_ms("2035-12-31T00:00:00Z"), n_dates)) // 1000 * 1000
    cases = []
    for lat, lon, h in zip(lats, lons, heights, strict=True):
        u, e, n = local_frame(float(lat), float(lon))
        observer = (MOON_RADIUS_KM + h / 1000) * u
        for t in times:
            case = {"latDeg": float(lat), "lonDeg": float(lon), "heightM": float(h), "tUtcMs": int(t)}
            for body in ("SUN", "EARTH"):
                state, _ = sp.spkcpo(body, et_at(int(t)), FRAME, "OBSERVER", ABCORR, observer, "MOON", FRAME)
                s = np.asarray(state[:3]) / np.linalg.norm(state[:3])
                az = math.degrees(math.atan2(s @ e, s @ n)) % 360
                case[body.lower()] = {"elevDeg": math.degrees(math.asin(s @ u)), "azDeg": az}
            cases.append(case)
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    meta = {"frame": FRAME, "abcorr": ABCORR, "observer": "site (spkcpo)", "kernels": kernels, "seed": seed}
    GOLDEN_PATH.write_text(json.dumps({"generated": meta, "cases": cases}, indent=1) + "\n")
    return len(cases)


# ---- Solar-system overview: the eight planets (Sun-centred) and the Moon (Earth-centred) in ECLIPJ2000 ----
PLANETS_PATH = TABLE_PATH.with_name("planets.bin")
PLANETS_GOLDEN_PATH = REPO / "tests" / "reference" / "planets_golden.json"
EARTH_SUN_GOLDEN_PATH = REPO / "tests" / "reference" / "earth_sun_golden.json"
# earth_latest_high_prec.bpc measures the Earth's rotation up to about now, so the golden stays inside 2026.
EARTH_FIXED_START_UTC = "2026-01-05T00:00:00Z"
EARTH_FIXED_END_UTC = "2026-10-15T00:00:00Z"
PLANETS_FRAME = "ECLIPJ2000"
# de440s has Mercury, Venus and Earth as bodies, and Mars and the outer planets only as system barycentres.
PLANET_TARGETS = {
    "mercury": "MERCURY",
    "venus": "VENUS",
    "earth": "EARTH",
    "mars": "MARS BARYCENTER",
    "jupiter": "JUPITER BARYCENTER",
    "saturn": "SATURN BARYCENTER",
    "uranus": "URANUS BARYCENTER",
    "neptune": "NEPTUNE BARYCENTER",
}
PLANET_PERIODS_DAYS = [87.97, 224.70, 365.26, 686.98, 4332.59, 10759.22, 30688.5, 60182.0]
PLANET_STEP_MS = 12 * HOUR_MS
ORBIT_POINTS = 180
ORBIT_CENTRE_UTC = "2031-01-01T00:00:00Z"


def planet_positions(utc_ms_list: list[int]) -> np.ndarray:
    """Shape (len, 9, 3) in km: eight planets from the Sun, then the Moon from the Earth."""
    ets = [et_at(t) for t in utc_ms_list]
    parts = [np.asarray(sp.spkpos(target, ets, PLANETS_FRAME, "NONE", "SUN")[0]) for target in PLANET_TARGETS.values()]
    parts.append(np.asarray(sp.spkpos("MOON", ets, PLANETS_FRAME, "NONE", "EARTH")[0]))
    return np.stack(parts, axis=1)


def build_planets(kernels: list[str]) -> dict:
    t0 = utc_ms(START_UTC)
    count = (utc_ms(END_UTC) - t0) // PLANET_STEP_MS + 1
    samples = planet_positions([t0 + k * PLANET_STEP_MS for k in range(count)]).astype("<f4")
    # One full orbit of each planet, centred on the middle of the table so Neptune stays inside de440s (to 2150).
    et_mid = et_at(utc_ms(ORBIT_CENTRE_UTC))
    orbits = []
    for target, period in zip(PLANET_TARGETS.values(), PLANET_PERIODS_DAYS, strict=True):
        ets = (et_mid + (np.arange(ORBIT_POINTS) / ORBIT_POINTS - 0.5) * period * 86400).tolist()
        orbits.append(np.asarray(sp.spkpos(target, ets, PLANETS_FRAME, "NONE", "SUN")[0]))
    data = samples.tobytes() + np.stack(orbits).astype("<f4").tobytes()
    header = {
        "format": "siteline-planets-1",
        "frame": PLANETS_FRAME,
        "centre": "SUN (the Moon is relative to the Earth)",
        "abcorr": "NONE",
        "bodies": [*PLANET_TARGETS, "moon"],
        "units": "km",
        "startUtc": START_UTC,
        "startUtcMs": t0,
        "stepMs": PLANET_STEP_MS,
        "count": count,
        "orbitPoints": ORBIT_POINTS,
        "orbitPeriodsDays": PLANET_PERIODS_DAYS,
        "kernels": kernels,
        "dataSha256": hashlib.sha256(data).hexdigest(),
    }
    head = json.dumps(header, separators=(",", ":")).encode()
    pad = b" " * ((-(4 + len(head))) % 4)
    PLANETS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PLANETS_PATH.write_bytes(struct.pack("<I", len(head)) + head + pad + data)
    return header


def build_planets_golden(kernels: list[str], n_dates: int = 40, seed: int = 4242) -> int:
    rng = np.random.default_rng(seed)
    times = np.sort(rng.integers(utc_ms(START_UTC), utc_ms(END_UTC) - HOUR_MS, n_dates)) // 1000 * 1000
    positions = planet_positions([int(t) for t in times])
    names = [*PLANET_TARGETS, "moon"]
    cases = [
        {"tUtcMs": int(t), "positionsKm": {n: [float(v) for v in positions[i, j]] for j, n in enumerate(names)}}
        for i, t in enumerate(times)
    ]
    meta = {"frame": PLANETS_FRAME, "abcorr": "NONE", "targets": PLANET_TARGETS, "kernels": kernels, "seed": seed}
    PLANETS_GOLDEN_PATH.write_text(json.dumps({"generated": meta, "cases": cases}, indent=1) + "\n")
    return len(cases)


def build_earth_sun_golden(kernels: list[str], n_dates: int = 40, seed: int = 77) -> int:
    """Where SPICE puts the Sun overhead on Earth (ITRF93), with the Earth's heliocentric ECLIPJ2000 position."""
    rng = np.random.default_rng(seed)
    times = np.sort(rng.integers(utc_ms(EARTH_FIXED_START_UTC), utc_ms(EARTH_FIXED_END_UTC), n_dates)) // 1000 * 1000
    ets = [et_at(int(t)) for t in times]
    earth_from_sun = np.asarray(sp.spkpos("EARTH", ets, PLANETS_FRAME, "NONE", "SUN")[0])
    sun_fixed = np.asarray(sp.spkpos("SUN", ets, "ITRF93", "NONE", "EARTH")[0])
    cases = []
    for t, earth, fixed in zip(times, earth_from_sun, sun_fixed, strict=True):
        _, lon, lat = sp.reclat(fixed.tolist())
        cases.append(
            {
                "tUtcMs": int(t),
                "earthFromSunKm": [float(v) for v in earth],
                "subsolar": {"latDeg": math.degrees(lat), "lonDeg": math.degrees(lon)},
            }
        )
    meta = {"frame": "ITRF93", "abcorr": "NONE", "kernels": kernels, "seed": seed}
    EARTH_SUN_GOLDEN_PATH.write_text(json.dumps({"generated": meta, "cases": cases}, indent=1) + "\n")
    return len(cases)


def main() -> None:
    kernels = load_kernels()
    if sp.namfrm(FRAME) == 0:
        raise SystemExit(f"{FRAME} is not defined by the loaded kernels")
    header = build_table(kernels)
    size_mb = TABLE_PATH.stat().st_size / 1e6
    print(f"table: {header['count']} hourly samples, {size_mb:.1f} MB -> {TABLE_PATH}")
    print(f"golden: {build_golden(kernels)} cases -> {GOLDEN_PATH}")
    planets = build_planets(kernels)
    print(f"planets: {planets['count']} samples, {PLANETS_PATH.stat().st_size / 1e6:.1f} MB -> {PLANETS_PATH}")
    print(f"planets golden: {build_planets_golden(kernels)} cases -> {PLANETS_GOLDEN_PATH}")
    print(f"earth sun golden: {build_earth_sun_golden(kernels)} cases -> {EARTH_SUN_GOLDEN_PATH}")


if __name__ == "__main__":
    main()
