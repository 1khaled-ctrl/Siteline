import type { FitOverall } from '@siteline/physics';
import type { PassingSite } from './physics.worker';

/**
 * The landing agent's own logic, kept out of the interface so it can be tested: which regions a request means, which
 * date it means, and how the sites it found are ranked. The searching itself is the worker's (`physics.passing`), the
 * same search the side panel's "Find a site that passes" runs, so the agent can only offer sites the report passes.
 */

export interface NamedArea {
  name: string;
  lat: number;
  lon: number;
  sizeKm: number;
}

/** A passing site, with the region it was found in and, when a robot was asked about, whether it fits there. */
export interface FoundSite extends PassingSite {
  region: string;
  robotFit?: FitOverall;
}

const loose = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The regions a request names, matched loosely ("nobile" finds "Nobile Rim 1" and "Nobile Rim 2"). No names, or none
 * that match, means every region: a search with nothing to search would only waste the visitor's wait.
 */
export function pickRegions<T extends NamedArea>(all: readonly T[], names?: readonly unknown[]): T[] {
  const wanted = (names ?? []).filter((n): n is string => typeof n === 'string' && loose(n) !== '').map(loose);
  if (wanted.length === 0) return [...all];
  const picked = all.filter((r) => wanted.some((w) => loose(r.name).includes(w) || w.includes(loose(r.name))));
  return picked.length ? picked : [...all];
}

/**
 * The landing date a tool was given, as ISO 8601 UTC, or `fallback` when none was. A date outside the tables' range
 * is an error the model reads and can correct, never a date quietly moved.
 */
export function landingDate(input: unknown, fallback: string, firstMs: number, lastMs: number): string {
  if (input === undefined || input === null || input === '') return fallback;
  const ms = typeof input === 'string' ? Date.parse(input) : Number.NaN;
  if (!Number.isFinite(ms))
    throw new Error(`"${String(input)}" is not a date; use ISO 8601 such as 2028-03-01T00:00:00Z`);
  if (ms < firstMs || ms > lastMs)
    throw new Error(
      `SiteLine's tables cover ${new Date(firstMs).toISOString().slice(0, 10)} to ${new Date(lastMs).toISOString().slice(0, 10)}`,
    );
  return new Date(ms).toISOString();
}

const FIT_ORDER: Record<FitOverall | 'none', number> = { fits: 0, not_enough_data: 1, none: 1, does_not_fit: 2 };

/**
 * Best first, by a rule short enough to say aloud: a robot that fits beats one that doesn't, then the most Sun at the
 * worst moment of the stay, then the most time with Earth in view, then the flattest ground. The same order the side
 * panel's search uses, with the robot in front.
 */
export function rankFound(sites: readonly FoundSite[]): FoundSite[] {
  return [...sites].sort(
    (a, b) =>
      FIT_ORDER[a.robotFit ?? 'none'] - FIT_ORDER[b.robotFit ?? 'none'] ||
      b.sunFractionMin - a.sunFractionMin ||
      b.earthVisiblePct - a.earthVisiblePct ||
      a.slope100mDeg - b.slope100mDeg,
  );
}

/** A coordinate from a tool's arguments, or an error the model can read. */
export function coordinate(v: unknown, name: string, min: number, max: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  return n;
}
