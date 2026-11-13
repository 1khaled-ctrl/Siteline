"""The MEGDR mosaic, checked on small made-up tiles: no network, and no 2 GB of NASA data, in the test run."""

import numpy as np
import pytest

from siteline_pipeline.mars_height import HEIGHT_OFFSET_M, Tile, encode, label_value, mosaic, resample_band

# A label like NASA's, with the keys the reader uses. Four tiles of 4 rows x 8 columns cover the globe at 1/45 of a
# degree per pixel in this test's small world: 2 bands of 44 degrees, 4 quarters of 90 degrees.
LABEL = """PDS_VERSION_ID                = PDS3
LINES                        = {rows}
LINE_SAMPLES                 = {cols}
SAMPLE_TYPE                  = MSB_INTEGER
SAMPLE_BITS                  = 16
MAP_RESOLUTION               = {resolution} <PIXEL/DEGREE>
MAXIMUM_LATITUDE             = {north} <DEGREE>
MINIMUM_LATITUDE             = {south} <DEGREE>
WESTERNMOST_LONGITUDE        = {west} <DEGREE>
EASTERNMOST_LONGITUDE        = {east} <DEGREE>
CENTER_LONGITUDE             = 180.0 <DEGREE>
LINE_PROJECTION_OFFSET       = 1.5
SAMPLE_PROJECTION_OFFSET     = 2.5
"""


def write_tile(tmp_path, name: str, heights: np.ndarray, north: float, west: float, resolution: float):
    img = tmp_path / f"{name}.img"
    img.write_bytes(heights.astype(">i2").tobytes())
    rows, cols = heights.shape
    label = LABEL.format(
        rows=rows,
        cols=cols,
        resolution=resolution,
        north=north,
        south=north - rows / resolution,
        west=west,
        east=west + cols / resolution,
    )
    return Tile(name, img, label)


def test_label_value_drops_quotes_and_units() -> None:
    assert label_value(LABEL.format(rows=4, cols=8, resolution=1, north=2, south=-2, west=0, east=8), "LINES") == "4"
    assert label_value('A = "text"\n', "A") == "text"
    assert label_value("MAP_RESOLUTION = 128.0 <PIXEL/DEGREE>\n", "MAP_RESOLUTION") == "128.0"


def test_a_missing_key_is_an_error() -> None:
    with pytest.raises(ValueError, match="no LINES"):
        label_value("SAMPLE_BITS = 16\n", "LINES")


def test_a_tile_whose_label_disagrees_with_its_size_is_refused(tmp_path) -> None:
    img = tmp_path / "short.img"
    img.write_bytes(np.zeros((2, 2), dtype=">i2").tobytes())
    label = LABEL.format(rows=4, cols=8, resolution=1, north=2, south=-2, west=0, east=8)
    with pytest.raises(ValueError, match="is not 4 x 8 samples"):
        Tile("short", img, label)


def test_a_tile_that_is_not_big_endian_16_bit_is_refused(tmp_path) -> None:
    img = tmp_path / "wrong.img"
    img.write_bytes(np.zeros((1, 1), dtype=">i2").tobytes())
    label = LABEL.format(rows=1, cols=1, resolution=1, north=1, south=0, west=0, east=1).replace(
        "MSB_INTEGER", "LSB_INTEGER"
    )
    with pytest.raises(ValueError, match="big-endian"):
        Tile("wrong", img, label)


def test_tiles_land_where_their_labels_say(tmp_path) -> None:
    """Four tiles, each a different constant, end up in their own quarter of the mosaic."""
    resolution = 1.0
    rows, cols = 4, 90
    tiles = []
    for i, (north, west) in enumerate([(4, 0), (4, 90), (0, 0), (0, 90)]):
        heights = np.full((rows, cols), (i + 1) * 100, dtype=np.int16)
        tiles.append(write_tile(tmp_path, f"t{i}", heights, north, west, resolution))
    grid, got_resolution = mosaic(tiles)
    assert got_resolution == resolution
    assert grid.shape == (8, 360)
    assert grid[0, 0] == 100  # north, 0 to 90 degrees east
    assert grid[0, 90] == 200  # north, 90 to 180
    assert grid[4, 0] == 300  # south, 0 to 90
    assert grid[4, 90] == 400


def test_tiles_of_different_resolutions_are_refused(tmp_path) -> None:
    a = write_tile(tmp_path, "a", np.zeros((4, 90), dtype=np.int16), 4, 0, 1.0)
    b = write_tile(tmp_path, "b", np.zeros((8, 180), dtype=np.int16), 4, 90, 2.0)
    with pytest.raises(ValueError, match="pixels a degree"):
        mosaic([a, b])


def test_heights_survive_the_round_trip_through_the_png_encoding() -> None:
    heights = np.array([[0.0, 1000.0, -8200.0, 21200.0]])
    rgb = encode(heights)
    back = rgb[..., 0].astype(np.float64) * 256 + rgb[..., 1] - HEIGHT_OFFSET_M
    assert back.tolist() == heights.tolist()


def test_the_band_resamples_onto_a_whole_globe() -> None:
    """A band covering 88 degrees either way keeps its own rows in the middle of a full-height image."""
    band = np.arange(176, dtype=np.int16)[:, None] * np.ones((1, 360), dtype=np.int16)
    out = resample_band(band, 88.0, 8, 180)
    assert out.shape == (180, 8)
    # The middle row of the image is the middle of the band.
    assert abs(int(out[90, 0]) - 88) <= 1
