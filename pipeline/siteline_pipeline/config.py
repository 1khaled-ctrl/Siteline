"""Reads a dataset's config from `pipeline/configs`.

Each input file the pipeline fetches has a config naming its URL, size, licence, citation and dataset id (see
pipeline/CLAUDE.md). The configs are YAML, but only the shallow part of it: `key: value`, `key: >-` folded text, and a
`files:` list of plain strings. Reading that much needs no library, which keeps the pipeline's dependencies to numpy
and SpiceyPy; anything deeper belongs in a config that this refuses rather than guesses at.
"""

import re
from pathlib import Path

from .kernels import PIPELINE

CONFIG_DIR = PIPELINE / "configs"

Value = str | int | list[str]


def parse(text: str) -> dict[str, Value]:
    """A config's keys. Values are text, whole numbers, or a list of text; folded blocks join into one line."""
    out: dict[str, Value] = {}
    key: str | None = None
    folded: list[str] | None = None
    items: list[str] | None = None

    def close() -> None:
        nonlocal key, folded, items
        if key is not None and folded is not None:
            out[key] = " ".join(folded)
        if key is not None and items is not None:
            out[key] = items
        key, folded, items = None, None, None

    for raw in text.splitlines():
        line = raw.split("#", 1)[0].rstrip() if not raw.lstrip().startswith("#") else ""
        if not line.strip():
            continue
        if line.startswith("  - ") and items is not None:
            items.append(line[4:].strip().strip("\"'"))
            continue
        if line.startswith("  ") and folded is not None:
            folded.append(line.strip())
            continue
        if not re.match(r"^[A-Za-z][\w-]*:", line):
            raise ValueError(f"the config has a line this reader does not understand: {raw!r}")
        close()
        name, _, rest = line.partition(":")
        key, rest = name.strip(), rest.strip()
        if rest in (">-", ">", "|"):
            folded = []
        elif rest == "":
            items = []
        else:
            value = rest.strip("\"'")
            out[key] = int(value) if re.fullmatch(r"-?\d+", value) else value
            key = None
    close()
    return out


def load(dataset_id: str) -> dict[str, Value]:
    """The config for a dataset id, by its file name in `pipeline/configs`."""
    path = CONFIG_DIR / f"{dataset_id}.yaml"
    config = parse(path.read_text(encoding="utf-8"))
    if config.get("datasetId") != dataset_id:
        raise ValueError(f"{path.name} is for dataset {config.get('datasetId')!r}, not {dataset_id!r}")
    return config


def text(config: dict[str, Value], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str):
        raise TypeError(f"the config's {key} is not text")
    return value


def number(config: dict[str, Value], key: str) -> int:
    value = config.get(key)
    if not isinstance(value, int):
        raise TypeError(f"the config's {key} is not a whole number")
    return value


def names(config: dict[str, Value], key: str) -> list[str]:
    value = config.get(key)
    if not isinstance(value, list):
        raise TypeError(f"the config's {key} is not a list")
    return value


def path_of(dataset_id: str) -> Path:
    return CONFIG_DIR / f"{dataset_id}.yaml"
