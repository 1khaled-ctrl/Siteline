"""Just enough PNG for the pipeline: 8-bit RGB without interlacing, read and written with numpy and zlib only."""

import struct
import zlib

import numpy as np

SIGNATURE = b"\x89PNG\r\n\x1a\n"
BYTES_PER_PIXEL = 3


def _unfilter(kind: int, line: np.ndarray, prev: np.ndarray) -> np.ndarray:
    if kind == 0:
        return line
    if kind == 2:
        return (line + prev) & 255
    if kind == 1:
        out = line.copy()
        for c in range(BYTES_PER_PIXEL):
            out[c::BYTES_PER_PIXEL] = np.cumsum(line[c::BYTES_PER_PIXEL]) & 255
        return out
    out = np.zeros_like(line)
    for i in range(len(line)):
        a = int(out[i - BYTES_PER_PIXEL]) if i >= BYTES_PER_PIXEL else 0
        b = int(prev[i])
        if kind == 3:
            out[i] = (int(line[i]) + ((a + b) >> 1)) & 255
        else:
            c = int(prev[i - BYTES_PER_PIXEL]) if i >= BYTES_PER_PIXEL else 0
            p = a + b - c
            pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            out[i] = (int(line[i]) + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
    return out


def read_png_rgb(data: bytes) -> np.ndarray:
    """Pixels as an array of shape (height, width, 3), uint8."""
    if data[:8] != SIGNATURE:
        raise ValueError("not a PNG file")
    width, height, depth, colour, _, _, interlace = struct.unpack(">IIBBBBB", data[16:29])
    if (depth, colour, interlace) != (8, 2, 0):
        raise ValueError("only 8-bit RGB PNG files without interlacing are supported")
    chunks = []
    pos = 8
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        if data[pos + 4 : pos + 8] == b"IDAT":
            chunks.append(data[pos + 8 : pos + 8 + length])
        pos += 12 + length
    raw = zlib.decompress(b"".join(chunks))
    stride = width * BYTES_PER_PIXEL
    out = np.zeros((height, stride), dtype=np.int32)
    prev = np.zeros(stride, dtype=np.int32)
    for y in range(height):
        start = y * (stride + 1)
        line = np.frombuffer(raw, dtype=np.uint8, count=stride, offset=start + 1).astype(np.int32)
        out[y] = _unfilter(raw[start], line, prev)
        prev = out[y]
    return out.astype(np.uint8).reshape(height, width, BYTES_PER_PIXEL)


def write_png_rgb(pixels: np.ndarray) -> bytes:
    """A PNG of an array of shape (height, width, 3), uint8, with each row filtered against its left neighbour."""
    height, width, channels = pixels.shape
    if channels != BYTES_PER_PIXEL or pixels.dtype != np.uint8:
        raise ValueError("expected a uint8 array of shape (height, width, 3)")
    rows = pixels.reshape(height, width * BYTES_PER_PIXEL).astype(np.int32)
    filtered = rows.copy()
    filtered[:, BYTES_PER_PIXEL:] = (rows[:, BYTES_PER_PIXEL:] - rows[:, :-BYTES_PER_PIXEL]) & 255
    raw = b"".join(b"\x01" + filtered[y].astype(np.uint8).tobytes() for y in range(height))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return SIGNATURE + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
