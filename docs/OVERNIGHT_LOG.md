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
