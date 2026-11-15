# pipeline/

Python 3.13 with uv. The rules for every step are in [CLAUDE.md](CLAUDE.md); how to run the other steps is in the
repository's README.

## NASA 3D models

`siteline_pipeline.models` turns models from NASA's 3D Resources collection into files the lander cards can load, and
publishes them to the bucket `siteline-terrain` from the pipeline VM. It is driven by one file,
[`configs/models.toml`](configs/models.toml), which lists each model, how it is optimized, and what is said about it.

| Command                                  | What it does                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build [--only ID ...] [--force]`        | Downloads each `.glb` from NASA's mirror at the pinned commit, checks it against GitHub's size and git blob hash, optimizes it, wraps it as `{"b64": "..."}`, and fails a model whose file is over 5 MiB. Skips a model whose source, settings and output have not changed. Writes `data/models.json`. |
| `verify [--only ID ...]`                 | Checks every built file: size, wrapper, binary glTF structure, no extension that needs a decoder, WebP bytes, and a parse with three.js's GLTFLoader at the app's version with no Draco decoder. Any failure fails the run. |
| `manifest`                               | Writes `data/models.json` from the config and the builds, without building.                                                                                                                                  |
| `upload --dry-run`                       | Runs `verify`, then shows what `upload` would send and where, sending nothing.                                                                                                                               |
| `upload`                                 | Runs `verify`, sends each published file with `rclone copyto --immutable` (it never replaces a file already there), then checks each size in the bucket with `rclone lsl`. **A person runs this.**          |

Only the `.json` files of models that are not `rejected` and whose `logoChecked` is true are sent: never NASA's
downloads, the optimized `.glb`s or the textures. The step passes the remote's name (`r2:`) to rclone and never reads
rclone's config or any token.

Files on the VM, under `pipeline/` of the clone (none of them go in git):

- `raw/models/`: NASA's downloads and GitHub's listing of the mirror.
- `out/models/v1/<id>.json`: the files to publish, at their bucket key.
- `out/models/work/`: the optimized `.glb`s and their textures (`textures/<id>/`), to look at before publishing; each
  model's build state; and `run-manifest.json`, which records the inputs, their checksums, the licence, the tool and
  the git commit of the run.

### Runbook: from a fresh clone to the bucket, on the VM

```sh
ssh -i ~/.ssh/siteline_pipeline ubuntu@82.70.211.62

# 1. A fresh clone in its own folder (leave ~/Siteline, the old checkout, alone).
cd ~/work
git clone -b main https://github.com/1khaled-ctrl/Siteline.git siteline-models
cd siteline-models

# 2. The app's three.js, for verify's parse check (the VM does not need the app's other packages).
npm install --no-audit --no-fund --prefix ~/work/three-r187 three@"$(node -p 'require("./packages/engine/package.json").dependencies.three')"
export THREE_DIR=~/work/three-r187/node_modules/three

# 3. Build and check. Python 3.11 or newer with only its standard library; uv works too:
#    ~/.local/bin/uv run --no-project python -m siteline_pipeline.models build
cd pipeline
python3 -m siteline_pipeline.models build
python3 -m siteline_pipeline.models verify

# 4. Look at what will be published: textures for logos, and the models themselves.
ls -l out/models/v1/ out/models/work/textures/*/

# 5. Send nothing yet: see what would go where.
python3 -m siteline_pipeline.models upload --dry-run

# 6. Publish (a person, after the PR is reviewed and merged).
python3 -m siteline_pipeline.models upload
```

`upload` prints each file's size and public address, `https://pub-950982926f534224a9e16061b39f6217.r2.dev/models/v1/<id>.json`,
and then the size `rclone lsl` reports for it. To look yourself:

```sh
rclone lsl r2:siteline-terrain/models/v1/
curl -sI https://pub-950982926f534224a9e16061b39f6217.r2.dev/models/v1/lro_b.json | head -5
```

### Rolling back

A published file is never replaced, so taking one back is deleting it. The app then has nothing to load for that model,
so first set `rejected = "<why>"` on it in `configs/models.toml` (that leaves it out of `data/models.json`) and merge
that, then delete the file:

```sh
rclone deletefile r2:siteline-terrain/models/v1/<id>.json
rclone lsl r2:siteline-terrain/models/v1/
```

### Adding or changing a model

No code changes: one table in `configs/models.toml` and one row in `CREDITS.md`.

1. Find the model in the mirror at the pinned commit (`commit` in the config). It must be a `.glb`: models that exist
   only as `.blend`, `.3ds` or `.lwo` cannot be used. Only NASA's own collection: no models from other agencies,
   companies or marketplaces.
2. Open its page on `science.nasa.gov/3d-resources/` and read it. Copy the credit line from its "Source" field exactly.
   Set `status` to "flew", "prototype" or "concept" only when a NASA page says so, and give that page as
   `statusSource` and what it says as `statusNote`; otherwise "being checked". `mission` is its id in
   `data/missions.json`, or "none": never a made-up mission.
3. Add a `[models.<id>]` table (the fields are explained at the top of the config) with `logoChecked = false`, then
   build it: `python3 -m siteline_pipeline.models build --only <id>`.
4. Look at every texture in `out/models/work/textures/<id>/` and at the model. If any shows the NASA insignia (the
   "meatball"), the NASA logotype (the "worm"), the NASA seal or another organisation's logo, set
   `rejected = "<what it shows>"`. Otherwise set `logoChecked = true` and describe the check in `logoCheck`.
5. If the build fails the size gate, give it a smaller `textureSize` (512) or a `simplifyError` (0.005), build again
   and look at it again. If it still fails or looks poor, leave it out.
6. Add its row to `CREDITS.md` under `nasa-3d-resources`, run `python3 -m siteline_pipeline.models manifest`, and open a
   PR with the config, `data/models.json` and `CREDITS.md`. Copy `data/models.json` back from the VM with
   `scp -i ~/.ssh/siteline_pipeline ubuntu@82.70.211.62:work/siteline-models/data/models.json data/`.
7. After the PR is merged, `upload --dry-run`, then `upload`.

To change a model that is already published, raise its `version`: the new build goes to `models/v2/<id>.json` and the
old file stays where it is.

### Tests

```sh
cd pipeline
uv run pytest tests/test_models.py   # the parse checks run when Node and `corepack pnpm install` are there
uv run ruff check . && uv run ruff format --check . && uv run mypy siteline_pipeline/models.py tests/test_models.py
```
