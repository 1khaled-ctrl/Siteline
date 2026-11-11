import struct
import zlib

import numpy as np
import pytest

from siteline_pipeline.pngio import SIGNATURE, read_png_rgb, write_png_rgb


def filtered_png(pixels: np.ndarray, kind: int) -> bytes:
    """A PNG whose every row uses one filter type, written the long way round to test the reader against."""
    height, width, _ = pixels.shape
    rows = pixels.reshape(height, width * 3).astype(int)
    raw = b""
    for y in range(height):
        line = []
        for i in range(width * 3):
            a = rows[y][i - 3] if i >= 3 else 0
            b = rows[y - 1][i] if y else 0
            c = rows[y - 1][i - 3] if y and i >= 3 else 0
            p = a + b - c
            paeth = a if abs(p - a) <= abs(p - b) and abs(p - a) <= abs(p - c) else b if abs(p - b) <= abs(p - c) else c
            predicted = [0, a, b, (a + b) >> 1, paeth][kind]
            line.append((rows[y][i] - predicted) & 255)
        raw += bytes([kind]) + bytes(line)

    def chunk(name: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + name + body + struct.pack(">I", zlib.crc32(name + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def test_written_png_reads_back_exactly() -> None:
    pixels = np.random.default_rng(1).integers(0, 256, (5, 7, 3), dtype=np.uint8)
    assert np.array_equal(read_png_rgb(write_png_rgb(pixels)), pixels)


@pytest.mark.parametrize("kind", [0, 1, 2, 3, 4])
def test_every_row_filter_is_undone(kind: int) -> None:
    pixels = np.random.default_rng(kind).integers(0, 256, (6, 9, 3), dtype=np.uint8)
    assert np.array_equal(read_png_rgb(filtered_png(pixels, kind)), pixels)


def test_other_kinds_of_png_are_refused() -> None:
    with pytest.raises(ValueError):
        read_png_rgb(b"not a png at all, just text")
    grey = bytearray(write_png_rgb(np.zeros((2, 2, 3), dtype=np.uint8)))
    grey[25] = 0  # colour type: greyscale
    with pytest.raises(ValueError):
        read_png_rgb(bytes(grey))
