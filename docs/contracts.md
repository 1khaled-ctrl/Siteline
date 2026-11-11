# Contracts

These are the shared shapes every role codes against. At kickoff the integrator turns this file into `packages/contracts` (TypeScript types plus JSON Schemas) and merges it by 10:30. After that, only the integrator changes contracts, once the affected owners agree in the issue.

## Types (from the build plan)

```ts
export type Body = 'moon' | 'mars' | 'earth';

export interface Site {
  id: string;
  body: Body;
  latDeg: number;
  lonDeg: number; // east-positive, -180..180
  heightM?: number;
  regionId?: string;
  name?: { en: string; ar: string };
}

export interface StayQuery {
  site: Site;
  landingUtc: string; // ISO 8601
  stayDays: number; // default 6.5
  minSunFraction: number; // default 0.5
  earthRule: 'rim' | 'centre' | 'margin2deg';
  observerHeightM: number; // 0, 2 or 10
}

export interface Reason {
  code: 'SUN_BELOW_HORIZON' | 'EARTH_BELOW_HORIZON' | 'SLOPE_TOO_STEEP' | 'OUTSIDE_ZONE' | 'NO_DATA';
  atUtc?: string;
  detail: Record<string, number | string>;
}

export interface StayResult {
  pass: boolean;
  uncertain: boolean;
  reasons: Reason[];
  sunFractionMin: number;
  earthVisiblePct: number;
  nextSunsetUtc?: string;
  nextSunriseUtc?: string;
  nextEarthsetUtc?: string;
  nextEarthriseUtc?: string;
  slope100mDeg: number;
  slope2kmPctUnder20: number;
  iceDistanceKm?: number;
  series: { tUtcMs: Float64Array; sun: Float32Array; earth: Float32Array };
  sources: string[]; // dataset ids from CREDITS.md
}
```

Pass rule from the plan: the minimum Sun fraction over the stay is at least 0.5, the minimum Earth fraction over the stay is at least 0.5, and `slope100mDeg` is under 10°.

## Store events

The engine and the interface talk only through the shared Zustand store. The four event names come from the plan; the payloads are proposals.

| Event           | Proposed payload                                         | Emitted by                                   | Handled by                       |
| --------------- | -------------------------------------------------------- | -------------------------------------------- | -------------------------------- |
| `site/selected` | `Site`                                                   | engine (click), ui (list or search), copilot | ui (report), physics worker      |
| `time/changed`  | `{ tUtcMs, slipDays }`                                   | ui (date control, slider), copilot           | engine (shadows), physics worker |
| `layer/toggled` | `{ layerId, on }`                                        | ui, copilot                                  | engine                           |
| `camera/flyTo`  | `{ targetId, view: 'orbit' \| 'site' \| 'firstPerson' }` | ui, copilot                                  | engine                           |

## Physics API (`apps/api`)

Documented in OpenAPI under `docs/`. The TypeScript client types are generated from the OpenAPI schema.

| Endpoint           | In                       | Out                                                 |
| ------------------ | ------------------------ | --------------------------------------------------- |
| `POST /v1/stay`    | `StayQuery`              | `StayResult` in its JSON wire form (see question 2) |
| `POST /v1/horizon` | site and observer height | 720 horizon elevations, one every 0.5° of azimuth   |
| `POST /v1/best`    | region id and a query    | ranked spots                                        |
| `GET /v1/health`   |                          | status                                              |

## Copilot tools

`analyze_site`, `compare_sites`, `find_best`, `set_date`, `set_slip`, `fly_to`, `toggle_layer`, `list_missions`, `show_mission`, `launch_windows`, `explain`, `export_report`. The inputs are listed in the plan's copilot section.

Each tool's input is a JSON Schema in this package. The browser validates every tool input against it before running anything. The copilot uses strict tool use, so every schema needs `additionalProperties: false` and a `required` list.

## Open questions

The first build in `packages/physics` already does the following. Change any of them by agreement:

- It adds sunrise and Earthrise fields (question 1).
- It treats being more than 6° from the pole as a fail (question 3).
- It applies `earthRule` (question 4).
- It samples every 20 minutes by default (question 6).
- It indexes the ephemeris table by UTC milliseconds, so the browser never converts to TDB.

1. **Feature 13 needs sunrise and Earthrise too.** `StayResult` has `nextSunsetUtc` and `nextEarthsetUtc` but nothing for sunrise or Earthrise. Proposal: add `nextSunriseUtc?` and `nextEarthriseUtc?`.
2. **Typed arrays don't survive JSON.** Typed arrays pass fine between the worker and the UI over Comlink (transfer their buffers). But `JSON.stringify(new Float32Array([1, 2]))` gives `{"0":1,"1":2}`, so API responses and copilot tool results would come out wrong. Proposal: define `StayResultJson` with plain `number[]` series. Send the copilot a summary only: 720 hourly samples per series would cost thousands of tokens per tool call.
3. **What counts as a fail.** The pass rule has no latitude check, but `OUTSIDE_ZONE` exists and the UI copy says "outside NASA's Artemis zone". The walking-area rule (under 20° over 2 km) has no reason code. Proposal: being more than 6° from the pole is a fail, and walking-area slope is reported but not a fail, as the formula implies.
4. **The Earth rule.** The pass rule hard-codes an Earth fraction of 0.5 or more, but `StayQuery` has `earthRule`. Proposal: rim means a fraction above 0, centre means 0.5 or more, and margin2deg means Earth's centre at least 2° above the horizon. Also add `earthFractionMin` alongside `sunFractionMin`.
5. **Why a result is uncertain.** `uncertain` is a bare boolean, but the plan says the report explains why. Proposal: add `uncertainReasons: Reason[]`.
6. **Hourly sampling can miss a dip.** The Sun moves about 0.5° of azimuth per hour, the width of one horizon bin, so a narrow peak can hide it between two hourly samples and the stay test would pass a site that goes dark. Proposal: sample every 20 minutes, or refine wherever the margin to the horizon is small. Four sites × 31 dates × 471 samples is still a few milliseconds.
7. **Longitude ±180°.** Proposal: use the half-open range [−180°, 180°) so share links and site ids never have two spellings for one spot.
8. **Dataset ids.** `sources` and the copilot's `[LOLA 10 m]` citations use the `id` and `label` columns of the dataset inventory, which also generates CREDITS.md.
