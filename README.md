# SiteLine

SiteLine is a web app for comparing Moon south-pole landing sites and dates. Pick a spot and a landing date, and it checks whether the Sun and Earth stay above the horizon for the whole stay, then re-checks as you slip the launch. It is being built for the NASA Space Apps 2026 Lunar Landing Site Navigator challenge.

## Run it locally

You need Node 24 or newer, and [uv](https://docs.astral.sh/uv/) for the Python pipeline.

```sh
corepack pnpm install
corepack pnpm ephemeris   # SPICE kernels -> hourly Sun and Earth table for 2026 to 2035 (takes a few seconds)
corepack pnpm mars-data   # USGS Mars names and the Mars slope map, for the Mars view
corepack pnpm dev         # http://localhost:5173
corepack pnpm test
```

## What works so far

- The stay test: Sun and Earth visibility from any site over the stay, a reason for every fail, the next sunset, sunrise, Earthset and Earthrise, and the launch-slip slider.
- The physics is checked against NASA's SPICE toolkit: across 1,000 site and date cases, Sun and Earth directions agree within 0.001°.
- The app opens on the solar system: the eight planets and the Moon at their real positions for the landing date (from SPICE, within 0.01°), with orbit rings. Click Earth, Mars or the Moon to fly in; breadcrumbs at the top lead back up.
- A map-style Earth: NASA imagery with Natural Earth borders and names, a satellite and night-lights style, and a day-and-night line from the real Sun (within 0.006° of SPICE). Zoom from the globe to a country to a city (provinces, roads, rivers and cities from Natural Earth 1:10m); click anywhere to name the country and nearest city.
- A relief globe of Mars: NASA MOLA heights on the mesh (stretch them with the Relief slider), IAU names for 2,054 craters, volcanoes, valleys and plains, search, and the height of any point you click. A day-and-night line from the real Sun matches SPICE within 0.001°.
- The whole Moon lit by the real Sun for the landing date, then a fly-down to a 3D south pole from NASA LOLA terrain with NASA's nine Artemis regions. Click anywhere to check that spot.
- Pin up to four sites and compare them; the launch-slip slider re-checks all of them. A best-spot search ranks sampled points inside any Artemis region.
- Map layers for long-term sunlight, Earth visibility and never-sunlit ground, and a time-lapse that plays a lunar day over the terrain.
- A "How we checked it" panel whose numbers are written by the test suite (`tests/reference/validation.json`), never typed by hand.
- Horizons come from the terrain and include lunar curvature. On the current 1.2 km terrain, sunlight agrees with published values within 5 points except on ridges narrower than a pixel.
- English only for now; the strings live in `apps/web/src/i18n/en.json`, so Arabic can be added back.
- The terrain, textures and models from the Landfall concept demo are in `pipeline/raw/landfall/` (not in git). Run `corepack pnpm e2e` with the dev server running for the browser smoke test.

## Licence

The code is under the MIT licence. Every dataset keeps its own licence; see [CREDITS.md](CREDITS.md).
