import struct
import zipfile
from io import BytesIO

import pytest

from siteline_pipeline.mars_names import RAW_PATH, build_features, read_dbf, use_constraint, wrap_lon_deg

FIELDS = [("name", 40), ("center_lat", 24), ("center_lon", 24), ("diameter", 24), ("type", 40), ("approval", 20)]


def make_dbf(records: list[dict[str, str]]) -> bytes:
    header_len = 32 + 32 * len(FIELDS) + 1
    record_len = 1 + sum(length for _, length in FIELDS)
    out = struct.pack("<BBBBIHH", 3, 26, 11, 11, len(records), header_len, record_len) + bytes(20)
    for name, length in FIELDS:
        out += name.encode().ljust(11, b"\0") + b"C" + bytes(4) + bytes([length]) + bytes(15)
    out += b"\r"
    for r in records:
        out += b" " + b"".join(r[name].encode("utf-8").ljust(length) for name, length in FIELDS)
    return out


def record(
    name: str, lat: float, lon: float, diameter: float, kind: str, approval: str = "Adopted by IAU"
) -> dict[str, str]:
    return {
        "name": name,
        "center_lat": str(lat),
        "center_lon": str(lon),
        "diameter": str(diameter),
        "type": kind,
        "approval": approval,
    }


def test_dbf_records_come_back_as_text_with_accents_intact() -> None:
    rows = read_dbf(make_dbf([record("Hephaestus Rupēs", 22.0, 119.0, 100.0, "Rupes, rupēs")]))
    assert rows[0]["name"] == "Hephaestus Rupēs"
    assert rows[0]["type"] == "Rupes, rupēs"


def test_longitudes_go_from_0_to_360_east_to_minus_180_to_180() -> None:
    assert [wrap_lon_deg(x) for x in (0, 90, 180, 180.5, 360)] == [0, 90, 180, -179.5, 0]
    assert wrap_lon_deg(226.2) == pytest.approx(-133.8)


def test_features_are_adopted_names_largest_first_with_the_plain_descriptor() -> None:
    rows = read_dbf(
        make_dbf(
            [
                record("Small", 1.0, 10.0, 5.0, "Crater, craters"),
                record("[Dropped]", 2.0, 20.0, 9000.0, "Crater, craters", "Dropped"),
                record("Olympus Mons", 18.6528, 226.1975, 610.13, "Mons, montes"),
            ]
        )
    )
    assert build_features(rows) == [
        ["Olympus Mons", 18.6528, -133.8025, 610.13, "Mons"],
        ["Small", 1.0, 10.0, 5.0, "Crater"],
    ]


def test_a_feature_listed_twice_with_the_same_values_comes_out_once() -> None:
    twice = record("Bohar", 55.35, -106.45, 11.0, "Crater, craters")
    other = record("Bohar", 10.0, 20.0, 11.0, "Crater, craters")
    names = [f[:3] for f in build_features(read_dbf(make_dbf([twice, other, twice])))]
    assert sorted(names) == [["Bohar", 10.0, 20.0], ["Bohar", 55.35, -106.45]]


def test_the_download_must_say_public_domain() -> None:
    def zip_with(constraint: str) -> zipfile.ZipFile:
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("metadata.xml", f"<metadata><useconst>{constraint}</useconst></metadata>")
        return zipfile.ZipFile(BytesIO(buf.getvalue()))

    assert use_constraint(zip_with("Public domain.")) == "Public domain."
    with pytest.raises(SystemExit):
        use_constraint(zip_with("Copyright, all rights reserved"))


@pytest.mark.skipif(not RAW_PATH.exists(), reason="run `python -m siteline_pipeline.mars_names` first")
def test_the_usgs_download_names_the_places_we_expect() -> None:
    with zipfile.ZipFile(RAW_PATH) as zf:
        assert "public domain" in use_constraint(zf).lower()
        features = build_features(read_dbf(zf.read(next(n for n in zf.namelist() if n.endswith(".dbf")))))
    by_name = {f[0]: f for f in features}
    assert len(features) > 2000
    assert not any(f[0].startswith("[") for f in features)
    olympus = by_name["Olympus Mons"]
    assert (
        olympus[4] == "Mons"
        and olympus[1] == pytest.approx(18.65, abs=0.01)
        and olympus[2] == pytest.approx(-133.8, abs=0.01)
    )
    assert by_name["Jezero"][4] == "Crater" and by_name["Jezero"][1] == pytest.approx(18.41, abs=0.01)
    assert by_name["Valles Marineris"][4] == "Vallis" and by_name["Valles Marineris"][3] > 3700
