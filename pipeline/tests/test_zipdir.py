"""The zip reader, on an archive the standard library writes: the member comes out of its own byte range alone."""

import io
import zipfile

import pytest

from siteline_pipeline import zipdir


@pytest.fixture
def archive() -> tuple[bytes, dict[str, bytes]]:
    files = {"region/README.txt": b"hello " * 100, "region/A_GLDELEV_005.tif": bytes(range(256)) * 300}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("region/", "")
        z.writestr(zipfile.ZipInfo("region/README.txt"), files["region/README.txt"], zipfile.ZIP_STORED)
        z.writestr("region/A_GLDELEV_005.tif", files["region/A_GLDELEV_005.tif"], zipfile.ZIP_DEFLATED)
    return buf.getvalue(), files


def test_lists_every_member_with_its_method_and_sizes(archive) -> None:
    data, files = archive
    members = {m.name: m for m in zipdir.Archive.in_memory(data).members()}
    assert set(members) == {"region/", "region/README.txt", "region/A_GLDELEV_005.tif"}
    assert members["region/README.txt"].method == zipdir.STORED
    assert members["region/A_GLDELEV_005.tif"].method == zipdir.DEFLATED
    assert members["region/A_GLDELEV_005.tif"].size == len(files["region/A_GLDELEV_005.tif"])
    assert members["region/A_GLDELEV_005.tif"].compressed < members["region/A_GLDELEV_005.tif"].size


def test_reads_one_member_from_its_own_bytes_only(archive) -> None:
    data, files = archive
    asked: list[tuple[int, int]] = []

    def fetch(start: int, size: int) -> bytes:
        asked.append((start, size))
        return data[start : start + size]

    a = zipdir.Archive(fetch, len(data))
    member = a.find("_GLDELEV_005.tif")
    assert a.read(member) == files["region/A_GLDELEV_005.tif"]
    # The directory at the end, the local header, and the member's bytes: never the archive from the start.
    assert all(start > 0 or size == len(data) for start, size in asked)
    assert asked[-1][1] == member.compressed


def test_a_stored_member_comes_out_as_is(archive) -> None:
    data, files = archive
    a = zipdir.Archive.in_memory(data)
    assert a.read(a.find("README.txt")) == files["region/README.txt"]


def test_find_wants_exactly_one_match(archive) -> None:
    data, _ = archive
    with pytest.raises(ValueError, match="0 members"):
        zipdir.Archive.in_memory(data).find("missing.tif")


def test_zip64_fields_replace_maxed_out_ones() -> None:
    import struct

    extra = struct.pack("<HH", 0x0001, 16) + struct.pack("<QQ", 5_000_000_000, 4_900_000_000)
    assert zipdir._zip64(extra, 0xFFFFFFFF, 0xFFFFFFFF, 123) == (5_000_000_000, 4_900_000_000, 123)
    assert zipdir._zip64(b"", 10, 9, 8) == (10, 9, 8)
