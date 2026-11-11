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
- Design tokens:
  - Background #05070A.
  - Panels #10141C at 72% opacity with a 12 px blur.
  - Text #E8EDF2, quiet text #9AA7B4, accent #5AA9FF.
  - Pass #3CCF7F, fail #FF5C5C, warning #FFB547.
  - IBM Plex Sans and IBM Plex Sans Arabic, with tabular figures.
- Touch targets are at least 44 px. Panels never cover more than a third of the screen.
