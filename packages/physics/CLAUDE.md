# packages/physics: pure maths

Owners: Orbits owns `orbits/`; Terrain and light owns `light/`, including the Web Worker that hosts it.

- Pure TypeScript, with no DOM, no three.js and no fetch. Data comes in as arguments; `packages/data-client` loads it.
- Use radians inside. Degrees appear only at the edges, in names that end in `Deg`.
- No `any`. Every export has a unit test, and physics PRs also run the golden tests.
- The golden files in `tests/reference/` are shared with the Python pipeline and API. Never edit a golden value to make a test pass; regenerate it with the script that produced it.
- Tolerances:
  - Sun and Earth elevation and azimuth within 0.01° of SPICE.
  - Table interpolation within 0.001° of direct SPICE.
  - Horizon RMS within 0.05° between TypeScript and Python, and identical stay-test results.
- Known-answer tests to keep:
  - The disc fraction is 0, 0.5 and 1 at x = −1, 0 and 1.
  - A flat plane has slope 0 and a 45° plane has slope 45°.
  - At the pole, the Sun's elevation is minus its sub-solar latitude.
  - Longitude and azimuth wrap at ±180°.
  - A site exactly at the pole works.
  - Every date from 2026 to 2035 works.
- Time scales matter here. UTC and TDB differ by about 69 s, and the Sun moves about 0.01° across the lunar sky in that time, which is the whole tolerance. Convert in exactly one place.
