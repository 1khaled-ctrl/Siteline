import type { StayQuery, StayResult } from '@siteline/contracts';
import {
  type Dem,
  type DemHorizon,
  type HeightSource,
  heightsFromDem,
  horizonFromHeights,
  polarToUnit,
  polarXY,
  unitToLatLon,
} from './dem';
import type { Ephemeris } from './ephemeris';
import { siteFrame } from './frames';
import { type StayInputs, stayBins, stayTest } from './stay';

export interface BestSpot {
  latDeg: number;
  lonDeg: number;
  /** 0 to 1: the least Sun fraction over the stay, with Earth visibility and a pass as tie-breakers. */
  score: number;
  result: StayResult;
}

export interface BestSearch {
  centreLatDeg: number;
  centreLonDeg: number;
  sizeKm: number;
  /** Points per side of the sampling grid. */
  grid?: number;
  top?: number;
  /**
   * How far each point's skyline is looked for, metres; the full 300 km by default. A shorter reach can only miss
   * ridges, never invent one, so it makes a quick screen more hopeful, not less: right for picking candidates that
   * a full check then confirms, wrong for a verdict.
   */
  reachM?: number;
}

export function scoreOf(r: StayResult): number {
  const sun = Number.isFinite(r.sunFractionMin) ? r.sunFractionMin : 0;
  const earth = Number.isFinite(r.earthVisiblePct) ? r.earthVisiblePct / 100 : 0;
  return 0.6 * sun + 0.3 * earth + (r.pass ? 0.1 : 0);
}

/**
 * A cache for the skylines: given a point, the bins wanted and the walk that fills bins, it answers with a skyline
 * holding at least those bins, walking only the ones it does not have yet.
 */
export type SkylineCache = (
  latDeg: number,
  lonDeg: number,
  bins: number[],
  walk: (bins: number[]) => DemHorizon | undefined,
) => DemHorizon | undefined;

/**
 * Sample a square around a region's centre, run the stay test at each point and rank them. Each skyline is walked only
 * in the directions the stay's Sun and Earth pass through (`stayBins`): the ranking reads nothing else.
 */
export function bestSpots(
  search: BestSearch,
  query: Omit<StayQuery, 'site'>,
  terrain: Dem | HeightSource,
  ephemeris: Ephemeris,
  inputs: Pick<StayInputs, 'sources' | 'stepMinutes'>,
  skylines?: SkylineCache,
): BestSpot[] {
  // A plain grid or a windowed source: the walk reads both the same way, and a source knows its own finest cell size.
  const heights = 'heightsM' in terrain ? heightsFromDem(terrain) : terrain;
  const stepM = 'heightsM' in terrain ? terrain.pixM : undefined;
  const grid = search.grid ?? 9;
  const centre = polarXY(siteFrame(search.centreLatDeg, search.centreLonDeg).u);
  const halfM = (search.sizeKm * 1000) / 2;
  const spots: BestSpot[] = [];
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const x = centre.x - halfM + (c / (grid - 1)) * 2 * halfM;
      const y = centre.y + halfM - (r / (grid - 1)) * 2 * halfM;
      const { latDeg, lonDeg } = unitToLatLon(polarToUnit(x, y));
      // Read where the skyline walk reads it, so the two agree on which points are on the terrain.
      const at = polarXY(siteFrame(latDeg, lonDeg).u);
      const groundM = heights.heightAt(at.x, at.y);
      if (Number.isNaN(groundM)) continue;
      const bins = stayBins(
        { ...query, site: { id: '', body: 'moon', latDeg, lonDeg, heightM: groundM } },
        ephemeris,
        inputs.stepMinutes,
      );
      const walk = (only: number[]) =>
        horizonFromHeights(heights, latDeg, lonDeg, {
          observerHeightM: query.observerHeightM,
          stepM,
          bins: only,
          ...(search.reachM ? { maxDistM: search.reachM } : {}),
        });
      const hz = skylines ? skylines(latDeg, lonDeg, bins, walk) : walk(bins);
      if (!hz) continue;
      const site = { id: `moon:${latDeg},${lonDeg}`, body: 'moon' as const, latDeg, lonDeg, heightM: hz.groundHeightM };
      const result = stayTest(
        { ...query, site },
        {
          ephemeris,
          horizon: hz.mask,
          slope100mDeg: Number.NaN,
          slope2kmPctUnder20: Number.NaN,
          timelineDays: 0,
          ...inputs,
        },
      );
      spots.push({ latDeg, lonDeg, score: scoreOf(result), result });
    }
  }
  return spots.sort((a, b) => b.score - a.score).slice(0, search.top ?? 5);
}
