# Overnight log, 13 Nov 2026: the spatial redesign

**Brief:** stop treating data as a panel next to the 3D view. A cinematic opening built on the SiteLine Lunar Emblem, glass cards that float in the scene and point at what they describe, and a phone layout of its own (bottom sheet, thumb dial, tilt to look, swipeable compare). Presentation only: no number, source or calculation changed.

**Where it is:** branch `ui/spatial-hud`, one commit per step, not pushed. `corepack pnpm test`, `typecheck` and `lint` passed before each commit (lint's only complaints are the two workflow files' Windows line endings in this checkout, which are LF in git).

## Calls I made (one line each)

- The emblem source is now in the repo at `docs/brand/siteline-lunar-emblem.png` (1.4 MB, under the 5 MB rule); `apps/web/scripts/emblem.py` cuts it into the web pieces in `apps/web/src/assets` (badge 69 KB, lander, star, 64 px favicon).
- Libraries: GSAP 3.15.0 for the opening's timeline and Motion 14.8.0 for the phone gestures, both pinned, both at least two weeks old. GSAP's licence is its own free "Standard no-charge" licence (from its package.json), not MIT; fine for a free web app. React Three Fiber is not used: the engine's plain three.js views already expose what the cards need, and a second WebGL stack would cost more than it saves.
- The opening plays once per browser tab (sessionStorage); `?intro=1` replays it and `?intro=0` skips it. Esc or "Skip intro" also skips.
- The opening waits on real loads (fonts, the emblem, planet positions, orbits, the planets' colour maps, the first view); at least 1.7 s so it never flashes, a "Still loading …" line after 4.5 s, and after 25 s it opens anyway so each view shows its own progress.
- The lander flies to the Moon, not the Earth: SiteLine is about landing on the Moon.
- The 3D canvas now runs on under the floating panel on wide screens, and each view shifts its camera's centre (`setViewOffset`) into the free part, so the world stays centred and the scene shows through the glass. That is a small `setInsets` on all six engine views (World role) plus a shared `fitCamera` helper.
- Fixed while testing, not part of the brief: the Mars height map, the Earth country-id map and the close-up height patches are read back pixel by pixel, and since the data moved to R2 the browser locked those canvases ("tainted by cross-origin data") because the images were requested without CORS. Each now sets `crossOrigin = 'anonymous'`; R2 already sends the header. This is why Mars hung on "Loading the Mars maps…" and the close-ups failed; the Playwright smoke test passes end to end again.
- The smoke test now runs with reduced motion: Playwright only clicks elements that have stopped moving, and the panel's cards drift a pixel or two. It also gets the opening's short fade instead of the flight.
- Desktop callouts are short "spec annotations" (a world's two readings, the site's verdict and checks, a globe's three facts) with a leader line to the exact point; the full cards (site report, facts, controls, lander lists) stay in the panel as glass, each callout has a button that brings its full card into view. Rebuilding the big site report inside a moving card would have risked the features the brief says must keep working exactly as today.
- On a wide screen the solar view has no panel now: Earth, the Moon and Mars carry cards in the scene, and pointing at or clicking any other planet gives it one. The worlds list is phone-only (it lives in the bottom sheet). When the panel is empty the 3D view takes the whole width.
- A globe's facts card shows only while the globe leaves room for it (radius under 36 % of the window's height): Mars and the Earth open filling the view, so their cards arrive as you zoom out, instead of covering the surface.
- The cards' "Fly there" buttons are named "Fly to Earth" etc. for screen readers, and the smoke test clicks those (or the phone list's rows); it reads the verdict from the panel's report, since the site's card repeats it.
- The site card and the full report share one stay check through a small cache in `physics.ts` (`stayOnce`); the compare table uses it too. Retry still forces a fresh run.
- Phones (under 1024 px) get their own layout: the 3D view fills the screen, the panel is a glass bottom sheet (drag the handle or tap it; only the handle drags, so the cards inside scroll normally), and the thumb dial sits just above it. The sheet's peek line is the view's key number: the dial's world and its two readings with Fly there, the site's verdict with its two percentages, a globe's signal time (Earth: its sunlight).
- What the dial turns: the worlds in the solar view (default the Moon; a tap flies there); time everywhere else, an hour a click or a day a click when spun fast, through the same time-lapse offset the Play button uses (a tap goes back to the landing time); and, at the south pole with two or more pinned sites, a "Time / Pinned sites" chip switches it to stepping through the pins. On Mars and the Moon globe it could have stepped through landers instead; I chose time so the dial means the same thing on every body view.
- On a phone the copilot button shrinks to its star and sits beside the dial.
- Tilt to look: a button beside the dial (phones only, hidden for reduced motion) asks for motion access on the tap itself, never on load, then turns the camera up to about 6° from wherever the phone was held when tapped (20° of tilt turns the view about 4.6°), smoothed, on top of dragging. If access is refused or no sensor answers within 1.5 s, it says so for five seconds and turns itself off. The engine gained a `LookOffset` that every view applies just before it draws, so labels, pins and callouts tilt with the picture.
- Compare on a phone is a deck of site cards in the table's own ranking (best first, with its badge); swipe the top card either way to send it to the back, or use the arrows. Every row of the table is on each card with the same stars. Wide screens keep the table.
- Picking a place on Mars or the Earth (a click or a search) now also gives it a callout at the exact spot: Mars says the feature, its height above the areoid and its coordinates, the Earth the country and nearest city, worded as the panel words them. A hovered planet's card stays while the pointer travels onto it and while you read it.
- Performance on a mid-range phone, measured with Chrome's CPU throttling (4× slower) on a 390 × 844 screen and software WebGL (so real phones do better). Before tuning, the coin turned at about 30 fps and the flight ran at 15 to 20. Four fixes: the hidden solar view no longer draws behind the opaque opening (one warm-up frame per change only); the coin's light and sheen move by opacity and transform instead of a repainted filter and gradient; the orbit projection reads the canvas's box once per frame instead of 365 times; and matching the orbit to the ring is one sorted sweep instead of about 175,000 trig calls a frame. Now the coin turns at 60 fps and the flight runs at 30. On top of that, a governor times the frames while the coin turns and again for two seconds after the app opens: if the median runs slower than 30 fps, the effects get lighter rather than switched off (no blur in the flight, no drift on the cards, thinner frosting on the glass), marked `data-low-power` on the page.

---

# Overnight log, 12–13 Nov 2026

**Status:** all 17 items done (Parts 1–4), each in its own commit. Tests went from 116 to 166. Time was left, so small polish items follow at the end, logged the same way.

Every item below is committed locally on `main`. Nothing was pushed or deployed, and nothing touched R2, Cloudflare or GitHub Actions. `pnpm test`, `pnpm typecheck` and `pnpm lint` passed before each commit, and the Playwright smoke test passed after every change to a view.

**Start here:**

- `git log --oneline 8887a5e..HEAD` lists tonight's commits, one per item.
- Read **Needs your decision** below: eight calls I made so I could keep going, all easy to reverse.
- To see the headline features: open the south pole (`?view=pole&t=2028-04-08T00:00:00Z&lat=-85.4&lon=31.7`) and try **Simulate the journey**, **Share**, the day strip, the badges, **Ask SiteLine** and **Sources & methods** in the header. Pin a few Artemis regions to see the compare table.

## Needs your decision

Each of these is a call I made so I could keep going. All are easy to reverse.

1. **A Lambert solver now lives in `packages/physics`** (item 15). The brief asked for the Mars leg to be shaped by Lambert's problem, so I added a new file, `packages/physics/src/lambert.ts` (solver plus an exact two-body propagator, both from Curtis's textbook), with 5 tests including Curtis's worked Example 5.2, and one export line in `index.ts`. No existing physics code changed. That package belongs to the Orbits role, so it wants their review; the alternative is moving it into `apps/web`.
2. **Small wiring changes in `packages/engine`** (World role): the six views' transparent canvases (approved, item 5) and a `ready` promise on the Moon, Earth and Mars globes so the UI knows when their imagery has loaded (item 6). No maths touched.
3. **Journey assumptions** (item 15): Moon timing follows Apollo 11 (about 3 days' coast from trans-lunar injection, then about a day in lunar orbit), from a 185 km parking orbit, with injection 170° before the Moon's arrival point. Mars searches 120–400 days of flight for the cheapest launch. I call a Mars launch "in a launch window" when its C3 is within 2.5× the Hohmann C3 of the two orbits; that factor is mine, chosen so real windows (C3 about 9–20 km²/s²) count and far-off dates don't. Change any of them in `apps/web/src/journey.ts`.
4. **Copilot tool names** (item 14): I used the names in `docs/contracts.md` (`fly_to`, `show_mission`, `analyze_site`) rather than the brief's `go_to`, so the future Claude relay can reuse them as they are.
5. **English only.** `CLAUDE.md` asks for Arabic in the same PR as every string; you said English only for now, so tonight's ~250 new strings are English only and Arabic still needs adding.
6. **One commit fails lint on its own.** The item 14 commit (`464b5a4`) left a blank line missing in this log, which Biome's Markdown formatting flags; the next commit fixes it. Squash or leave as you like.
7. **The "19-year" strip covers 2026–2035, not 19 years** (item 16). The two 19-year numbers in the site report are read from a precomputed map (`landfall-polar-maps`, made by the concept demo) that stores only the final percentages per pixel, not a time series, so that computation can't be re-sampled. Instead the strip runs the stay check's own Sun and Earth tests day by day across everything our ephemeris covers (2026–2035), and says so on screen. Its totals land close to the map's (Mons Mouton: sunlight 66 % vs 64 %, Earth 92 % vs 88 %), which is a useful cross-check. A true 19-year strip needs a longer ephemeris table from the pipeline.
8. **Pre-existing flaky test, not touched** (physics role): `planets.test.ts` once failed with "Unexpected end of JSON input" because two physics test files write `tests/reference/validation.json` at the same time. A rerun passed. It wants a fix in `validationReport.ts` by its owner.

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

### 6. Loading states

- Each 3D view shows a centred spinner pill saying what is loading ("Loading NASA LOLA south-pole terrain…", "Loading NASA Blue Marble imagery…" and so on) until its data is on screen. It waits a quarter second before appearing, so a cached load never flashes it. Screenshot: [loading-state-pole.png](screenshots/loading-state-pole.png) (terrain request held back on purpose).
- The Moon, Earth and Mars globes stay hidden until their colour map has arrived, then fade in, so you never see a black ball with pins floating on it. To know when that is, the three globe classes in `packages/engine` gained a `ready` promise (loading wiring only, no maths touched).
- The page itself is dark from the first paint with a SiteLine splash until the app mounts (it used to be white for a moment).
- The same overlay also covers a failed load with a retry button; see item 7.

### 7. Error and offline states

- A 3D view whose data fails shows a card saying what didn't arrive, a one-line hint, the technical reason in small print, and **Try again**, which rebuilds the view from scratch. Screenshot: [error-state-globe.png](screenshots/error-state-globe.png) (Moon map blocked on purpose).
- The site report, the Worlds list and the best-spots search show the same kind of card inside the panel, each with its own Try again. The site report also has a grey skeleton while its first check runs.
- A slim amber banner under the header says when the browser is offline. When the connection comes back, every failed view and panel retries by itself; tested by blocking `planets.bin`, going offline, then restoring both. Screenshot: [offline-and-retry-solar.png](screenshots/offline-and-retry-solar.png).
- Rover routes and close-up headers used to stay missing until a reload if their first fetch failed; the next view that needs them now asks again.

### 8. One "Sources and methods" place

- A **Sources & methods** button in the header opens one dialog with three parts: how the site check works (positions, horizon, sunlight, Earth in view, slope, Artemis zone, 19-year maps, planet distances, world facts), each with chips for the datasets it reads; the existing "How we checked it" validation table, open; and every dataset with its licence and source.
- The dataset list is read from `CREDITS.md` itself when the app is built (`credits.ts`), so the two can never disagree. Its thresholds (6.5-day stay, 50 % of the Sun's disc, 10° slope, −84° zone) are read from the code, not typed in.
- The site report's "Sources:" ids are now links that open the dialog at that dataset, highlighted. The per-panel citations are all still there.
- Screenshots: [sources-dialog.png](screenshots/sources-dialog.png), [sources-dialog-from-report.png](screenshots/sources-dialog-from-report.png). Tests: `credits.test.ts` (8 tests).

### 9. Share this site report

- A **Share** button sits beside "Pin to compare" in the site report's verdict box. It offers three things:
  - **Copy a link to this check**: a URL with the spot, landing date and launch slip that reopens the same check for anyone.
  - **Download as an image (PNG)**: a 1200 × 675 summary card (drawn at 2× for sharp text) with the verdict, the four checks, the six readings, the terrain caveat, the sources, the link, and a footer saying it is a planning aid, not a mission-certified analysis. Sized for slides, Slack and the judging video. Example: [share-card.png](screenshots/share-card.png).
  - **Print or save as PDF**: the same card on white, alone on a landscape page. Example of the print view: [share-print.png](screenshots/share-print.png).
- All three were exercised in a real browser: the download, the clipboard contents, and the print layout. Menu: [share-menu.png](screenshots/share-menu.png).
- The check and verdict rules moved into `verdict.ts` so the report, the card and the compare table (item 12) use one definition. Tests: `verdict.test.ts` (7 tests).
- The link uses whatever address the app is served from, so it reads `localhost` today and the real address once deployed.

### 10. Phone and tablet pass

- Measured every view at 390 × 844 (phone) and 820 × 1180 (tablet): no horizontal scroll anywhere (page width equals window width in all 12 cases). Composites: [mobile-phone-390.png](screenshots/mobile-phone-390.png), [mobile-tablet-820.png](screenshots/mobile-tablet-820.png).
- The phone header shrank from four rows (about 190 px) to two on most views: "Sources" (short label) sits on the title row, and the date stepper gets one row of its own, without the "UTC" tag (the date field's label already says UTC).
- On a phone the Share menu opens as a sheet along the bottom edge instead of a dropdown that could run off-screen, and the close-up view hides its long "drag to turn" hint as the other views already did.
- Also fixed on the way (item 10): the sources dialog now builds its content only while open, so its text no longer duplicates the page's text for screen readers and tests (it broke the smoke test once; passing again).

### 11. Keyboard and accessibility pass

- Ran an in-browser audit on nine screens (all six views, the pole view with pinned sites, the open Share menu and the sources dialog): every visible control has an accessible name, every field a label, every image alt text, and every text element meets WCAG AA contrast (4.5:1, or 3:1 for large text), with translucent backgrounds composited down to the page colour. **0 findings** after the fixes below. Labels drawn on top of the 3D imagery can't be measured that way and were checked by eye.
- The zoom +/− buttons, the compare list's × and the other icon-only buttons already had labels. Fixed: the best-spots button kept saying "Find the best spots" while showing ×; it now says "Close…" and reports busy and expanded states.
- New: a **Skip to the side panel** link appears on the first Tab, so keyboard users don't have to step through every map control first. The Share menu moves focus into itself when it opens and back to the Share button on Escape.
- The breadcrumb arrows were the one contrast miss (2.5:1, decorative and hidden from screen readers anyway); now full grey.
- Every control shows the blue focus ring (the global `:focus-visible` style); nothing overrides it. Screenshot of the keyboard walk: [keyboard-focus.png](screenshots/keyboard-focus.png).

### 12. Compare view: a real side-by-side table

- Pinned sites (up to 4) are now columns and the readings are rows: stay verdict, least of the Sun visible, time Earth is in view, slope, ground height, sunlight over 19 years, Earth in view over 19 years, and the first problem ("Sun down at landing", "Earth sets 9 Apr, 14:00", "none").
- The best value in each comparable row gets a ★ (only when there is a real difference). The best site overall gets a **Best** badge and a line under the table naming it, with the ranking rule stated on screen: verdict first, then sunlight over 19 years, then Earth in view. Slope is shown but not ranked, since no site can be measured until finer terrain is loaded.
- The verdict now uses the same rules as the site report (it used the raw pass flag before, so a site the report called "not decided yet" showed as "Fail" here).
- Screenshot with four Artemis regions (Malapert Massif, Mons Mouton, Haworth, de Gerlache Rim 2) landing 8 Apr 2028: [compare-table.png](screenshots/compare-table.png). Tests for the ranking and the ★ rule are in `verdict.test.ts`.

### 13. Tests for tonight's work

- **116 → 143 tests**, all passing. New files: `credits.test.ts` (reading CREDITS.md, including against the real file), `verdict.test.ts` (the four checks, the verdict, ranking, ★ rule, first problem, share link, card file name), `ui/ViewStatus.test.ts` (failure reasons, short dates).
- To make them testable, the compare table's "first problem" rule and the card's file name moved out of the components into `verdict.ts`.
- Not unit-tested: the canvas drawing of the share card and the React loading hooks (no DOM test library in the repo, and adding one changes the lockfile, which is the integrator's). Both were exercised in a real browser instead (items 6, 7, 9).
- The AU and light-time maths the Worlds list uses already had tests against NASA's and JPL Horizons' figures (`bodyFacts.test.ts`), so nothing new was needed there.

### 14. Copilot chat, scoped small (stretch)

**What's there.** An **Ask SiteLine** button floats at the bottom-start of the 3D view on every screen and opens a small chat. It has three read-only tools, named as in `docs/contracts.md`:

- `fly_to`: "Fly to Mars", "Take me to the south pole", or just "moon" moves the view.
- `show_mission`: "Show me Apollo 11", "where is Curiosity?" opens that mission's card and flies there (it knows all 46 missions by full name, craft name or id).
- `analyze_site`: questions about the selected Moon landing site ("Does this site pass?", "Why does it fail?", "When does the Sun set?", "Is Earth in view?", "How steep is it?", "How high is it?", "Sunlight over 19 years?", "Give me the report"). It runs **the same check, with the same inputs, as the site report**, so it can never say a number the panel doesn't; answers list their dataset ids, which open the sources dialog.
- Each reply shows the tool call it made (for example `↳ analyze_site(aspect: "events")`), so it's clear what was looked up. Anything else gets a short "here's what I can do".

**What's not there (by design tonight).** No AI model is connected: a small keyword matcher in `copilot.ts` picks the tool, and the panel says so ("Simple matcher, no AI yet"). Nothing calls a paid API, nothing writes data, and no new infrastructure was added. The planned Claude relay (`apps/copilot-worker`) can replace the matcher later and reuse the same tools unchanged. Not built yet: the other contract tools (`compare_sites`, `find_best`, `set_date`, `set_slip`, `toggle_layer`, `list_missions`, `launch_windows`, `explain`, `export_report`), JSON-schema validation of tool inputs, and free-form follow-up questions.

Screenshot of a real conversation (Mons Mouton, landing 8 Apr 2028; its numbers match the site report beside it): [copilot-chat.png](screenshots/copilot-chat.png). Tests: `copilot.test.ts` (6 tests: tool choice, mission aliases, and that the summary carries the report's numbers unchanged).

Bug found on the way (item 14): newer Chromium makes `scrollIntoView()` return a Promise, and a one-line React effect that returned it crashed the page. Fixed in the copilot; I checked the app's other one-line effects and they all return nothing.

### 15. "Simulate the journey" (Part 4)

**Where:** a **▶ Simulate the journey** button in the Moon site report (south-pole view), and in the Mars place panel once you click or search a place on Mars. It uses the site and the landing date (with slip) already on screen; nothing new is chosen.

**What it shows:** a dialog with a top-down map in the plane of the orbit, the craft (gold arrow) flying along its path with the travelled part lit, the target body moving on its real track, a play/pause button and a **timeline scrubber**, live readouts (phase, UTC time, mission day, distance from Earth, speed, launch energy C3), and a small globe of the landing site that appears on arrival and marks touchdown. The caption **"Illustrative trajectory from real launch and arrival positions. Simplified, not a guidance-grade path."** is drawn on the animation itself, and the assumptions are written under it.

**How it's computed** (`apps/web/src/journey.ts`):

- **Moon:** positions from the app's ephemeris tables. The craft leaves a 185 km parking orbit and coasts 3 days on the two-body orbit around the Earth that meets the Moon where the ephemeris puts it (Lambert's problem with Earth's GM from `data/bodies.json`), then spends a day in lunar orbit and lands at the site at the landing time. Result for Mons Mouton, landing 8 Apr 2028: 10.9 km/s after injection, C3 −1.8 km²/s², in line with Apollo-era trans-lunar injections.
- **Mars:** real Earth and Mars positions from the planets table. For each time of flight from 120 to 400 days it solves Lambert's problem around the Sun (Sun's GM from `gm_de440.tpc`) and keeps the launch with the lowest C3. It also works out, from the two orbits, the ideal Hohmann C3 and how often windows recur, and says whether the landing date sits in a launch window. **Check:** a landing at Jezero on 15 Sep 2027 gives a launch on 1 Nov 2026 with C3 9.3 km²/s² (Hohmann 8.8), which is where the real late-2026 Mars window is. A landing in January 2031 gives C3 284 km²/s² and says it's far from a window, as it should.
- The search never starts before the planets table does, so it can't invent a departure position.

**Screenshots mid-flight:** [journey-moon-midflight.png](screenshots/journey-moon-midflight.png), [journey-mars-midflight.png](screenshots/journey-mars-midflight.png); after touchdown: [journey-moon-landed.png](screenshots/journey-moon-landed.png).

**Tests:** `lambert.test.ts` (5) and `journey.test.ts` (5: a made-up circular sky where the right answers are known: injection speed and C3, arrival at the Moon on time, a launch near the Hohmann time and energy, the Hohmann and synodic yardsticks, and no launch before the tables start). **159 tests** in total.

**Simplified on purpose, and said so on screen:** no lunar gravity on the way in (the lunar-orbit loops are drawn, not computed), no planetary gravity at Mars departure and arrival, no course corrections, and bodies drawn larger than scale.

### 16. Sun and Earth, every day: a strip behind the long-term numbers

- The site report now has two heat maps under its readings: one row per year, one column per day, coloured by how much of each day the Sun is up (gold, the same colour-blind-safe ramp as the pole map's sunlight layer) and how much the Earth is in view (blue). The stay being checked is outlined in gold. Hovering a day reads it out ("2029-07-25: Sun up 100% of the day, Earth 100%"). The strips sweep in when they load (instantly under reduce-motion).
- It shows _why_ a site passes or fails over time: the monthly lunar nights are the dark bands, and the long Earth-below-horizon spells line up across years.
- Computed by the stay check's own tests (same horizon, same "half the Sun's disc" and Earth rules) every 3 hours over every day in the ephemeris, in the worker (about 2 s). See decision 7 above for why it covers 2026–2035 rather than 19 years.
- Screenshot (Mons Mouton): [day-strip.png](screenshots/day-strip.png). Tests: `dayStrip.test.ts` (2, on a made-up sky with known answers).

### 17. Confidence badges tied to the terrain

- Each check chip in the verdict box now carries a badge, and each reading tile a mark: **● high confidence**, **◐ first pass**, **○ not measured**, or **◌ flat horizon** (spot off the terrain). Hover or a screen reader gives the reason in one sentence.
- The rule (`confidence.ts`) is tied to the data, not to opinion: horizon-based readings (Sun, Earth, ground height) are high confidence on terrain at LOLA's full 240 m detail (the native resolution of `LDEM_75S_240M`, which our 1.2 km terrain was resampled from) and a first pass when coarser; the slope needs terrain at 100 m or finer, else "not measured"; the Artemis-zone check depends only on latitude, so it is always high; the 19-year readings are rated by their own map's 2.4 km grid. Today that makes Sun, Earth, height and the 19-year numbers "first pass", the zone "high", and the slope "not measured", exactly as the data supports. When finer terrain is loaded, the badges change by themselves.
- The yellow warning box became a neutral **How sure is each reading** key with the three marks and the terrain line, so the limitation reads as information, not apology (it stays amber only when the horizon had to be taken as flat).
- Screenshot: [confidence-badges.png](screenshots/confidence-badges.png). Tests: `confidence.test.ts` (5). Accessibility audit re-run on all screens: 0 findings.

## Polish (picked up with time left)

### P1. Phone check of tonight's additions

The day strip, the compare table, the journey dialog and the copilot didn't exist during the item 10 pass, so I checked them at 390 px wide: no sideways scroll on any. Fixed two things: the compare table's verdict chips overlapped in four narrow columns (on a phone they now show just ✓, ✗ or ?, in colour, with the word kept for screen readers), and the journey map clipped labels near its edge (they now stay inside). Screenshot: [mobile-new-features.png](screenshots/mobile-new-features.png).

### P2. The copilot answers "How sure is that?"

Asking the copilot how sure, reliable or accurate a reading is now runs `analyze_site` with a "confidence" aspect and answers from the same rules as the item 17 badges, for example: "High confidence: the Artemis zone. First pass, from terrain coarser than LOLA's full detail, so worth checking with finer terrain: Sun up, Earth in view, ground height, the 19-year figures. Not measured yet: the landing slope." It's also one of the example chips. Screenshot: [copilot-how-sure.png](screenshots/copilot-how-sure.png). Tests: two more cases in `copilot.test.ts`.

### P3. The share card carries the confidence words

Each check on the downloadable and printable card now says how sure it is, as the report's badges do ("no · first pass", "yes · high confidence"), so a picture shared in Slack or the judging video never shows a first-pass reading as final. Updated examples: [share-card.png](screenshots/share-card.png), [share-print.png](screenshots/share-print.png).
