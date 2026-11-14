import pytest

from siteline_pipeline import config


def test_reads_text_numbers_and_lists() -> None:
    parsed = config.parse(
        """
# a comment
datasetId: a-dataset
tileBytes: 129761280
quoted: "with spaces"
files:
  - first
  - second
"""
    )
    assert parsed == {
        "datasetId": "a-dataset",
        "tileBytes": 129761280,
        "quoted": "with spaces",
        "files": ["first", "second"],
    }


def test_a_folded_block_becomes_one_line() -> None:
    parsed = config.parse("licence: >-\n  first part\n  second part\nafter: yes\n")
    assert parsed["licence"] == "first part second part"
    assert parsed["after"] == "yes"


def test_refuses_a_line_it_does_not_understand() -> None:
    with pytest.raises(ValueError, match="does not understand"):
        config.parse("nested:\n  deeper:\n    value: 1\n")


def test_the_mars_config_carries_what_credits_needs() -> None:
    c = config.load("mola-megdr-128")
    assert len(config.names(c, "files")) == 16
    assert config.number(c, "tileBytes") == 129_761_280
    assert config.text(c, "baseUrl").startswith("https://")
    for key in ("licence", "citation", "dataSetId"):
        assert config.text(c, key)


def test_a_config_must_be_for_the_dataset_it_is_asked_for() -> None:
    with pytest.raises(FileNotFoundError):
        config.load("not-a-dataset")
