import type { StayQuery } from '@siteline/contracts';
import { MOON_RADIUS_M, polarXY, siteFrame } from '@siteline/physics';

/**
 * Land Here: the helpers the interface needs before and around the surface view. The view itself (and its terrain, its
 * light and its walk) lives in `@siteline/engine/surface` and the physics worker.
 */

const DAY_MS = 86_400_000;

/** Where a landing was chosen: the site report, or a row of the passing-site search with that search's own readings. */
export type LandingSource =
  | { kind: 'report' }
  | { kind: 'passing'; sunFractionMin: number; earthVisiblePct: number; slope100mDeg: number };

/** The point to land on and the moment of touchdown, as the surface view receives them. */
export interface LandingTarget {
  latDeg: number;
  lonDeg: number;
  /**
   * The touchdown moment, UTC milliseconds: the landing date with the launch slip already in it. Everything after this
   * point uses it as it is, so the slip is never added a second time.
   */
  touchdownUtcMs: number;
  /** A place name to show, if the point came with one (a search region). */
  name?: string;
  source: LandingSource;
}

/**
 * The touchdown moment from the store's landing date and launch slip: the same moment the site report checks (its
 * `queryFor` adds the slip once, here) and the passing-site search searches.
 */
export function touchdownUtcMsOf(landingUtc: string, slipDays: number): number {
  return Date.parse(landingUtc) + slipDays * DAY_MS;
}

/** The touchdown moment of a stay query, whose landing date already carries the slip: nothing is added. */
export function touchdownFromQuery(query: Pick<StayQuery, 'landingUtc'>): number {
  return Date.parse(query.landingUtc);
}

/**
 * The terrain files' extents in LOLA's south polar plane, half the side of each square grid in metres, from the files'
 * own headers (CREDITS.md): `lola-spole-10m` is 43,280 cells of 10 m, `lola-ldem-75s-30m` 30,496 cells of 30 m. The
 * worker reads the headers themselves and is the final word; this only decides, before loading anything, whether the
 * button can be offered.
 */
export const TERRAIN_EXTENT = {
  fine: { id: 'lola-spole-10m', halfM: 216_400 },
  coarse: { id: 'lola-ldem-75s-30m', halfM: 457_440 },
} as const;

/** The walkable ring's half-width; a point closer than this to a grid's edge has its ground cut off. */
const NEAR_HALF_M = 2_000;

export type Coverage = 'fine' | 'coarse' | 'none';

/** Which terrain the walkable ground around a point would come from, before any is read. */
export function coverageAt(latDeg: number, lonDeg: number): Coverage {
  const { x, y } = polarXY(siteFrame(latDeg, lonDeg).u);
  const within = (halfM: number) => Math.abs(x) <= halfM - NEAR_HALF_M && Math.abs(y) <= halfM - NEAR_HALF_M;
  if (latDeg > 0) return 'none';
  if (within(TERRAIN_EXTENT.fine.halfM)) return 'fine';
  if (within(TERRAIN_EXTENT.coarse.halfM)) return 'coarse';
  return 'none';
}

/** The latitude a polar grid reaches straight along its axes, degrees (negative: south), from its half-width. */
export function gridReachLatDeg(halfM: number): number {
  return -(90 - (2 * Math.atan(halfM / (2 * MOON_RADIUS_M)) * 180) / Math.PI);
}

/**
 * Keeps only the newest of a series of requests: each `start` returns an id, and `isCurrent` says whether that id is
 * still the newest. Switching sites while one is loading, or cancelling, makes the older answer arrive to nothing.
 */
export function latestOnly() {
  let current = 0;
  return {
    start: (): number => ++current,
    isCurrent: (id: number): boolean => id === current,
    /** Makes every request so far stale. */
    cancel: (): void => {
      current++;
    },
  };
}
