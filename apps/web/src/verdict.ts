import type { Reason, StayResult } from '@siteline/contracts';

export type Check = 'yes' | 'no' | 'unknown';
export type CheckKey = 'sun' | 'earth' | 'slope' | 'zone';
export type Verdict = 'pass' | 'fail' | 'undecided';
export const CHECK_KEYS: readonly CheckKey[] = ['sun', 'earth', 'slope', 'zone'];

/**
 * The four checks of a stay. Sun and Earth are unknown without the ephemeris for the dates; the slope is unknown when
 * the terrain is too coarse to measure it.
 */
export function checksOf(r: StayResult): Record<CheckKey, Check> {
  const has = (code: Reason['code']) => r.reasons.some((x) => x.code === code);
  const noEphemeris = r.reasons.some((x) => x.code === 'NO_DATA' && x.detail.missing === 'ephemeris');
  const light = (code: Reason['code']): Check => (noEphemeris ? 'unknown' : has(code) ? 'no' : 'yes');
  return {
    sun: light('SUN_BELOW_HORIZON'),
    earth: light('EARTH_BELOW_HORIZON'),
    slope: Number.isFinite(r.slope100mDeg) ? (has('SLOPE_TOO_STEEP') ? 'no' : 'yes') : 'unknown',
    zone: has('OUTSIDE_ZONE') ? 'no' : 'yes',
  };
}

/** Any failed check fails the site; otherwise any unknown one leaves it undecided. */
export function verdictOf(checks: Readonly<Record<CheckKey, Check>>): Verdict {
  const all = Object.values(checks);
  return all.includes('no') ? 'fail' : all.includes('unknown') ? 'undecided' : 'pass';
}

export interface RankInput {
  verdict: Verdict;
  earthVisiblePct: number;
  /** Sunlight over the 19-year cycle, where the long-term maps cover the spot. */
  longTermSunPct?: number;
}

const VERDICT_ORDER: Record<Verdict, number> = { pass: 0, undecided: 1, fail: 2 };
const orLow = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY);

/**
 * The sites best first, by a rule simple enough to state on screen: the stay's verdict, then sunlight over 19 years,
 * then the time Earth is in view. Sites still being checked (undefined) are left out.
 */
export function rankSites(rows: readonly (RankInput | undefined)[]): number[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: RankInput; i: number } => x.r !== undefined)
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.r.verdict] - VERDICT_ORDER[b.r.verdict] ||
        orLow(b.r.longTermSunPct) - orLow(a.r.longTermSunPct) ||
        orLow(b.r.earthVisiblePct) - orLow(a.r.earthVisiblePct) ||
        a.i - b.i,
    )
    .map((x) => x.i);
}

/** Which entries hold the highest value, when at least two values can be compared and they are not all equal. */
export function bestOf(values: readonly (number | undefined)[]): Set<number> {
  const known = values.map((v, i) => ({ v, i })).filter((x) => x.v !== undefined && Number.isFinite(x.v));
  if (known.length < 2) return new Set();
  const top = Math.max(...known.map((x) => x.v as number));
  const winners = known.filter((x) => x.v === top);
  return winners.length === known.length ? new Set() : new Set(winners.map((x) => x.i));
}

export interface Problem {
  /** The reason's code, with what is missing for NO_DATA (`NO_DATA_ephemeris`). */
  key: string;
  atUtc?: string;
  /** Already true at the landing moment, rather than something that happens later in the stay. */
  atLanding: boolean;
}

/**
 * The first thing that goes wrong in a stay. The note that the slope is not measured is skipped: every site carries it
 * until finer terrain is loaded, so it would hide the problem that differs between sites.
 */
export function firstProblem(reasons: readonly Reason[], landingMs: number): Problem | undefined {
  const first = reasons.find((r) => !(r.code === 'NO_DATA' && r.detail.missing === 'slope'));
  if (!first) return undefined;
  return {
    key: first.code === 'NO_DATA' ? `NO_DATA_${first.detail.missing}` : first.code,
    atUtc: first.atUtc,
    atLanding: first.atUtc !== undefined && Date.parse(first.atUtc) <= landingMs,
  };
}

/** The share card's file name: place and landing day, readable and safe in any file system. */
export function cardFileName(latDeg: number, lonDeg: number, landingUtc: string): string {
  const place = `${Math.abs(latDeg)}${latDeg < 0 ? 'S' : 'N'}_${Math.abs(lonDeg)}${lonDeg < 0 ? 'W' : 'E'}`;
  return `siteline-${place}-${landingUtc.slice(0, 10)}.png`;
}

export interface ShareState {
  landingUtc: string;
  slipDays: number;
  latDeg: number;
  lonDeg: number;
}

/** A link that opens the south-pole check on this spot, landing date and slip. */
export function shareLink(base: string, s: ShareState): string {
  const p = new URLSearchParams({
    view: 'pole',
    t: s.landingUtc,
    slip: String(s.slipDays),
    lat: String(s.latDeg),
    lon: String(s.lonDeg),
  });
  return `${base}?${p}`;
}
