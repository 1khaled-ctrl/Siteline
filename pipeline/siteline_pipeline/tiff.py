"""A small reader for the tiled GeoTIFFs the pipeline cuts terrain from.

Classic or BigTIFF, uncompressed or deflate, with TIFF's horizontal and floating-point predictors: enough for LOLA's
polar DEMs and the Artemis III site models, and nothing else. It reads by byte range, from a URL or from memory, so
a 5 GB file costs only the header and the tiles a window needs. No GDAL, so the pipeline keeps its dependencies.
"""

import struct
import urllib.request
import zlib
from dataclasses import dataclass
from typing import Protocol, TypeVar

import numpy as np

# Plane coordinates: one point or an array of them.
Coord = TypeVar("Coord", float, np.ndarray)

USER_AGENT = "siteline-pipeline"
DEFLATE = (8, 32946)
HEADER_BYTES = 1 << 20

# TIFF tags this reader uses.
WIDTH, HEIGHT, BITS, COMPRESSION, SAMPLES = 256, 257, 258, 259, 277
PREDICTOR, TILE_WIDTH, TILE_LENGTH, TILE_OFFSETS, TILE_COUNTS = 317, 322, 323, 324, 325
SAMPLE_FORMAT, PIXEL_SCALE, TIEPOINT, GEO_KEYS, NODATA = 339, 33550, 33922, 34735, 42113
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8}
TYPE_FORMAT = {1: "B", 3: "H", 4: "I", 6: "b", 8: "h", 9: "i", 11: "f", 12: "d", 16: "Q", 17: "q"}
RASTER_TYPE_KEY = 1025
PIXEL_IS_POINT = 2


class Source(Protocol):
    def read(self, offset: int, size: int) -> bytes:
        """Up to `size` bytes from `offset`: fewer only past the end of the file."""
        ...


class UrlSource:
    """Byte ranges of a file on a server that honours Range requests."""

    def __init__(self, url: str) -> None:
        self.url = url

    def read(self, offset: int, size: int) -> bytes:
        headers = {"Range": f"bytes={offset}-{offset + size - 1}", "User-Agent": USER_AGENT}
        with urllib.request.urlopen(urllib.request.Request(self.url, headers=headers)) as response:
            return response.read()


class BytesSource:
    """A file already in memory, or the first part of one."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self, offset: int, size: int) -> bytes:
        return self.data[offset : offset + size]


@dataclass
class Grid:
    """One tiled image and where it sits: `origin_x`, `origin_y` are the outer corner of its first cell, in metres."""

    source: Source
    big: bool
    order: str
    width: int
    height: int
    tile_w: int
    tile_h: int
    tile_offsets: np.ndarray
    tile_counts: np.ndarray
    compression: int
    predictor: int
    sample_format: int
    bits: int
    pixel_m: float
    origin_x: float
    origin_y: float
    nodata: float | None

    def cell_of(self, x: Coord, y: Coord) -> tuple[Coord, Coord]:
        """The fractional column and row of plane coordinates, measured from the first cell's centre."""
        return (x - self.origin_x) / self.pixel_m - 0.5, (self.origin_y - y) / self.pixel_m - 0.5


class _Header:
    """The first bytes of the file, extended on demand when a tag's values lie further in."""

    def __init__(self, source: Source) -> None:
        self.source = source
        self.data = source.read(0, HEADER_BYTES)

    def get(self, offset: int, size: int) -> bytes:
        if offset + size > len(self.data):
            self.data += self.source.read(len(self.data), offset + size - len(self.data))
        if offset + size > len(self.data):
            raise ValueError(f"the file ends before byte {offset + size}")
        return self.data[offset : offset + size]


def open_grid(source: Source) -> Grid:
    """Parse the first image's directory. Raises if the file is not a tiled image this reader handles."""
    head = _Header(source)
    magic = head.get(0, 4)
    order = "<" if magic[:2] == b"II" else ">"
    kind = struct.unpack(order + "H", magic[2:4])[0] if magic[:2] in (b"II", b"MM") else 0
    if kind == 43:
        big, ifd = True, struct.unpack(order + "Q", head.get(8, 8))[0]
    elif kind == 42:
        big, ifd = False, struct.unpack(order + "I", head.get(4, 4))[0]
    else:
        raise ValueError("not a TIFF file")
    count_size, entry_size, inline = (8, 20, 8) if big else (2, 12, 4)
    count = struct.unpack(order + ("Q" if big else "H"), head.get(ifd, count_size))[0]
    tags: dict[int, tuple] = {}
    for i in range(count):
        at = ifd + count_size + i * entry_size
        tag, typ = struct.unpack(order + "HH", head.get(at, 4))
        n = struct.unpack(order + ("Q" if big else "I"), head.get(at + 4, 8 if big else 4))[0]
        value_at = at + 4 + (8 if big else 4)
        size = TYPE_SIZE[typ] * n
        if size > inline:
            value_at = struct.unpack(order + ("Q" if big else "I"), head.get(value_at, inline))[0]
        if typ == 2:
            tags[tag] = (head.get(value_at, n).split(b"\0")[0].decode("ascii", "replace"),)
        elif typ in TYPE_FORMAT:
            tags[tag] = struct.unpack(order + TYPE_FORMAT[typ] * n, head.get(value_at, size))

    def one(tag: int, default: int | None = None) -> int:
        if tag in tags:
            return int(tags[tag][0])
        if default is None:
            raise ValueError(f"the image has no tag {tag}")
        return default

    if TILE_OFFSETS not in tags:
        raise ValueError("the image is not tiled")
    scale = tags.get(PIXEL_SCALE)
    tie = tags.get(TIEPOINT)
    if scale is None or tie is None:
        raise ValueError("the image has no pixel scale or tie point")
    pixel_m = float(scale[0])
    if abs(pixel_m - float(scale[1])) > 1e-9:
        raise ValueError("the image's cells are not square")
    # The tie point places raster (i, j) at model (x, y): for a grid of points that is the first cell's centre.
    x = float(tie[3]) - float(tie[0]) * pixel_m
    y = float(tie[4]) + float(tie[1]) * pixel_m
    if raster_type(tags.get(GEO_KEYS)) == PIXEL_IS_POINT:
        x -= pixel_m / 2
        y += pixel_m / 2
    nodata_text = tags.get(NODATA, (None,))[0]
    nodata = float(nodata_text) if nodata_text not in (None, "", "nan") else None
    return Grid(
        source=source,
        big=big,
        order=order,
        width=one(WIDTH),
        height=one(HEIGHT),
        tile_w=one(TILE_WIDTH),
        tile_h=one(TILE_LENGTH),
        tile_offsets=np.asarray(tags[TILE_OFFSETS], dtype=np.int64),
        tile_counts=np.asarray(tags[TILE_COUNTS], dtype=np.int64),
        compression=one(COMPRESSION, 1),
        predictor=one(PREDICTOR, 1),
        sample_format=one(SAMPLE_FORMAT, 1),
        bits=one(BITS),
        pixel_m=pixel_m,
        origin_x=x,
        origin_y=y,
        nodata=nodata,
    )


def raster_type(geo_keys: tuple | None) -> int | None:
    """GTRasterTypeGeoKey from the GeoKey directory: 1 for cells, 2 for points."""
    if not geo_keys:
        return None
    for i in range(4, len(geo_keys) - 3, 4):
        key, location, count, value = geo_keys[i : i + 4]
        if key == RASTER_TYPE_KEY and location == 0 and count == 1:
            return int(value)
    return None


def _dtype(grid: Grid) -> np.dtype:
    kind = {1: "u", 2: "i", 3: "f"}[grid.sample_format]
    return np.dtype(f"{grid.order}{kind}{grid.bits // 8}")


def decode_tile(grid: Grid, data: bytes) -> np.ndarray:
    """One tile's samples as an array of tile_h x tile_w, undoing its compression and predictor."""
    raw = zlib.decompress(data) if grid.compression in DEFLATE else data
    bps = grid.bits // 8
    rows, cols = grid.tile_h, grid.tile_w
    if len(raw) != rows * cols * bps:
        raise ValueError(f"a tile holds {len(raw)} bytes, not {rows} x {cols} x {bps}")
    if grid.predictor == 3:
        # TIFF's floating-point predictor: each row's bytes were split into planes, most significant first, then
        # differenced byte by byte along the row. Add them back up, then put each sample's bytes back together.
        planes = np.cumsum(np.frombuffer(raw, np.uint8).reshape(rows, cols * bps), axis=1, dtype=np.uint8)
        joined = planes.reshape(rows, bps, cols).transpose(0, 2, 1).reshape(rows, cols * bps)
        return np.frombuffer(joined.tobytes(), np.dtype(f">{_dtype(grid).kind}{bps}")).reshape(rows, cols)
    arr = np.frombuffer(raw, _dtype(grid)).reshape(rows, cols)
    if grid.predictor == 2:
        return np.cumsum(arr, axis=1, dtype=arr.dtype)
    return arr


def read_window(grid: Grid, c0: int, r0: int, c1: int, r1: int) -> np.ndarray:
    """Heights of the cells in columns c0..c1 and rows r0..r1 (end exclusive), as float32 with NaN where there is no
    data. Only the tiles the window touches are fetched; a window reaching outside the image is NaN there."""
    out = np.full((r1 - r0, c1 - c0), np.nan, dtype=np.float32)
    across = -(-grid.width // grid.tile_w)
    down = -(-grid.height // grid.tile_h)
    for tr in range(max(0, r0 // grid.tile_h), min(-(-r1 // grid.tile_h), down)):
        for tc in range(max(0, c0 // grid.tile_w), min(-(-c1 // grid.tile_w), across)):
            i = tr * across + tc
            count = int(grid.tile_counts[i])
            if count == 0:
                continue
            data = grid.source.read(int(grid.tile_offsets[i]), count)
            if len(data) != count:
                raise OSError(f"tile {i}: asked for {count} bytes, got {len(data)}")
            tile = decode_tile(grid, data)
            tile_x, tile_y = tc * grid.tile_w, tr * grid.tile_h
            x0, y0 = max(c0, tile_x), max(r0, tile_y)
            x1, y1 = min(c1, tile_x + grid.tile_w, grid.width), min(r1, tile_y + grid.tile_h, grid.height)
            if x1 <= x0 or y1 <= y0:
                continue
            piece = tile[y0 - tile_y : y1 - tile_y, x0 - tile_x : x1 - tile_x].astype(np.float32)
            if grid.nodata is not None:
                piece = np.where(piece == np.float32(grid.nodata), np.nan, piece)
            out[y0 - r0 : y1 - r0, x0 - c0 : x1 - c0] = piece
    return out
