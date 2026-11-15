import base64
import copy
import json
import shutil
import struct
from pathlib import Path
from typing import Any

import pytest

from siteline_pipeline import models
from siteline_pipeline.models import (
    Listed,
    Optimize,
    build,
    check_size,
    git_blob_hash,
    load_config,
    manifest,
    optimize_options,
    parse_config,
    parse_with_three,
    read_glb,
    unwrap,
    upload_plan,
    verify,
    verify_file,
    wrap,
)

COMMIT = "11ebb4ee043715aefbba6aeec8a61746fad67fa7"
LIMIT = 5_242_880


def glb(extensions_required: list[str] | None = None, image: bytes | None = None) -> bytes:
    """A binary glTF file holding one triangle, with float positions: the smallest file three.js will show."""
    positions = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    binary = positions + (image or b"")
    binary += b"\0" * (-len(binary) % 4)
    doc: dict[str, Any] = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(positions)}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]}
        ],
    }
    if image is not None:
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(positions), "byteLength": len(image)})
        doc["images"] = [{"bufferView": 1, "mimeType": "image/webp", "name": "tex"}]
        doc["textures"] = [{"source": 0}]
        doc["materials"] = [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}}}]
        doc["meshes"][0]["primitives"][0]["material"] = 0
    if extensions_required:
        doc["extensionsUsed"] = doc["extensionsRequired"] = extensions_required
    text = json.dumps(doc).encode()
    text += b" " * (-len(text) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text + struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def model_table(**changes: Any) -> dict[str, Any]:
    table: dict[str, Any] = {
        "folder": "Thing",
        "file": "Thing.glb",
        "name": "Thing",
        "sourceUrl": "https://science.nasa.gov/3d-resources/thing/",
        "credit": "NASA/Someone",
        "status": "being checked",
        "mission": "none",
        "logoChecked": True,
        "logoCheck": "looked at",
    }
    table.update(changes)
    return {k: v for k, v in table.items() if v is not None}


def raw_config(**tables: dict[str, Any]) -> dict[str, Any]:
    return {
        "datasetId": "nasa-3d-resources",
        "repo": "nasa/NASA-3D-Resources",
        "commit": COMMIT,
        "rawBase": "https://raw.example/nasa",
        "tool": "@gltf-transform/cli@4.5.1",
        "remote": "r2:siteline-terrain",
        "publicBase": "https://pub.example.r2.dev",
        "limitBytes": LIMIT,
        "licence": "free",
        "citation": "NASA",
        "defaults": {"textureSize": 1024},
        "models": tables or {"thing": model_table()},
    }


def config_of(**tables: dict[str, Any]) -> models.Config:
    return parse_config(raw_config(**tables), {"insight"})


class Mirror:
    """GitHub's listing and NASA's files, served from memory."""

    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.calls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.calls.append(url)
        if "api.github.com" in url:
            tree = [{"path": p, "type": "blob", "size": len(d), "sha": git_blob_hash(d)} for p, d in self.files.items()]
            return json.dumps({"sha": COMMIT, "truncated": False, "tree": tree}).encode()
        for path, data in self.files.items():
            if url.endswith(models.urllib.parse.quote(path)):
                return data
        raise models.NotThere(url)


def copy_optimizer(calls: list[Optimize]) -> models.Optimizer:
    def run(source: Path, out: Path, settings: Optimize) -> None:
        calls.append(settings)
        shutil.copyfile(source, out)

    return run


# --- The config -----------------------------------------------------------------------------------------------------


def test_the_real_config_reads_and_every_model_has_a_nasa_page_and_a_credit() -> None:
    config = load_config()
    assert config.limit_bytes == 5 * 1024 * 1024
    for model in config.models.values():
        assert model.source_url.startswith("https://science.nasa.gov/3d-resources/")
        assert model.credit.startswith("NASA/")
        assert model.key == f"models/v1/{model.id}.json"


def test_a_model_without_a_credit_line_is_refused() -> None:
    with pytest.raises(ValueError, match="models.thing.credit is missing"):
        config_of(thing=model_table(credit=None))
    with pytest.raises(ValueError, match="models.thing.credit is missing"):
        config_of(thing=model_table(credit="  "))


def test_a_model_without_a_nasa_page_is_refused() -> None:
    with pytest.raises(ValueError, match="sourceUrl is missing"):
        config_of(thing=model_table(sourceUrl=None))
    with pytest.raises(ValueError, match="is not a NASA page"):
        config_of(thing=model_table(sourceUrl="https://sketchfab.com/thing"))
    with pytest.raises(ValueError, match="is not a NASA page"):
        config_of(thing=model_table(sourceUrl="https://nasa.gov.example.com/thing"))


def test_a_status_other_than_being_checked_needs_the_page_that_says_so() -> None:
    with pytest.raises(ValueError, match='status "flew" needs the NASA page'):
        config_of(thing=model_table(status="flew"))
    flew = config_of(
        thing=model_table(status="flew", statusSource="https://science.nasa.gov/mission/lro/", statusNote="launched")
    )
    assert flew.models["thing"].status == "flew"
    with pytest.raises(ValueError, match="one of flew, prototype, concept, being checked"):
        config_of(thing=model_table(status="landed"))


def test_a_mission_must_be_in_the_missions_file_and_none_means_none() -> None:
    assert config_of(thing=model_table(mission="insight")).models["thing"].mission == "insight"
    assert config_of(thing=model_table()).models["thing"].mission is None
    with pytest.raises(ValueError, match="mission 'orion' is not in data/missions.json"):
        config_of(thing=model_table(mission="orion"))


def test_misspelt_fields_and_files_that_are_not_glb_are_refused() -> None:
    with pytest.raises(ValueError, match="models.thing.credits is not a field"):
        config_of(thing=model_table(credits="NASA"))
    with pytest.raises(ValueError, match="is not a .glb file"):
        config_of(thing=model_table(file="Curiosity.blend"))
    with pytest.raises(ValueError, match="an id is lower-case"):
        config_of(**{"Thing-1": model_table()})


def test_the_options_are_the_hand_commands() -> None:
    assert optimize_options(Optimize(1024)) == [
        "--compress",
        "quantize",
        "--texture-compress",
        "webp",
        "--texture-size",
        "1024",
    ]
    assert optimize_options(Optimize(512, 0.005))[-4:] == ["--texture-size", "512", "--simplify-error", "0.005"]


# --- Build ----------------------------------------------------------------------------------------------------------


def test_a_build_wraps_the_optimized_file_and_skips_it_when_nothing_changed(tmp_path: Path) -> None:
    config = config_of()
    nasa = glb()
    mirror = Mirror({"3D Models/Thing/Thing.glb": nasa})
    calls: list[Optimize] = []
    run = build(config, ["thing"], tmp_path, mirror, copy_optimizer(calls))
    built = run["models"][0]
    assert built["error"] is None
    out = tmp_path / "out" / "models" / "v1" / "thing.json"
    assert unwrap(out.read_bytes()) == nasa
    assert built["bytes"] == out.stat().st_size and built["source"]["gitBlob"] == git_blob_hash(nasa)

    again = build(config, ["thing"], tmp_path, mirror, copy_optimizer(calls))
    assert again["models"][0]["skipped"] is True and len(calls) == 1

    smaller = config_of(thing=model_table(textureSize=512))
    build(smaller, ["thing"], tmp_path, mirror, copy_optimizer(calls))
    assert len(calls) == 2 and calls[-1].texture_size == 512


def test_the_size_gate_fails_an_oversize_file_and_writes_nothing_to_upload(tmp_path: Path) -> None:
    with pytest.raises(models.TooBig, match=r"5,242,881 bytes, 1 over the 5,242,880-byte limit"):
        check_size("thing", LIMIT + 1, LIMIT)
    check_size("thing", LIMIT, LIMIT)

    def bloat(source: Path, out: Path, settings: Optimize) -> None:
        out.write_bytes(glb(image=b"RIFF\0\0\0\0WEBP" + bytes(4_000_000)))

    run = build(config_of(), ["thing"], tmp_path, Mirror({"3D Models/Thing/Thing.glb": glb()}), bloat)
    assert "over the 5,242,880-byte limit" in run["models"][0]["error"]
    assert not (tmp_path / "out" / "models" / "v1" / "thing.json").exists()


def test_a_download_that_is_not_the_listed_file_is_refused(tmp_path: Path) -> None:
    mirror = Mirror({"3D Models/Thing/Thing.glb": glb()})
    build(config_of(), ["thing"], tmp_path, mirror, copy_optimizer([]))  # writes the listing
    mirror.files["3D Models/Thing/Thing.glb"] = glb() + b"tampered"
    shutil.rmtree(tmp_path / "raw" / "models" / COMMIT[:12])
    run = build(config_of(), ["thing"], tmp_path, mirror, copy_optimizer([]), force=True)
    assert "not the" in run["models"][0]["error"] and "GitHub lists" in run["models"][0]["error"]


def test_a_draco_file_out_of_the_optimizer_is_refused(tmp_path: Path) -> None:
    def keep_draco(source: Path, out: Path, settings: Optimize) -> None:
        out.write_bytes(glb(["KHR_draco_mesh_compression"]))

    run = build(config_of(), ["thing"], tmp_path, Mirror({"3D Models/Thing/Thing.glb": glb()}), keep_draco)
    assert "needs a Draco decoder" in run["models"][0]["error"]


# --- The manifest ---------------------------------------------------------------------------------------------------


def test_the_manifest_leaves_out_rejected_models_and_carries_the_built_size(tmp_path: Path) -> None:
    config = config_of(thing=model_table(), logo=model_table(logoChecked=False, rejected="shows the NASA insignia"))
    build(config, ["thing"], tmp_path, Mirror({"3D Models/Thing/Thing.glb": glb()}), copy_optimizer([]))
    data = manifest(config, tmp_path)
    assert [m["id"] for m in data["models"]] == ["thing"]
    entry = data["models"][0]
    assert entry["bytes"] == (tmp_path / "out" / "models" / "v1" / "thing.json").stat().st_size
    assert entry["credit"] == "NASA/Someone" and entry["status"] == "being checked" and entry["mission"] is None


def test_the_manifest_in_git_matches_the_config() -> None:
    config = load_config()
    recorded = json.loads(models.MANIFEST_PATH.read_text(encoding="utf-8"))
    assert recorded["limitBytes"] == config.limit_bytes and recorded["baseUrl"] == config.public_base
    shown = [m for m in config.models.values() if not m.rejected]
    assert [m["id"] for m in recorded["models"]] == [m.id for m in shown]
    for entry, model in zip(recorded["models"], shown, strict=True):
        assert (entry["credit"], entry["sourceUrl"], entry["status"]) == (model.credit, model.source_url, model.status)
        assert entry["bytes"] is None or entry["bytes"] <= config.limit_bytes


def test_only_checked_recorded_builds_are_sent(tmp_path: Path) -> None:
    config = config_of(
        thing=model_table(),
        unchecked=model_table(folder="U", file="U.glb", logoChecked=False),
        logo=model_table(folder="L", file="L.glb", logoChecked=False, rejected="shows the NASA insignia"),
    )
    files = {"3D Models/Thing/Thing.glb": glb(), "3D Models/U/U.glb": glb(), "3D Models/L/L.glb": glb()}
    build(config, list(config.models), tmp_path, Mirror(files), copy_optimizer([]))
    recorded = manifest(config, tmp_path)
    send, left_out = upload_plan(config, tmp_path, recorded)
    assert [m.id for m in send] == ["thing"]
    assert any("logoChecked is false" in why for why in left_out) and any("rejected" in why for why in left_out)

    stale = copy.deepcopy(recorded)
    stale["models"][0]["sha256"] = "0" * 64
    assert upload_plan(config, tmp_path, stale)[0] == []


# --- Verify ---------------------------------------------------------------------------------------------------------


def test_verify_passes_a_good_file_and_names_what_is_wrong_with_a_bad_one() -> None:
    assert verify_file(wrap(glb()), LIMIT) == []
    assert verify_file(b"not json", LIMIT) == ["it is not JSON (Expecting value: line 1 column 1 (char 0))"]
    assert verify_file(b'{"b64": "%%%"}', LIMIT)[0].startswith("its b64 is not base64")
    truncated = glb()[:-8]
    assert "header says" in verify_file(json.dumps({"b64": base64.b64encode(truncated).decode()}).encode(), LIMIT)[0]
    assert "needs a Draco decoder" in verify_file(wrap(glb(["KHR_draco_mesh_compression"])), LIMIT)[0]
    assert "not the image/webp" in verify_file(wrap(glb(image=b"\x89PNG not webp")), LIMIT)[0]
    assert "over the 100-byte limit" in verify_file(wrap(glb()), 100)[0]


def test_read_glb_refuses_a_buffer_view_past_the_end() -> None:
    doc, _ = read_glb(glb())
    assert doc["bufferViews"][0]["byteLength"] == 36
    data = glb().replace(b'"byteLength": 36}', b'"byteLength": 99}')
    with pytest.raises(ValueError, match="bufferView 0 points past the binary chunk"):
        read_glb(data)


def node_and_three() -> str | None:
    node = shutil.which("node")
    three = models.REPO / "packages" / "engine" / "node_modules" / "three" / "package.json"
    return node if node and three.exists() else None


needs_three = pytest.mark.skipif(node_and_three() is None, reason="needs Node and `corepack pnpm install`")


@needs_three
def test_three_parses_a_good_file_and_refuses_draco_without_a_decoder(tmp_path: Path) -> None:
    node = node_and_three()
    assert node is not None
    good, draco, broken = tmp_path / "good.json", tmp_path / "draco.json", tmp_path / "broken.json"
    good.write_bytes(wrap(glb(image=b"RIFF\0\0\0\0WEBPVP8 ")))
    draco.write_bytes(wrap(glb(["KHR_draco_mesh_compression"])))
    broken.write_bytes(wrap(glb()[:40]))
    results = parse_with_three(node, [good, draco, broken])
    assert results[str(good)] is None
    assert "No DRACOLoader instance provided" in (results[str(draco)] or "")
    assert results[str(broken)]


@needs_three
def test_verify_fails_the_run_on_a_corrupt_file(tmp_path: Path) -> None:
    node = node_and_three()
    assert node is not None
    config = config_of(thing=model_table())
    out = tmp_path / "out" / "models" / "v1" / "thing.json"
    out.parent.mkdir(parents=True)
    out.write_bytes(wrap(glb()))
    lines, right = verify(config, tmp_path, node)
    assert right and "parses with three.js's GLTFLoader" in lines[0]
    out.write_bytes(wrap(glb())[:-20] + b'"}')
    lines, right = verify(config, tmp_path, node)
    assert not right and "FAILED" in lines[0]


def test_a_model_that_should_be_published_but_is_not_built_fails_verify(tmp_path: Path) -> None:
    lines, right = verify(config_of(), tmp_path, "node")
    assert not right and lines == ["thing: FAILED: models/v1/thing.json is not built"]


def test_listing_entries_are_what_the_build_checks_against() -> None:
    data = glb()
    assert models.source_problem(data, Listed("p", len(data), git_blob_hash(data))) is None
    assert "GitHub lists" in (models.source_problem(data, Listed("p", len(data), "0" * 40)) or "")
