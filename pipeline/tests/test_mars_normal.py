import numpy as np
import pytest

from siteline_pipeline.mars_normal import (
    MARS_RADIUS_M,
    decode_heights,
    decode_tilt,
    encode,
    height_path,
    resample,
    tilt,
)
from siteline_pipeline.pngio import read_png_rgb


def test_heights_are_a_16_bit_number_in_red_and_green() -> None:
    rgb = np.array([[[128, 0, 0], [0, 0, 0], [131, 232, 0], [127, 255, 9]]], dtype=np.uint8)
    assert decode_heights(rgb).tolist() == [[0, -32768, 1000, -1]]


def test_flat_ground_faces_straight_up() -> None:
    n_east, n_north, n_up = tilt(np.full((5, 9), 1234.0))
    assert np.allclose(n_east, 0) and np.allclose(n_north, 0) and np.allclose(n_up, 1)
    r, g, b = encode(n_east, n_north, n_up)[2, 4]
    assert (r, g, b) == (128, 128, 255)  # 127.5 rounds to the even 128; up is full blue


@pytest.mark.parametrize("g", [0.02, 0.2, 1.0])
def test_ground_rising_to_the_east_tilts_its_normal_west(g: float) -> None:
    lon = np.linspace(-np.pi, np.pi, 9)
    heights = np.tile(g * MARS_RADIUS_M * lon, (5, 1))  # rises g metres per metre of ground along the equator
    n_east, n_north, n_up = tilt(heights)
    # The equator is the middle row; the columns beside the seam see the jump back from 180° to -180°.
    assert np.allclose(n_east[2, 2:-2], -g / np.sqrt(1 + g * g))
    assert np.allclose(n_up[2, 2:-2], 1 / np.sqrt(1 + g * g))
    assert np.allclose(n_north[2, 2:-2], 0)


@pytest.mark.parametrize("g", [0.02, 0.5])
def test_ground_rising_to_the_north_tilts_its_normal_south(g: float) -> None:
    lat = np.linspace(np.pi / 2, -np.pi / 2, 9)  # rows run from north to south
    heights = np.tile((g * MARS_RADIUS_M * lat)[:, None], (1, 13))
    n_east, n_north, _ = tilt(heights)
    assert np.allclose(n_north[1:-1], -g / np.sqrt(1 + g * g))
    assert np.allclose(n_east[1:-1], 0)


def test_tilts_survive_being_stored_in_a_byte() -> None:
    n = np.array([-0.5, -0.1, -0.003, 0.0, 0.003, 0.1, 0.5])
    stored = encode(n[None, :], n[None, :], np.ones((1, 7)))[0, :, 0]
    back = decode_tilt(stored)
    # The square-root coding is finest near zero and coarsest on steep ground: half a step is 0.006 at a tilt of 0.5.
    assert np.allclose(back, n, atol=0.006)
    assert np.allclose(back[2:5], n[2:5], atol=0.0005)
    big = [0, 1, 5, 6]
    assert np.all(np.sign(decode_tilt(stored)[big]) == np.sign(n[big]))


def test_resampling_keeps_a_ramp_at_pixel_centres() -> None:
    field = np.tile(np.arange(9.0), (5, 1))  # 8 intervals across the whole map
    out = resample(field, 4, 2)
    assert np.allclose(out[0], (np.arange(4) + 0.5) / 4 * 8)


@pytest.mark.skipif(not height_path().exists(), reason="no Mars height map is on disk")
def test_olympus_mons_faces_outwards_on_every_side() -> None:
    heights = decode_heights(read_png_rgb(height_path().read_bytes()))
    n_east, n_north, _ = tilt(heights)
    rows, cols = heights.shape

    def at(lat_deg: float, lon_deg: float) -> tuple[int, int]:
        return round((90 - lat_deg) / 180 * (rows - 1)), round((lon_deg + 180) / 360 * (cols - 1))

    # 3° is about 180 km from the summit (18.65°N, 133.8°W), on the volcano's flank.
    assert n_east[at(18.65, -136.8)] < 0 < n_east[at(18.65, -130.8)]
    assert n_north[at(21.65, -133.8)] > 0 > n_north[at(15.65, -133.8)]
