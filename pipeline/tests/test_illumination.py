import numpy as np
import pytest

from siteline_pipeline.illumination import Map, block_mean, distance_transform

LABEL = """PDS_VERSION_ID = "PDS3"
    LINES                 = {rows}
    LINE_SAMPLES          = {cols}
    SAMPLE_TYPE           = LSB_INTEGER
    SAMPLE_BITS           = 16
    SCALING_FACTOR        = {scale}
    OFFSET                = {offset}
 MAP_SCALE                    = 60 <m/pix>
"""


def test_a_map_is_scaled_by_its_own_label(tmp_path) -> None:
    img = tmp_path / "m.img"
    np.array([[0, 20000], [-20000, 10000]], dtype="<i2").tofile(img)
    m = Map(img, LABEL.format(rows=2, cols=2, scale=0.000025, offset=0.5))
    assert m.values.tolist() == [[0.5, 1.0], [0.0, 0.75]]
    assert m.pixel_m == 60


def test_a_map_whose_size_disagrees_with_its_label_is_refused(tmp_path) -> None:
    img = tmp_path / "m.img"
    np.zeros((2, 2), dtype="<i2").tofile(img)
    with pytest.raises(ValueError, match="is not 3 x 3"):
        Map(img, LABEL.format(rows=3, cols=3, scale=1, offset=0))


def test_a_big_endian_map_is_refused(tmp_path) -> None:
    img = tmp_path / "m.img"
    np.zeros((1, 1), dtype="<i2").tofile(img)
    with pytest.raises(ValueError, match="little-endian"):
        Map(img, LABEL.format(rows=1, cols=1, scale=1, offset=0).replace("LSB_INTEGER", "MSB_INTEGER"))


def test_block_mean_averages_each_block() -> None:
    v = np.arange(16, dtype=float).reshape(4, 4)
    assert block_mean(v, 2).tolist() == [[2.5, 4.5], [10.5, 12.5]]
    with pytest.raises(ValueError, match="does not divide"):
        block_mean(v, 3)


def test_distance_to_the_nearest_shadow_is_euclidean() -> None:
    mask = np.zeros((7, 9), dtype=bool)
    mask[1, 1] = True
    mask[5, 7] = True
    d = distance_transform(mask, 10.0)
    assert d[1, 1] == 0 and d[5, 7] == 0
    assert d[1, 4] == pytest.approx(30.0)  # three cells east of the first
    assert d[4, 5] == pytest.approx(np.hypot(1, 2) * 10)  # one down, two left of the second
    assert d[3, 3] == pytest.approx(np.hypot(2, 2) * 10)  # equidistant corner of the first


def test_no_shadow_at_all_reads_as_far_away() -> None:
    d = distance_transform(np.zeros((3, 3), dtype=bool), 60.0)
    assert (d > 1e9).all()
