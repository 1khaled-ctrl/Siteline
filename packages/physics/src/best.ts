import type { StayQuery, StayResult } from '@siteline/contracts';
import {
  type Dem,
  type HeightSource,
  heightsFromDem,
  horizonFromHeights,
  polarToUnit,
  polarXY,
  unitToLatLon,
} from './dem';
import type { Ephemeris } from './ephemeris';
import { siteFrame } from './frames';
import { type StayInputs, stayTest } from './stay';

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
}

export function scoreOf(r: StayResult): number {
  const sun = Number.isFinite(r.sunFractionMin) ? r.sunFractionMin : 0;
  const earth = Number.isFinite(r.earthVisiblePct) ? r.earthVisiblePct / 100 : 0;
  return 0.6 * sun + 0.3 * earth + (r.pass ? 0.1 : 0);
}

/** Sample a square around a region's centre, run the stay test at each point and rank them. */
export function bestSpots(
  search: BestSearch,
  query: Omit<StayQuery, 'site'>,
  terrain: Dem | HeightSource,
  ephemeris: Ephemeris,
  inputs: Pick<StayInputs, 'sources' | 'stepMinutes'>,
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
      const hz = horizonFromHeights(heights, latDeg, lonDeg, { observerHeightM: query.observerHeightM, stepM });
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
