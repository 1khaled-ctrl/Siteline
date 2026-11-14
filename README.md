# SiteLine

SiteLine is a web app for choosing a landing site on the Moon's south pole. Fly from the solar system down to the pole, click a spot and pick a landing date, and it checks whether the Sun and the Earth stay above that spot's real horizon for the whole stay, how steep the ground is, and how far the nearest cold trap is, then re-checks as you slip the launch. It is built for the NASA Space Apps 2026 Lunar Landing Site Navigator challenge.

Live: https://siteline-a1a.pages.dev

## Run it locally

You need Node 24 or newer, and [uv](https://docs.astral.sh/uv/) for the Python pipeline.

```sh
corepack pnpm install
corepack pnpm dev         # http://localhost:5173
corepack pnpm test        # Vitest; also rewrites tests/reference/validation.json
corepack pnpm typecheck
corepack pnpm lint
```

A fresh clone needs nothing else: the app reads its data (textures, terrain, ephemeris tables, NASA's maps and close-ups) from the project's R2 buckets, through `/r2` on the dev server. Run `corepack pnpm e2e` with the dev server up for the browser smoke test (`corepack pnpm exec playwright install chromium` once).

### Rebuilding the data

The pipeline (`pipeline/`, Python 3.13 with uv) builds `pipeline/out`, which the Pipeline workflow publishes to R2. To run a step yourself:

```sh
corepack pnpm ephemeris   # SPICE kernels -> hourly Sun and Earth table for 2026 to 2035
corepack pnpm mars-data   # USGS Mars names and the Mars slope map
cd pipeline
uv run python -m siteline_pipeline.mars_height     # Mars heights from NASA's 16 MEGDR tiles (2 GB download)
uv run python -m siteline_pipeline.site_patches    # south-pole close-ups from the Artemis 5 m and LOLA 10 m models
uv run python -m siteline_pipeline.illumination    # long-term sunlight, Earth view and permanent shadow (PGDA 69)
```

Each input has a config in `pipeline/configs/` with its URL, size or sha256, licence and citation; every step verifies its files before reading them and writes a manifest of what it read. Nothing needs GDAL. To point the app at a local `pipeline/out` instead of R2, put `DATA_BASE_URL=local` in `apps/web/.env.local`.

## Deploy

The site is on Cloudflare Pages. Cloudflare builds `main` from GitHub on every merge (`pnpm --filter @siteline/web build`, published from `apps/web/dist`), and gives every other branch a preview of its own.

- **Data**: the Pages project sets `VITE_DATA_URL` and `VITE_ASSETS_URL` to the R2 bucket's public URL. Run **Actions → Pipeline → Run workflow** on `main` to rebuild `pipeline/out` and publish it; the site picks it up with no deploy.
- **Terrain**: the 30 m skyline terrain and NASA's raw files are in a second bucket, `siteline-terrain`, read by byte range. The 10 m slope terrain comes from a byte-for-byte copy in R2 (`VITE_TERRAIN_10M_URL`), because NASA's server is slow from the Middle East; `functions/pgda` passes reads through to NASA's own file where that variable is not set.
- Each bucket's CORS rule must list every address that loads it (the live site, `localhost:5173` and `localhost:4173`). Preview deploys are not listed, so they fall back to the coarser terrain.

## What it does

- **The stay check.** Sun and Earth visibility from any site over the stay, a reason for every fail, the next sunset, sunrise, Earthset and Earthrise, and a launch-slip slider that re-checks everything. Directions agree with NASA's SPICE toolkit within 0.001° across 1,000 site and date cases.
- **A real horizon.** Each site's skyline is worked out from NASA's LRO LOLA terrain at 30 m around the site and out to 300 km, with lunar curvature. At three published test points, its sunlight agrees with NASA's own long-term illumination maps (PGDA 69) within a point; the older 1.2 km terrain overestimated it by 30 to 44 points. The verdict appears at once and sharpens to 30 m as the tiles arrive; without them it uses the 1.2 km terrain, never a flat horizon.
- **The slope**, from LOLA's 10 m terrain, read tile by tile around each site.
- **Long-term readings** from NASA's PGDA 69 maps: the share of time the Sun is up and the Earth is in view, permanently shadowed ground, and the distance to the nearest permanent shadow, a cold trap where ice can last (not ice that has been detected).
- **The solar system** at the landing date, with every planet and the Moon where SPICE puts them; click Earth, Mars or the Moon to fly in.
- **A map-style Earth** with NASA imagery, Natural Earth borders, roads and cities, and a day-and-night line from the real Sun.
- **A relief globe of Mars** shaded from NASA's MOLA MEGDR at 463 m, with 2,054 IAU names, search, and the height of any point you click.
- **A lander tracker** on the Moon and Mars: 46 landings, crashes and planned landings, with a card, a 3D NASA model and the sources for each, and the rover routes on Mars.
- **Close-up terrain** for each landing site. Nine south-pole sites, VIPER among them, are cut from NASA's 5 m Artemis III models or the 10 m LOLA terrain; the rest from the concept demo's patches. The camera stops zooming where the terrain runs out of detail.
- **The 3D south pole** from LOLA terrain with NASA's Artemis regions: click anywhere to check that spot, pin up to four sites to compare, rank the best spots in a region, switch on the long-term layers, or play a lunar day over the terrain.
- **"How we checked it"**, whose numbers are written by the test suite (`tests/reference/validation.json`), never typed by hand.
- **The orb** at the corner of the view opens Ask SiteLine, a small copilot, and can hide the interface for a clean look at the scene.
- English only for now; the strings are in `apps/web/src/i18n/en.json`.

## Data and credits

Every dataset, with its licence, citation and how we checked it, is in [CREDITS.md](CREDITS.md). The main ones: NASA's SPICE kernels; LRO LOLA terrain at 30 m, 10 m and 240 m (PGDA 90); the Artemis III 5 m shape-from-shading models (PGDA 104, CC BY 4.0); LOLA illumination maps (PGDA 69, Mazarico et al. 2011); and the MGS MOLA MEGDR for Mars.

## Licence

The code is under the MIT licence. Every dataset keeps its own licence; see [CREDITS.md](CREDITS.md).
