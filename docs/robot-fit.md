# Fit for a robot

The site report's own verdict (Sun, Earth, slope, zone) answers whether a spot is a good place to be. The *Fit for a
robot* card under it answers a second question: does this spot suit one particular lander or robot, as far as its
published needs go? It never changes the site's own verdict.

## Robots and where each need comes from

| Robot | Needs set from a source | Left unknown |
| --- | --- | --- |
| NASA RLLDP tripod (2012 concept) | Solar by day, batteries at night, S-band to Earth, two landing cameras (Table 1); ~100 m landing accuracy (§5.3) | Battery size, loads, slope limit |
| NASA RLLDP pallet with rover (2012 concept) | Solar panel dropped during landing, battery for cruise and landing only, X-band low-gain antenna, ~400 kg rover (Table 2); ~100 m accuracy | Light need for its terrain navigation, slope limit |
| IM-2 Athena's site criteria | Lit landing corridor, acceptable slope; Grace hopper surveys shadowed craters (NASA, 24 Feb 2025) | Every vehicle number |
| Artemis IV crew | Two crew, about a week near the South Pole (NASA mission page) | The lander's needs |

Sources are rows in `CREDITS.md`: `nasa-rlldp-2012`, `nasa-m2m-landing-2023`, `nasa-im2-tech-2025`,
`nasa-artemis-iv`. The RLLDP paper's Warm Gas Test Article is a ground test bed and is not used as either concept.

## Checks (`packages/physics/src/mission.ts`)

| Check | How | Verdict |
| --- | --- | --- |
| Landing circle | The site's own landing-slope rule (plane fit within 50 m) at every 10 m cell centre within 50 or 100 m of the aim: NASA's precision-landing range (Moon to Mars white paper, §2, Fig. 3) | Fail if any touchdown point is 10° or steeper; unknown off the 10 m terrain |
| Lit at landing | The stay check's own sample at the landing time | For robots whose sources need light to land |
| Longest darkness | Longest run of samples with none of the Sun's disc above the skyline, within the stay; good to one 20-minute step | Never a pass for a battery robot unless there is no darkness, because battery sizes aren't published |
| Earth in view | The stay check's Earth share | Pass only at 100 %; partial is unknown (no source gives a continuity need); line of sight only, no link budget |
| Ground | Walkable share for rover or crew; distance to permanent shadow for the hopper | Shown as a fact, with no verdict |
| Nearest lander | Great-circle distance on the 1737.4 km sphere to the nearest mission in `missions.json` | Shown with the cited Apollo 12 / Surveyor 3 distance for scale; no keep-out radius is invented |

Overall: *does not fit* if any check fails, *not enough data* if any is unknown, *fits* only if every check that
applies passes.

## Limits

- 10 m terrain cannot show rocks, small craters or footpad contacts. No tip-over, touchdown-dynamics or descent
  model is attempted.
- The slope limit is SiteLine's 10° rule for every robot, and the card says so: none of the sources publishes one.
- Sun in view is not power, and Earth in view is not a radio link.
- IM-2's planned target coordinates and miss distance are not used: NASA's pages give no coordinates, and two NASA
  statements of the miss distance disagree.
