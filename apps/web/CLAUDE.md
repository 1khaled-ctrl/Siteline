# apps/web: the interface

Owner: Interface.

- React with Zustand. The store holds the date, slip, selected and pinned sites, layers, camera and language, and serialises to the URL (feature 26).
- Physics runs in the Web Worker through Comlink. Never compute physics on the main thread.
- Every string is an i18n key in en.json and ar.json, added in the same PR. In Arabic the page sets `dir="rtl"` and `lang="ar"`.
- Use Tailwind's logical classes only (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`), never left or right.
- Don't mirror the 3D view, the compass or time axes. Wrap charts in `dir="ltr"`.
- Format dates with `Intl.DateTimeFormat`. Arabic locales can default to Arabic-Indic digits, so use `'ar-LB-u-nu-latn'` for the default Western digits and `'ar-LB-u-nu-arab'` when the user picks Arabic-Indic.
- Wrap numbers, units and Latin names inside Arabic text in `<bdi>`.
- Pass, fail and warning always show an icon and a word, never colour alone. Every chart has a one-sentence summary for screen readers, and every control works from the keyboard.
- The look follows the concept demo in `docs/reference/landfall-demo`. On a wide screen the 3D view fills the window under a slim top bar, and one floating panel 410 px wide sits 12 px in from the end edge; the 3D view stops at that panel, so the world sits in the middle of the part you can see. On a narrow screen the panel stacks under the view. `PanelContent` in `App.tsx` sets what the panel holds on each view.
- Design tokens (all in `src/index.css`; change them there and let them cascade):
  - Background: flat #060913; the top bar #080D1A.
  - Panels in three depths: base #0C1322 (the floating panel, at 95% opacity), raised #121B30 (tiles, list rows, buttons), sunk #0A1120 (inputs, charts, the 3D model box). Borders #22304F, #3A4C80 on hover.
  - Text #E8EDF7, quiet text #8E9AB5, accent #5BA9FF.
  - Pass #41CF8F, fail #FF6F6F, warning #F0C050. Gold #F4B63F marks sunlight readings and whichever toggle is on (`pressedGold`); blue marks Earth readings.
  - Corners: the panel 14 px, tiles and boxes 10 px, buttons 8 px (`rounded-md`); filters and check chips are pills (`rounded-pill`).
  - Fonts: Saira Semi Condensed for titles (`h1` to `h3`, `font-display`), IBM Plex Sans and IBM Plex Sans Arabic for text, IBM Plex Mono for numbers and data values (every `dd` and `output`; add `data-text` to a `dd` that holds a name or a sentence). Tabular figures throughout.
- Data: by default the app reads everything from the R2 bucket (`out/`, `raw/landfall/` and the 10 m terrain in `raw/lola/`), so a fresh clone needs no setup; the dev server passes those reads through `/r2` so any port or address works. Set `DATA_BASE_URL=local` (in the shell or `apps/web/.env.local`) to serve a local `pipeline/out` at `/data` and `pipeline/raw/landfall` at `/landfall` instead, or another URL to read from there. The Pipeline workflow fills `out/`.
- Touch targets are at least 44 px. Panels never cover more than a third of the screen.
