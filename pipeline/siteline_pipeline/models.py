"""NASA 3D models for the lander cards: from NASA's mirror of its 3D Resources collection to files the app can load.

    cd pipeline
    uv run python -m siteline_pipeline.models build [--only ID ...] [--force]
    uv run python -m siteline_pipeline.models verify
    uv run python -m siteline_pipeline.models manifest
    uv run python -m siteline_pipeline.models upload --dry-run
    uv run python -m siteline_pipeline.models upload

The models, and everything said about them, are in `pipeline/configs/models.toml`. The steps are meant for the pipeline
VM (see pipeline/README.md); only `upload` writes to the bucket, and a person runs it.

`build`, for each model:
  1. reads the file's size and git blob hash from GitHub's listing of the mirror at the pinned commit, downloads it
     (kept in `raw/models/`) and checks it against both;
  2. runs gltf-transform's `optimize`: quantised geometry, WebP textures no larger than `textureSize`, and the model's
     `simplifyError` if it has one. NASA's files are Draco-compressed and the app's loader
     (`packages/engine/src/modelView.ts`) has no Draco decoder; quantised geometry needs none;
  3. wraps the result as `{"b64": "..."}`, the format that loader reads, in `out/models/v<version>/<id>.json`;
  4. fails the model, and writes nothing there, when the file is over the size limit.
A model whose source, settings, tool and output are unchanged since its last build is skipped. Each optimized `.glb`
and its textures are kept in `out/models/work/` for a person to look at. The run writes `data/models.json` and a run
manifest of what it read and wrote.

`verify` checks every built file: under the limit, JSON holding one base64 string, a valid binary glTF, no extension
that needs a decoder, and that it parses with three.js's GLTFLoader, the same loader and version as the app, in Node,
with no Draco decoder (`parse_glb.mjs`).

`upload` sends only the published files of models that are not rejected and whose logo check is recorded, after
`verify` passes, with rclone, never overwriting a file already there; then it lists the bucket to check each size.

From Python it needs only the standard library; `build` and `verify` need Node.
"""

import argparse
import base64
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, NoReturn

PIPELINE = Path(__file__).resolve().parents[1]
REPO = PIPELINE.parent
CONFIG_PATH = PIPELINE / "configs" / "models.toml"
MANIFEST_PATH = REPO / "data" / "models.json"
MISSIONS_PATH = REPO / "data" / "missions.json"
PARSE_SCRIPT = Path(__file__).with_name("parse_glb.mjs")
FORMAT = "siteline-models-1"
STATUSES = ("flew", "prototype", "concept", "being checked")
CACHE_CONTROL = "public, max-age=31536000, immutable"
OPTIMIZE_TIMEOUT_S = 1800

Json = dict[str, Any]
Fetch = Callable[[str], bytes]


class NotThere(Exception):
    """An address that answered 404."""


class ModelError(Exception):
    """One model could not be built. The run records why and goes on to the next one."""


class WrongSource(ModelError):
    """NASA's file is missing, or is not the file GitHub lists at the pinned commit."""


class OptimizeFailed(ModelError):
    """gltf-transform did not produce a file."""


class NotLoadable(ModelError):
    """The optimized file is one the app's loader cannot read."""


class TooBig(ModelError):
    """The built file is over the size limit."""


# --- The config -----------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Optimize:
    texture_size: int
    simplify_error: float | None = None

    def as_json(self) -> Json:
        out: Json = {"textureSize": self.texture_size}
        if self.simplify_error is not None:
            out["simplifyError"] = self.simplify_error
        return out


@dataclass(frozen=True)
class Model:
    id: str
    folder: str
    file: str
    optimize: Optimize
    version: int
    name: str
    source_url: str
    credit: str
    status: str
    status_source: str | None
    status_note: str | None
    mission: str | None
    logo_checked: bool
    logo_check: str
    rejected: str | None
    note: str | None

    @property
    def path(self) -> str:
        """The file's path in the mirror."""
        return f"3D Models/{self.folder}/{self.file}"

    @property
    def key(self) -> str:
        """Where it goes in the bucket, and under `out/` here."""
        return f"models/v{self.version}/{self.id}.json"


@dataclass(frozen=True)
class Config:
    dataset_id: str
    repo: str
    commit: str
    raw_base: str
    tool: str
    remote: str
    public_base: str
    limit_bytes: int
    licence: str
    citation: str
    models: dict[str, Model]


MODEL_KEYS = {
    "folder",
    "file",
    "textureSize",
    "simplifyError",
    "version",
    "name",
    "sourceUrl",
    "credit",
    "status",
    "statusSource",
    "statusNote",
    "mission",
    "logoChecked",
    "logoCheck",
    "rejected",
    "note",
}
TOP_KEYS = {
    "datasetId",
    "repo",
    "commit",
    "rawBase",
    "tool",
    "remote",
    "publicBase",
    "limitBytes",
    "licence",
    "citation",
    "defaults",
    "models",
}


def _bad(what: str) -> NoReturn:
    raise ValueError(f"pipeline/configs/models.toml: {what}")


def _optional(table: Json, key: str, label: str) -> str | None:
    value = table.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        _bad(f"{label}{key} is empty")
    return value


def _required(table: Json, key: str, label: str) -> str:
    value = table.get(key)
    if not isinstance(value, str) or not value.strip():
        _bad(f"{label}{key} is missing")
    return value


def _whole(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        _bad(f"{label} is not a whole number above zero")
    return value


def _nasa_page(url: str, label: str) -> str:
    host = urllib.parse.urlsplit(url).hostname or ""
    if not url.startswith("https://") or not (host == "nasa.gov" or host.endswith(".nasa.gov")):
        _bad(f"{label} is not a NASA page (an https address on nasa.gov)")
    return url


def mission_ids(path: Path = MISSIONS_PATH) -> set[str]:
    return {m["id"] for m in json.loads(path.read_text(encoding="utf-8"))["missions"]}


def parse_model(model_id: str, table: object, defaults: Json, missions: set[str]) -> Model:
    label = f"models.{model_id}."
    if not re.fullmatch(r"[a-z0-9]+(_[a-z0-9]+)*", model_id):
        _bad(f"{model_id}: an id is lower-case letters, digits and single underscores")
    if not isinstance(table, dict):
        _bad(f"models.{model_id} is not a table")
    for key in table:
        if key not in MODEL_KEYS:
            _bad(f"{label}{key} is not a field this step knows")
    file = _required(table, "file", label)
    if not file.endswith(".glb"):
        _bad(f"{label}file is not a .glb file: models that exist only as .blend, .3ds or .lwo cannot be used")
    texture_size = _whole(table.get("textureSize", defaults.get("textureSize")), f"{label}textureSize")
    if not 16 <= texture_size <= 4096:
        _bad(f"{label}textureSize is not between 16 and 4096 pixels")
    error = table.get("simplifyError")
    if error is not None and (isinstance(error, bool) or not isinstance(error, int | float) or not 0 < error < 1):
        _bad(f"{label}simplifyError is not a fraction between 0 and 1")
    status = _required(table, "status", label)
    if status not in STATUSES:
        _bad(f"{label}status is {status!r}; it is one of {', '.join(STATUSES)}")
    status_source = _optional(table, "statusSource", label)
    status_note = _optional(table, "statusNote", label)
    if status != "being checked" and (status_source is None or status_note is None):
        _bad(f'{label}status "{status}" needs the NASA page that says so (statusSource) and what it says (statusNote)')
    if status_source is not None:
        _nasa_page(status_source, f"{label}statusSource")
    mission = _required(table, "mission", label)
    if mission != "none" and mission not in missions:
        _bad(f'{label}mission {mission!r} is not in data/missions.json (use "none")')
    logo_checked = table.get("logoChecked")
    if not isinstance(logo_checked, bool):
        _bad(f"{label}logoChecked is not true or false")
    return Model(
        id=model_id,
        folder=_required(table, "folder", label),
        file=file,
        optimize=Optimize(texture_size, None if error is None else float(error)),
        version=_whole(table.get("version", 1), f"{label}version"),
        name=_required(table, "name", label),
        source_url=_nasa_page(_required(table, "sourceUrl", label), f"{label}sourceUrl"),
        credit=_required(table, "credit", label),
        status=status,
        status_source=status_source,
        status_note=status_note,
        mission=None if mission == "none" else mission,
        logo_checked=logo_checked,
        logo_check=_required(table, "logoCheck", label),
        rejected=_optional(table, "rejected", label),
        note=_optional(table, "note", label),
    )


def parse_config(raw: Json, missions: set[str]) -> Config:
    """The config, checked: a model with no NASA page, no credit line or an unsupported status is refused."""
    for key in raw:
        if key not in TOP_KEYS:
            _bad(f"{key} is not a setting this step knows")
    commit = _required(raw, "commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        _bad("commit is not a full git commit hash")
    tables = raw.get("models")
    if not isinstance(tables, dict) or not tables:
        _bad("there are no [models.<id>] tables")
    defaults = raw.get("defaults", {})
    public_base = _required(raw, "publicBase", "")
    if not public_base.startswith("https://") or public_base.endswith("/"):
        _bad("publicBase is not an https address without a trailing slash")
    remote = _required(raw, "remote", "")
    if not re.fullmatch(r"[\w-]+:[\w.-]+", remote):
        _bad("remote is not <rclone remote>:<bucket>")
    return Config(
        dataset_id=_required(raw, "datasetId", ""),
        repo=_required(raw, "repo", ""),
        commit=commit,
        raw_base=_required(raw, "rawBase", "").rstrip("/"),
        tool=_required(raw, "tool", ""),
        remote=remote,
        public_base=public_base,
        limit_bytes=_whole(raw.get("limitBytes"), "limitBytes"),
        licence=_required(raw, "licence", ""),
        citation=_required(raw, "citation", ""),
        models={i: parse_model(i, t, defaults, missions) for i, t in tables.items()},
    )


def load_config(path: Path = CONFIG_PATH) -> Config:
    return parse_config(tomllib.loads(path.read_text(encoding="utf-8")), mission_ids())


# --- Places ---------------------------------------------------------------------------------------------------------


def out_path(root: Path, model: Model) -> Path:
    """The file the upload sends: the bucket key, under `out/`."""
    return root / "out" / model.key


def work_dir(root: Path) -> Path:
    """What a person looks at and the step's own records: optimized `.glb`s, textures, build states, run manifest."""
    return root / "out" / "models" / "work"


def state_path(root: Path, model: Model) -> Path:
    return work_dir(root) / "state" / f"{model.id}.json"


# --- NASA's file ----------------------------------------------------------------------------------------------------


def http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "siteline-pipeline"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data: bytes = response.read()
            return data
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise NotThere(url) from error
        raise


def git_blob_hash(data: bytes) -> str:
    """The hash git gives a file with these bytes: what GitHub's trees API lists as a blob's `sha`."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data, usedforsecurity=False).hexdigest()


@dataclass(frozen=True)
class Listed:
    """A file as GitHub lists it in the mirror at the pinned commit."""

    path: str
    size: int
    git_blob: str


def mirror_listing(config: Config, root: Path, fetch: Fetch) -> dict[str, Listed]:
    """Every file of the mirror at the pinned commit, from GitHub's trees API (one call, kept in `raw/models/`)."""
    path = root / "raw" / "models" / f"tree-{config.commit}.json"
    if path.exists():
        tree = json.loads(path.read_text(encoding="utf-8"))
    else:
        url = f"https://api.github.com/repos/{config.repo}/git/trees/{config.commit}?recursive=1"
        tree = json.loads(fetch(url))
        if tree.get("truncated"):
            raise SystemExit("GitHub cut the mirror's listing short, so a file may only be unlisted: stopping")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(tree), encoding="utf-8")
    return {
        item["path"]: Listed(item["path"], item["size"], item["sha"])
        for item in tree.get("tree", [])
        if item.get("type") == "blob"
    }


def source_url(config: Config, model: Model) -> str:
    return f"{config.raw_base}/{config.commit}/{urllib.parse.quote(model.path)}"


def source_problem(data: bytes, listed: Listed) -> str | None:
    """Why these bytes are not the file GitHub lists, or None when they are."""
    if len(data) != listed.size:
        return f"is {len(data):,} bytes, not the {listed.size:,} GitHub lists"
    blob = git_blob_hash(data)
    if blob != listed.git_blob:
        return f"has the git blob hash {blob}, not {listed.git_blob} as GitHub lists"
    return None


def ensure_source(model: Model, listed: Listed, config: Config, root: Path, fetch: Fetch) -> tuple[Path, bytes]:
    """NASA's file, from `raw/models` if a verified copy is there, else downloaded, verified and kept."""
    path = root / "raw" / "models" / config.commit[:12] / f"{model.id}.glb"
    if path.exists():
        data = path.read_bytes()
        if source_problem(data, listed) is None:
            return path, data
    url = source_url(config, model)
    try:
        data = fetch(url)
    except (OSError, NotThere) as error:
        raise WrongSource(f"{model.id}: could not download {url} ({error or type(error).__name__})") from error
    problem = source_problem(data, listed)
    if problem:
        raise WrongSource(f"{model.id}: the file at {url} {problem}")
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    part.replace(path)
    return path, data


# --- The binary glTF file -------------------------------------------------------------------------------------------

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
TRIANGLES = 4
# Extensions three.js reads only with a decoder that packages/engine/src/modelView.ts does not set up.
NEEDS_DECODER = {
    "KHR_draco_mesh_compression": "a Draco decoder",
    "EXT_meshopt_compression": "a Meshopt decoder",
    "KHR_texture_basisu": "a KTX2 transcoder",
}
IMAGE_SUFFIX = {"image/webp": "webp", "image/png": "png", "image/jpeg": "jpg"}
# How each image type starts: bytes at 0, and more bytes at an offset.
IMAGE_MAGIC = {
    "image/webp": (b"RIFF", 8, b"WEBP"),
    "image/png": (b"\x89PNG\r\n\x1a\n", 0, b""),
    "image/jpeg": (b"\xff\xd8", 0, b""),
}


def read_glb(data: bytes) -> tuple[Json, bytes]:
    """A binary glTF 2.0 file's JSON and its binary chunk."""
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("it does not start as a binary glTF file")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ValueError(f"it is binary glTF version {version}, not 2")
    if length != len(data):
        raise ValueError(f"its header says {length:,} bytes and the file has {len(data):,}")
    doc: object = None
    binary = b""
    at = 12
    while at + 8 <= len(data):
        size, kind = struct.unpack_from("<II", data, at)
        chunk = data[at + 8 : at + 8 + size]
        if len(chunk) != size:
            raise ValueError("a chunk runs past the end of the file")
        if kind == JSON_CHUNK and doc is None:
            try:
                doc = json.loads(chunk)
            except ValueError as error:
                raise ValueError(f"its JSON chunk is not JSON ({error})") from error
        elif kind == BIN_CHUNK and not binary:
            binary = chunk
        at += 8 + size
    if not isinstance(doc, dict):
        raise ValueError("it has no JSON chunk")  # noqa: TRY004 - a bad file, which callers catch as ValueError
    for n, view in enumerate(doc.get("bufferViews", [])):
        if view.get("buffer", 0) != 0 or view.get("byteOffset", 0) + view.get("byteLength", 0) > len(binary):
            raise ValueError(f"bufferView {n} points past the binary chunk")
    return doc, binary


@dataclass(frozen=True)
class Texture:
    name: str
    mime: str
    data: bytes


def textures(doc: Json, binary: bytes) -> list[Texture]:
    """Every image the file carries, in the file's order."""
    views = doc.get("bufferViews", [])
    out = []
    for n, image in enumerate(doc.get("images", [])):
        index = image.get("bufferView")
        if index is None:
            raise ValueError(f"image {n} is not inside the file")
        view = views[index]
        start = view.get("byteOffset", 0)
        data = binary[start : start + view["byteLength"]]
        out.append(Texture(name=str(image.get("name", "")), mime=str(image.get("mimeType", "")), data=data))
    return out


def image_problem(texture: Texture) -> str | None:
    magic = IMAGE_MAGIC.get(texture.mime)
    if magic is None:
        return f"image {texture.name!r} is {texture.mime or 'of no type'}, which the app does not read"
    start, at, more = magic
    if not texture.data.startswith(start) or texture.data[at : at + len(more)] != more:
        return f"image {texture.name!r} is not the {texture.mime} it says it is"
    return None


def geometry_counts(doc: Json) -> Json:
    """How much geometry the file holds: what a person compares before and after simplifying."""
    accessors = doc.get("accessors", [])
    positions: set[int] = set()
    triangles = 0
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            position = primitive.get("attributes", {}).get("POSITION")
            if position is not None:
                positions.add(position)
            if primitive.get("mode", TRIANGLES) != TRIANGLES:
                continue
            corners = primitive.get("indices", position)
            if corners is not None:
                triangles += accessors[corners]["count"] // 3
    return {
        "meshes": len(doc.get("meshes", [])),
        "vertices": sum(accessors[p]["count"] for p in positions),
        "triangles": triangles,
    }


def decoder_problem(doc: Json) -> str | None:
    used = set(doc.get("extensionsUsed", [])) | set(doc.get("extensionsRequired", []))
    for extension in sorted(used & NEEDS_DECODER.keys()):
        return (
            f"it uses {extension}, which needs {NEEDS_DECODER[extension]} that the app's loader "
            "(packages/engine/src/modelView.ts) does not have"
        )
    return None


# --- Optimizing and wrapping ----------------------------------------------------------------------------------------


def optimize_options(settings: Optimize) -> list[str]:
    """
    gltf-transform's `optimize` options. `--compress quantize` matters most: the tool's default, Meshopt, needs a
    decoder in the app. Without a simplify error the tool's own default (0.0001) stands.
    """
    options = ["--compress", "quantize", "--texture-compress", "webp", "--texture-size", str(settings.texture_size)]
    if settings.simplify_error is not None:
        options += ["--simplify-error", f"{settings.simplify_error:g}"]
    return options


Optimizer = Callable[[Path, Path, Optimize], None]


def find(program: str) -> str:
    found = shutil.which(program)
    if found is None:
        raise SystemExit(f"{program} is not on the PATH (the models step needs Node: see pipeline/README.md)")
    return found


def gltf_transform(npx: str, tool: str) -> Optimizer:
    """The optimizer a real build uses: the pinned gltf-transform CLI, through npx."""

    def run(source: Path, out: Path, settings: Optimize) -> None:
        command = [npx, "--yes", tool, "optimize", str(source), str(out), *optimize_options(settings)]
        try:
            done = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=OPTIMIZE_TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise OptimizeFailed(f"gltf-transform did not finish {source.name} in {OPTIMIZE_TIMEOUT_S} s") from error
        if done.returncode != 0 or not out.exists():
            tail = " | ".join((done.stderr or done.stdout).strip().splitlines()[-5:])
            raise OptimizeFailed(f"gltf-transform failed on {source.name} (exit {done.returncode}): {tail}")

    return run


def tool_version(npx: str, tool: str) -> str | None:
    try:
        done = subprocess.run(
            [npx, "--yes", tool, "--version"], capture_output=True, text=True, timeout=600, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    lines = done.stdout.strip().splitlines()
    return lines[-1].strip() if done.returncode == 0 and lines else None


def wrap(glb: bytes) -> bytes:
    """The file the app loads: JSON holding the `.glb` as one base64 string, `{"b64": "..."}`."""
    return json.dumps({"b64": base64.b64encode(glb).decode("ascii")}).encode("ascii")


def unwrap(file: bytes) -> bytes:
    """What the app's loader does with the file, refusing anything else."""
    try:
        holder = json.loads(file)
    except ValueError as error:
        raise ValueError(f"it is not JSON ({error})") from error
    if not isinstance(holder, dict) or set(holder) != {"b64"} or not isinstance(holder["b64"], str):
        raise ValueError('it is not {"b64": "..."}')
    try:
        return base64.b64decode(holder["b64"], validate=True)
    except ValueError as error:
        raise ValueError(f"its b64 is not base64 ({error})") from error


def check_size(model_id: str, size: int, limit: int) -> None:
    if size > limit:
        raise TooBig(
            f"{model_id}: the built file is {size:,} bytes, {size - limit:,} over the {limit:,}-byte limit. Give it a "
            "smaller textureSize or a larger simplifyError in pipeline/configs/models.toml, or leave the model out."
        )


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- Build ----------------------------------------------------------------------------------------------------------


def build_stamp(model: Model, listed: Listed, config: Config) -> Json:
    """What a build depends on: when all of it is unchanged, so is the file, and the build is skipped."""
    return {
        "gitBlob": listed.git_blob,
        "options": optimize_options(model.optimize),
        "tool": config.tool,
        "limitBytes": config.limit_bytes,
    }


def read_state(root: Path, model: Model) -> Json | None:
    path = state_path(root, model)
    if not path.exists():
        return None
    state: Json = json.loads(path.read_text(encoding="utf-8"))
    return state


def unchanged(root: Path, model: Model, stamp: Json) -> Json | None:
    """The last build's state, if it was built from the same things and its file is still the one it wrote."""
    state = read_state(root, model)
    out = out_path(root, model)
    if state is None or state.get("stamp") != stamp or state.get("error") or not out.exists():
        return None
    return state if sha256_of(out.read_bytes()) == state.get("sha256") else None


def write_textures(model_id: str, images: list[Texture], root: Path) -> list[Json]:
    folder = work_dir(root) / "textures" / model_id
    if folder.exists():
        shutil.rmtree(folder)
    out = []
    for n, image in enumerate(images):
        name = f"{n:02d}.{IMAGE_SUFFIX.get(image.mime, 'bin')}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(image.data)
        out.append({"file": name, "name": image.name, "mime": image.mime, "bytes": len(image.data)})
    return out


def build_model(
    model: Model, listed: Listed | None, config: Config, root: Path, fetch: Fetch, optimize: Optimizer, force: bool
) -> Json:
    """Builds one model, records its state, and returns it; `error` says why if it did not come out."""
    entry: Json = {"id": model.id, "key": model.key, "options": optimize_options(model.optimize), "error": None}
    if listed is None:
        entry["error"] = f"{model.id}: the mirror has no file {model.path!r} at commit {config.commit[:12]}"
        return entry
    stamp = build_stamp(model, listed, config)
    entry["stamp"] = stamp
    entry["source"] = {
        "url": source_url(config, model),
        "path": listed.path,
        "bytes": listed.size,
        "gitBlob": listed.git_blob,
    }
    if not force and (state := unchanged(root, model, stamp)) is not None:
        return {**state, "skipped": True}
    out = out_path(root, model)
    out.unlink(missing_ok=True)
    try:
        source_path, source = ensure_source(model, listed, config, root, fetch)
        entry["source"]["sha256"] = sha256_of(source)
        try:
            entry["source"]["geometry"] = geometry_counts(read_glb(source)[0])
        except ValueError as error:
            raise WrongSource(f"{model.id}: NASA's file cannot be read as binary glTF: {error}") from error
        glb_path = work_dir(root) / "glb" / f"{model.id}.glb"
        glb_path.parent.mkdir(parents=True, exist_ok=True)
        glb_path.unlink(missing_ok=True)
        optimize(source_path, glb_path, model.optimize)
        if not glb_path.exists():
            raise OptimizeFailed(f"{model.id}: the optimizer wrote no file")
        glb = glb_path.read_bytes()
        try:
            doc, binary = read_glb(glb)
            images = textures(doc, binary)
        except ValueError as error:
            raise NotLoadable(f"{model.id}: the optimized file cannot be read: {error}") from error
        entry["glbBytes"] = len(glb)
        entry["geometry"] = geometry_counts(doc)
        entry["extensionsRequired"] = sorted(doc.get("extensionsRequired", []))
        if problem := decoder_problem(doc):
            raise NotLoadable(f"{model.id}: the optimized file {problem}")
        entry["textures"] = write_textures(model.id, images, root)
        file = wrap(glb)
        entry["bytes"] = len(file)
        entry["sha256"] = sha256_of(file)
        check_size(model.id, len(file), config.limit_bytes)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(file)
    except ModelError as error:
        entry["error"] = str(error)
    path = state_path(root, model)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entry, indent=1) + "\n", encoding="utf-8")
    return entry


def git_state(root: Path) -> tuple[str | None, bool | None]:
    """The repository's commit, and whether the working tree differs from it."""
    try:
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True)
        status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None, None
    return commit.stdout.strip(), bool(status.stdout.strip())


def build(
    config: Config,
    ids: Iterable[str],
    root: Path,
    fetch: Fetch,
    optimize: Optimizer,
    version: str | None = None,
    force: bool = False,
) -> Json:
    """Builds the models and writes the run's manifest: what was read, what came out, and what did not and why."""
    wanted = list(ids)
    for model_id in wanted:
        if model_id not in config.models:
            raise SystemExit(f"{model_id} is not in pipeline/configs/models.toml")
    listing = mirror_listing(config, root, fetch)
    commit, dirty = git_state(root)
    run: Json = {
        "step": "siteline_pipeline.models build",
        "datasetId": config.dataset_id,
        "repo": config.repo,
        "commit": config.commit,
        "licence": config.licence,
        "citation": config.citation,
        "tool": config.tool,
        "toolVersion": version,
        "limitBytes": config.limit_bytes,
        "builtUtc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "gitCommit": commit,
        "gitDirty": dirty,
        "models": [
            build_model(config.models[i], listing.get(config.models[i].path), config, root, fetch, optimize, force)
            for i in wanted
        ],
    }
    path = work_dir(root) / "run-manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(run, indent=1) + "\n", encoding="utf-8")
    return run


# --- The manifest in git --------------------------------------------------------------------------------------------


def manifest(config: Config, root: Path, recorded: Json | None = None) -> Json:
    """
    `data/models.json`: what the app may know about each model the config does not reject. Sizes and checksums come
    from the builds here; a model not built here keeps what the manifest already records for the same key and settings,
    or has none.
    """
    old = {m["id"]: m for m in (recorded or {}).get("models", [])}
    models = []
    for model in config.models.values():
        if model.rejected:
            continue
        state = read_state(root, model) or {}
        before = old.get(model.id, {})
        size: int | None = None
        sha: str | None = None
        source: Json = {"path": model.path, "bytes": None, "gitBlob": None}
        if not state.get("error") and state.get("key") == model.key and "sha256" in state:
            size, sha = state["bytes"], state["sha256"]
            source = {k: state["source"][k] for k in ("path", "bytes", "gitBlob")}
        elif before.get("key") == model.key and before.get("optimize") == model.optimize.as_json():
            size, sha, source = before.get("bytes"), before.get("sha256"), before.get("source", source)
        models.append(
            {
                "id": model.id,
                "name": model.name,
                "sourceUrl": model.source_url,
                "credit": model.credit,
                "status": model.status,
                "statusSource": model.status_source,
                "statusNote": model.status_note,
                "mission": model.mission,
                "logoChecked": model.logo_checked,
                "logoCheck": model.logo_check,
                "note": model.note,
                "key": model.key,
                "bytes": size,
                "sha256": sha,
                "source": source,
                "optimize": model.optimize.as_json(),
            }
        )
    return {
        "format": FORMAT,
        "note": (
            "Written by siteline_pipeline.models from pipeline/configs/models.toml and the builds: edit the config, "
            "not this file. bytes and sha256 are of the published file; null where none has been built."
        ),
        "dataset": config.dataset_id,
        "baseUrl": config.public_base,
        "limitBytes": config.limit_bytes,
        "mirror": {"repo": config.repo, "commit": config.commit},
        "tool": config.tool,
        "models": models,
    }


def write_manifest(config: Config, root: Path, path: Path = MANIFEST_PATH) -> Json:
    recorded = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    data = manifest(config, root, recorded)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return data


# --- Verify ---------------------------------------------------------------------------------------------------------


def verify_file(data: bytes, limit: int) -> list[str]:
    """Every reason this file is not one the app can load, short of parsing it with three.js."""
    problems = []
    if len(data) > limit:
        problems.append(f"it is {len(data):,} bytes, over the {limit:,}-byte limit")
    try:
        doc, binary = read_glb(unwrap(data))
    except ValueError as error:
        return [*problems, str(error)]
    if problem := decoder_problem(doc):
        problems.append(problem)
    try:
        problems += [p for t in textures(doc, binary) if (p := image_problem(t))]
    except (ValueError, IndexError, KeyError) as error:
        problems.append(f"its images cannot be read ({error})")
    if not doc.get("meshes"):
        problems.append("it has no meshes")
    return problems


def parse_with_three(node: str, files: list[Path]) -> dict[str, str | None]:
    """Each file parsed by three.js's GLTFLoader in Node (`parse_glb.mjs`): None where it parsed, else why not."""
    if not files:
        return {}
    done = subprocess.run(
        [node, str(PARSE_SCRIPT), *map(str, files)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
        check=False,
    )
    results: dict[str, str | None] = {}
    for line in done.stdout.splitlines():
        if line.startswith("{"):
            row = json.loads(line)
            results[row["file"]] = None if row["ok"] else row["error"]
    for file in files:
        if str(file) not in results:
            tail = " | ".join(done.stderr.strip().splitlines()[-3:])
            results[str(file)] = f"parse_glb.mjs gave no answer (exit {done.returncode}): {tail}"
    return results


def verify(config: Config, root: Path, node: str, ids: Iterable[str] | None = None) -> tuple[list[str], bool]:
    """Checks every built file. A model that is not rejected and is not built, or fails a check, fails the run."""
    lines: list[str] = []
    right = True
    built: list[tuple[Model, Path]] = []
    for model_id in ids or config.models:
        model = config.models[model_id]
        path = out_path(root, model)
        if path.exists():
            built.append((model, path))
        elif model.rejected:
            lines.append(f"{model.id}: not built (rejected, so not needed)")
        else:
            right = False
            lines.append(f"{model.id}: FAILED: {model.key} is not built")
    parsed = parse_with_three(node, [p for _, p in built])
    for model, path in built:
        data = path.read_bytes()
        problems = verify_file(data, config.limit_bytes)
        if parsed[str(path)] is not None:
            problems.append(f"three.js's GLTFLoader refused it: {parsed[str(path)]}")
        if problems:
            right = False
            lines.append(f"{model.id}: FAILED: " + "; ".join(problems))
        else:
            lines.append(f"{model.id}: ok, {len(data):,} bytes, parses with three.js's GLTFLoader")
    return lines, right


# --- Upload ---------------------------------------------------------------------------------------------------------


def upload_plan(config: Config, root: Path, recorded: Json) -> tuple[list[Model], list[str]]:
    """The models to send, and why each other one is not sent."""
    by_id = {m["id"]: m for m in recorded.get("models", [])}
    send, left_out = [], []
    for model in config.models.values():
        path = out_path(root, model)
        entry = by_id.get(model.id, {})
        if model.rejected:
            left_out.append(f"{model.id}: rejected. {model.rejected}")
        elif not model.logo_checked:
            left_out.append(f"{model.id}: its logo check is not recorded (logoChecked is false)")
        elif not path.exists():
            left_out.append(f"{model.id}: {model.key} is not built here")
        elif entry.get("key") != model.key or entry.get("sha256") != sha256_of(path.read_bytes()):
            left_out.append(f"{model.id}: data/models.json does not record this build (run the manifest command)")
        else:
            send.append(model)
    return send, left_out


def rclone_sizes(rclone: str, remote: str, prefix: str) -> dict[str, int]:
    """Size of each object under a prefix of the bucket (`rclone lsl`), keyed by its name below the prefix."""
    done = subprocess.run(
        [rclone, "lsl", f"{remote}/{prefix}"], capture_output=True, text=True, timeout=300, check=False
    )
    if done.returncode != 0:
        if "directory not found" in done.stderr:
            return {}
        raise SystemExit(f"rclone lsl {remote}/{prefix} failed (exit {done.returncode})")
    sizes = {}
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 4 and parts[0].isdigit():
            sizes[" ".join(parts[3:])] = int(parts[0])
    return sizes


def upload(config: Config, root: Path, models: list[Model], rclone: str, dry_run: bool) -> tuple[list[str], bool]:
    """
    Sends each file with `rclone copyto --immutable`, which refuses to replace an object that differs, then lists the
    bucket to check each size. Only the remote's name is passed to rclone; rclone's config is never read here.
    """
    lines, right = [], True
    for model in models:
        path = out_path(root, model)
        target = f"{config.remote}/{model.key}"
        command = [
            rclone,
            "copyto",
            str(path),
            target,
            "--immutable",
            "--s3-no-check-bucket",
            "--header-upload",
            f"Cache-Control: {CACHE_CONTROL}",
            "--header-upload",
            "Content-Type: application/json",
        ]
        if dry_run:
            command.append("--dry-run")
        done = subprocess.run(command, capture_output=True, text=True, timeout=900, check=False)
        if done.returncode != 0:
            right = False
            tail = " | ".join(done.stderr.strip().splitlines()[-3:])
            lines.append(f"{model.id}: FAILED to send {path.name} to {target} (exit {done.returncode}): {tail}")
            continue
        verb = "would send" if dry_run else "sent"
        lines.append(
            f"{model.id}: {verb} {path.stat().st_size:,} bytes to {target} -> {config.public_base}/{model.key}"
        )
    if not dry_run:
        for version in sorted({m.version for m in models}):
            listed = rclone_sizes(rclone, config.remote, f"models/v{version}/")
            for model in (m for m in models if m.version == version):
                want = out_path(root, model).stat().st_size
                got = listed.get(f"{model.id}.json")
                if got != want:
                    right = False
                    lines.append(f"{model.id}: FAILED: the bucket holds {got} bytes, not {want:,}")
                else:
                    lines.append(f"{model.id}: checked in the bucket with rclone lsl, {got:,} bytes")
    return lines, right


# --- Command line ---------------------------------------------------------------------------------------------------


def report(run: Json) -> list[str]:
    lines = []
    for built in run["models"]:
        size = f"{built['bytes']:>10,} bytes" if "bytes" in built else " " * 16
        if built.get("error"):
            what = "FAILED: " + built["error"]
        else:
            what = "unchanged, skipped" if built.get("skipped") else "built"
        lines.append(f"{built['id']:<22} {size}  {what}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m siteline_pipeline.models", description=(__doc__ or "").split("\n")[0]
    )
    commands = parser.add_subparsers(dest="command", required=True)
    build_command = commands.add_parser("build", help="download, optimize and wrap the models")
    build_command.add_argument("--only", nargs="+", metavar="ID", help="only these models")
    build_command.add_argument("--force", action="store_true", help="rebuild even what is unchanged")
    verify_command = commands.add_parser("verify", help="check every built file, with three.js's GLTFLoader")
    verify_command.add_argument("--only", nargs="+", metavar="ID", help="only these models")
    commands.add_parser("manifest", help="write data/models.json from the config and the builds")
    upload_command = commands.add_parser("upload", help="send the published files to the bucket (a person runs this)")
    upload_command.add_argument("--dry-run", action="store_true", help="say what would be sent; send nothing")
    args = parser.parse_args(argv)
    config = load_config()

    if args.command == "build":
        npx = find("npx")
        run = build(
            config,
            args.only or config.models,
            PIPELINE,
            http_get,
            gltf_transform(npx, config.tool),
            tool_version(npx, config.tool),
            args.force,
        )
        for line in report(run):
            print(line)
        write_manifest(config, PIPELINE)
        print(f"run manifest: {work_dir(PIPELINE) / 'run-manifest.json'}")
        print(f"manifest:     {MANIFEST_PATH}")
        return 1 if any(built.get("error") for built in run["models"]) else 0

    if args.command == "manifest":
        data = write_manifest(config, PIPELINE)
        print(f"{MANIFEST_PATH}: {len(data['models'])} models")
        return 0

    if args.command == "verify":
        lines, right = verify(config, PIPELINE, find("node"), args.only)
        for line in lines:
            print(line)
        return 0 if right else 1

    lines, right = verify(config, PIPELINE, find("node"))
    if not right:
        for line in lines:
            print(line)
        print("verify failed: nothing sent")
        return 1
    send, left_out = upload_plan(config, PIPELINE, json.loads(MANIFEST_PATH.read_text(encoding="utf-8")))
    lines, right = upload(config, PIPELINE, send, find("rclone"), args.dry_run)
    for line in [*lines, *(f"not sent: {why}" for why in left_out)]:
        print(line)
    return 0 if right else 1


if __name__ == "__main__":
    sys.exit(main())
