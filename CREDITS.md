# Credits

## Data

| Id                 | What                                                                                                                | Licence       | Source                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| spice-de440s       | Planetary ephemeris `de440s.bsp`                                                                                    | Public        | [NAIF generic kernels](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/) |
| spice-moon-pa      | Lunar orientation `moon_pa_de440_200625.bpc`                                                                        | Public        | NAIF generic kernels                                                        |
| spice-moon-fk      | Lunar frames `moon_de440_250416.tf` (MOON_ME = MOON_ME_DE440_ME421)                                                 | Public        | NAIF generic kernels                                                        |
| spice-pck00011     | Planetary constants `pck00011.tpc`                                                                                  | Public        | NAIF generic kernels                                                        |
| spice-gm-de440     | Gravitational parameters `gm_de440.tpc`                                                                             | Public        | NAIF generic kernels                                                        |
| spice-naif0012     | Leap seconds `naif0012.tls`                                                                                         | Public        | NAIF generic kernels                                                        |
| spice-earth-hp     | Earth orientation `earth_latest_high_prec.bpc`                                                                      | Public        | NAIF generic kernels                                                        |
| lola-ldem-75s-240m | LRO LOLA south polar DEM `LDEM_75S_240M`, cropped to 700 × 700 at 1.2 km per pixel (from the Landfall concept demo) | Public domain | NASA PDS Geosciences, LOLA GDR polar products                               |
| landfall-polar-maps | Long-term sunlight, Earth visibility and never-sunlit flags on a 2.4 km grid, computed by the Landfall concept demo from the LOLA terrain above (2026-11-01 plus 19 years, 6 h steps). To be replaced by PGDA 69 (Mazarico et al. 2011). | Derived from public domain data | Landfall concept demo |

## Fonts

IBM Plex Sans and IBM Plex Sans Arabic, under the SIL Open Font License, served by Google Fonts.

## Libraries

React, React DOM, Zustand, i18next, react-i18next, uPlot, Vite, Tailwind CSS, Vitest, NumPy (BSD-3-Clause) and SpiceyPy are under the MIT licence unless noted. Comlink is under Apache-2.0. Biome is under MIT or Apache-2.0. TypeScript is under Apache-2.0.
