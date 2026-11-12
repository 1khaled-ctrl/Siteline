# Overnight log, 12–13 Nov 2026

**Status:** in progress.

Every item below is committed locally on `main`. Nothing was pushed or deployed. `pnpm test`, `pnpm typecheck` and `pnpm lint` passed before each commit.

## Needs your decision

_(Nothing yet.)_

## Done

### 1. Body-facts card: already done, no change

Built and committed earlier (`6a07ce7`, `7e7393d`). `BodyFacts.tsx` reads `data/bodies.json` and shows gravity, escape speed, rotation period, day length, sunlight strength, Earth-signal delay, temperature range and surface type for the Moon, Earth and Mars. Earth leaves out the signal delay, since it would be zero. It is a separate card from the site report. Screenshots: [demo-ui-moon.png](screenshots/demo-ui-moon.png), [demo-ui-earth.png](screenshots/demo-ui-earth.png), [demo-ui-mars.png](screenshots/demo-ui-mars.png).

### 2. Worlds list: already done, no change

Built and committed earlier (`6a07ce7`). `WorldsList.tsx` sits in the solar view's panel and lists all ten bodies with distance from the Sun (AU) and signal time from Earth, both from the same planet positions that place the 3D planets. Earth, the Moon and Mars are buttons that fly the camera there. Screenshot: [demo-ui-solar.png](screenshots/demo-ui-solar.png).

### 3. Unified header and the tagline bug

The slim top bar (title, tagline, breadcrumbs and the −1d / date / +1d / Now stepper) was already committed. Fixed tonight: the tagline used to say "Moon south-pole landing check" everywhere. It now names the view you are on, and a lander's close-up names that lander's world ("Mars landing site, up close" for Curiosity). Screenshot of all seven views' headers stacked: [header-taglines.png](screenshots/header-taglines.png).

### 4. Floating overlay controls: already done, no change

Built and committed earlier (`6a07ce7`). The display toggles (Missions, Names, Sunlight now, Height and the Earth and Mars equivalents) float as pills over the 3D view's top-start corner (`ViewPills.tsx`). The landing date, slip and coordinates stay in the panel. Screenshots: [demo-ui-pole.png](screenshots/demo-ui-pole.png), [demo-ui-earth.png](screenshots/demo-ui-earth.png).

### 5. Textures, glow and transparent backgrounds

- All six 3D views (solar, Earth, Mars, Moon globe, south pole, landing close-up) now draw on a transparent canvas. One CSS backdrop behind them (`.space-backdrop` in `index.css`, a faint blue glow fading to deep space) replaces six copies of the same flat colour. Composite of all six: [transparent-backgrounds.png](screenshots/transparent-backgrounds.png).
- Solar view: Earth, Moon and Mars use `earth.jpg`, `moon.jpg` and `mars_color.jpg` from `pipeline/raw/landfall/img/`; the others stay shaded spheres. Every planet has a soft glow; the Sun has a three-layer corona that slowly breathes.
- Motion added to the solar view (from the session before the overnight run, committed with this item): twinkling stars and a faint Milky Way band, orbit trails that fade behind each planet in its direction of travel, slow spins with real axial tilts, a banded Saturn ring, a small orbit ring for the Moon, a dolly-in on open, a slow idle drift after 12 s untouched, and hover and click on the planets themselves. All of it stops under the system's reduce-motion setting and while the tab is hidden. Positions still come only from the ephemeris. Screenshot: [demo-ui-solar.png](screenshots/demo-ui-solar.png).
