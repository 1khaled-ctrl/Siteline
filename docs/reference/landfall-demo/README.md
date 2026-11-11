# Landfall concept demo (4 November 2026)

This folder holds the code of the single-page concept demo, kept as a reference while its features move into the app. It is not built or served.

- `index.html` holds the whole UI and 3D scene: the solar system, the Moon, Mars and Earth globes, the south-pole view, the missions and the copilot.
- `engine.js` holds the demo's physics. `packages/physics` replaces it and is more accurate: within 0.001° of SPICE against the demo's 0.025°.
- The demo's assets (textures, terrain, models, Earth maps, names, rover tracks) are in `pipeline/raw/landfall/`. They are not in git; upload them to R2.
- The data embedded in the code is in `data/`: `missions.json`, `regions.json`, `craters.json` and `bodies.json`.
