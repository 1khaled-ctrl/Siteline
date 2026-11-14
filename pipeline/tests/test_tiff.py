"""The tiled GeoTIFF reader, on a small image written here from the format's own rules: no fixture, no network."""

import struct
import zlib

import numpy as np
import pytest

from siteline_pipeline import tiff


def predictor3_encode(tile: np.ndarray) -> bytes:
    """TIFF's floating-point predictor, as the spec describes it: byte planes most significant first, then
    differenced along the row. Written from the spec, independently of the decoder."""
    rows, cols = tile.shape
    be = np.ascontiguousarray(tile, dtype=">f4").view(np.uint8).reshape(rows, cols, 4)
    planes = be.transpose(0, 2, 1).reshape(rows, cols * 4)
    diffed = planes.copy()
    diffed[:, 1:] = (planes[:, 1:].astype(np.int16) - planes[:, :-1].astype(np.int16)) % 256
    return diffed.astype(np.uint8).tobytes()


def write_tiff(heights: np.ndarray, tile: int, pixel_m: float, origin: tuple[float, float], nodata: float) -> bytes:
    """A little-endian classic TIFF of float32 tiles, deflated with the floating-point predictor."""
    height, width = heights.shape
    across, down = -(-width // tile), -(-height // tile)
    tiles = []
    for tr in range(down):
        for tc in range(across):
            block = np.full((tile, tile), nodata, dtype=np.float32)
            piece = heights[tr * tile : (tr + 1) * tile, tc * tile : (tc + 1) * tile]
            block[: piece.shape[0], : piece.shape[1]] = piece
            tiles.append(zlib.compress(predictor3_encode(block)))
    entries = []  # (tag, type, count, value bytes)

    def short(v: int) -> tuple[int, int, bytes]:
        return 3, 1, struct.pack("<H", v)

    entries.append((256, *short(width)))
    entries.append((257, *short(height)))
    entries.append((258, *short(32)))
    entries.append((259, *short(8)))
    entries.append((277, *short(1)))
    entries.append((317, *short(3)))
    entries.append((322, *short(tile)))
    entries.append((323, *short(tile)))
    entries.append((339, *short(3)))
    entries.append((33550, 12, 3, struct.pack("<3d", pixel_m, pixel_m, 0)))
    entries.append((33922, 12, 6, struct.pack("<6d", 0, 0, 0, origin[0], origin[1], 0)))
    # GeoKey directory: version 1.1.0, one key: GTRasterTypeGeoKey = 1 (cells).
    entries.append((34735, 3, 8, struct.pack("<8H", 1, 1, 0, 1, 1025, 0, 1, 1)))
    text = f"{nodata}".encode() + b"\0"
    entries.append((42113, 2, len(text), text))
    # Layout: header, IFD, out-of-line values, then the tile data; offsets are filled in once sizes are known.
    n = len(entries) + 2  # plus tile offsets and byte counts
    ifd_at = 8
    values_at = ifd_at + 2 + n * 12 + 4
    blobs = b""
    packed = []
    for tag, typ, count, value in entries:
        if len(value) <= 4:
            packed.append(struct.pack("<HHI", tag, typ, count) + value.ljust(4, b"\0"))
        else:
            packed.append(struct.pack("<HHII", tag, typ, count, values_at + len(blobs)))
            blobs += value
    offsets_at = values_at + len(blobs)
    counts_at = offsets_at + 4 * len(tiles)
    data_at = counts_at + 4 * len(tiles)
    offsets, at = [], data_at
    for t in tiles:
        offsets.append(at)
        at += len(t)
    packed.append(struct.pack("<HHII", 324, 4, len(tiles), offsets_at))
    packed.append(struct.pack("<HHII", 325, 4, len(tiles), counts_at))
    packed.sort(key=lambda e: struct.unpack_from("<H", e)[0])
    ifd = struct.pack("<H", n) + b"".join(packed) + struct.pack("<I", 0)
    out = b"II*\0" + struct.pack("<I", ifd_at) + ifd + blobs
    out += struct.pack(f"<{len(tiles)}I", *offsets) + struct.pack(f"<{len(tiles)}I", *(len(t) for t in tiles))
    assert len(out) == data_at
    return out + b"".join(tiles)


@pytest.fixture
def image() -> tuple[np.ndarray, tiff.Grid]:
    rng = np.random.default_rng(7)
    heights = (rng.standard_normal((37, 45)) * 100 + 1500).astype(np.float32)
    heights[3, 4] = -3.4e38  # one cell of no data
    data = write_tiff(heights, tile=16, pixel_m=5.0, origin=(-52900.0, 105400.0), nodata=-3.4e38)
    return heights, tiff.open_grid(tiff.BytesSource(data))


def test_reads_the_header(image) -> None:
    grid = image[1]
    assert (grid.width, grid.height, grid.tile_w, grid.tile_h) == (45, 37, 16, 16)
    assert (grid.compression, grid.predictor, grid.sample_format, grid.bits) == (8, 3, 3, 32)
    assert (grid.pixel_m, grid.origin_x, grid.origin_y) == (5.0, -52900.0, 105400.0)
    assert grid.nodata == pytest.approx(-3.4e38)


def test_a_window_matches_the_heights_written(image) -> None:
    heights, grid = image
    window = tiff.read_window(grid, 5, 7, 40, 30)
    expected = heights[7:30, 5:40]
    assert np.allclose(window, expected, equal_nan=False)


def test_no_data_and_the_outside_read_as_nan(image) -> None:
    heights, grid = image
    window = tiff.read_window(grid, 0, 0, 50, 40)
    assert np.isnan(window[3, 4])
    assert np.isnan(window[:, 45:]).all() and np.isnan(window[37:, :]).all()
    assert np.allclose(window[:37, :45][~np.isnan(window[:37, :45])], heights[~(heights < -1e38)])


def test_cell_of_measures_from_the_first_cell_centre(image) -> None:
    grid = image[1]
    assert grid.cell_of(-52900.0 + 2.5, 105400.0 - 2.5) == (0.0, 0.0)
    assert grid.cell_of(-52900.0 + 52.5, 105400.0 - 12.5) == (10.0, 2.0)


def test_a_point_registered_grid_is_shifted_half_a_cell() -> None:
    assert tiff.raster_type((1, 1, 0, 1, 1025, 0, 1, 2)) == 2
    assert tiff.raster_type((1, 1, 0, 1, 1025, 0, 1, 1)) == 1
    assert tiff.raster_type(None) is None


def test_refuses_what_it_does_not_read() -> None:
    with pytest.raises(ValueError, match="not a TIFF"):
        tiff.open_grid(tiff.BytesSource(b"\x89PNG" + b"\0" * 64))
