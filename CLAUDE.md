# SiteLine: rules for every Claude session

SiteLine is a 3D web app for the NASA Space Apps 2026 Lunar Landing Site Navigator challenge. You fly from the solar system down to a landing site, click a spot, and get a pass or fail for the stay: is the Sun up, is Earth in view, how steep is it, where is the ice, and what breaks if the launch slips.

Six Claude sessions build SiteLine in parallel, one per role, and people review every merge. Read `docs/contracts.md` next, then the CLAUDE.md in each folder you own.

## Ownership

Edit only your role's folders. For anything else, open an issue for its owner. Only the integrator changes contracts (`packages/contracts`) and shared files (the root `package.json`, lockfiles and `.github/`).

| Role                             | Slug    | Owns                                                                                           |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| 3D world                         | world   | `packages/engine`                                                                              |
| Orbits                           | orbits  | `packages/physics/orbits`, `pipeline/.../ephemeris.py`                                         |
| Terrain and light                | light   | `packages/physics/light` (including the physics worker), `pipeline/.../horizon.py`, `apps/api` |
| Data and missions                | data    | the rest of `pipeline/`, `packages/data-client`, `data/`                                       |
| Interface                        | ui      | `apps/web`                                                                                     |
| Copilot and quality (integrator) | quality | `apps/copilot-worker`, `packages/contracts`, `tests/`, `.github/`, `docs/`                     |

## Workflow

- Name branches `<slug>/<feature#>-<short-name>`, for example `light/11-stay-test`. Use one branch and one session per feature.
- Before coding a feature, post a short plan on its issue and wait for your reviewer's approval.
- Open a PR at least every two hours, saying what changed, how you tested it and what's next.
- `main` is protected: a PR, green CI and one human approval, then a squash merge. While `main` is red, nobody merges.
- Write commits as Conventional Commits, for example `feat(light): stay test with sun-disk fraction`. End each one with a Claude `Co-Authored-By` trailer, which is our record of AI use.
- Nobody starts a should-have before the MVP check on Saturday at 20:30. Feature 25, the copilot, is built last.

## Conventions

Most bugs in planetary software are one of these.

| Topic       | Rule                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moon frame  | MOON_ME from `moon_de440_250416.tf`. Use the frame name its comments give for the DE421 mean-Earth convention that LOLA uses.                                   |
| Mars frame  | IAU_MARS from `pck00011.tpc`. MOLA heights are above the areoid.                                                                                                |
| Earth       | WGS84                                                                                                                                                           |
| Coordinates | Planetocentric latitude, east-positive longitude from −180° to 180°                                                                                             |
| Heights     | Metres above the 1737.4 km reference sphere for the Moon                                                                                                        |
| Polar grid  | LOLA's south polar stereographic grid on the 1737.4 km sphere. Never resample the core data.                                                                    |
| Time        | UTC milliseconds (`tUtcMs`) inside the app, ISO 8601 strings at API and tool boundaries, TDB seconds only next to SPICE calls, leap seconds from `naif0012.tls` |
| Units       | Kilometres for positions in space, metres for terrain, degrees at the UI and radians inside the maths                                                           |
| Names       | Carry the unit: `elevDeg`, `distKm`, `tUtcMs`, `slope100mDeg`                                                                                                   |
| Azimuth     | From local north, clockwise through east. At the pole, north is the 0° meridian.                                                                                |

## Code rules

- TypeScript strict mode. No `any` in `packages/physics`, and every exported physics function has a unit test.
- Never type a number shown on screen by hand. Each comes from `packages/physics` or the API, with its dataset id.
- Every UI string goes through an i18n key, in English and Arabic, in the same PR. Layout uses start and end, never left and right.
- No secrets in the repo, no file over 5 MB, and no generated tiles or raw data in git.
- Never invent data. Every new dataset goes into CREDITS.md with its licence, citation, link and its id from the dataset inventory.
- Use Biome and tsc for TypeScript, Ruff, mypy and pytest for Python.

## Done means

- Tests and type checks pass, and the tests check something real.
- The feature works on the PR's preview deploy.
- The PR has screenshots in English and Arabic.
- Every number traces back to a source. If one can't be verified yet, hide it or label it "being checked".

## Commands

pnpm 12 runs through corepack, and the pipeline uses uv with Python 3.13.

- `corepack pnpm install` installs the JavaScript dependencies.
- `corepack pnpm dev` starts the web app at http://localhost:5173 and serves `pipeline/out` at `/data`.
- `corepack pnpm test`, `corepack pnpm typecheck` and `corepack pnpm lint` run Vitest, tsc and Biome. The tests also rewrite `tests/reference/validation.json`, which the app's "How we checked it" panel shows.
- `corepack pnpm e2e` runs the Playwright smoke test against a running dev server (run `corepack pnpm exec playwright install chromium` once).
- `corepack pnpm ephemeris` downloads the SPICE kernels into `pipeline/raw/spice`, writes `pipeline/out/ephemeris/moon_sun_earth.bin`, and regenerates `tests/reference/sun_earth_golden.json`.
