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
