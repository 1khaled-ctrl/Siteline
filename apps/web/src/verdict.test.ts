import type { Reason, StayResult } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import { bestOf, cardFileName, checksOf, firstProblem, rankSites, shareLink, verdictOf } from './verdict';

function result(reasons: Reason[], slope100mDeg = Number.NaN): StayResult {
  return {
    pass: false,
    uncertain: false,
    reasons,
    sunFractionMin: 1,
    earthVisiblePct: 100,
    slope100mDeg,
    slope2kmPctUnder20: 0,
    series: { tUtcMs: new Float64Array(), sun: new Float32Array(), earth: new Float32Array() },
    sources: [],
  };
}
const reason = (code: Reason['code'], detail: Reason['detail'] = {}): Reason => ({ code, detail });

describe('checksOf', () => {
  it('reads each failure into its own check', () => {
    const c = checksOf(result([reason('SUN_BELOW_HORIZON'), reason('OUTSIDE_ZONE')], 4));
    expect(c).toEqual({ sun: 'no', earth: 'yes', slope: 'yes', zone: 'no' });
  });

  it('calls the slope unknown when the terrain could not measure it, and a steep one a fail', () => {
    expect(checksOf(result([])).slope).toBe('unknown');
    expect(checksOf(result([reason('SLOPE_TOO_STEEP')], 14)).slope).toBe('no');
  });

  it('calls Sun and Earth unknown when the dates are outside the ephemeris', () => {
    const c = checksOf(result([reason('NO_DATA', { missing: 'ephemeris' })], 3));
    expect(c.sun).toBe('unknown');
    expect(c.earth).toBe('unknown');
  });
});

describe('verdictOf', () => {
  it('fails on any no, even beside an unknown', () => {
    expect(verdictOf({ sun: 'no', earth: 'yes', slope: 'unknown', zone: 'yes' })).toBe('fail');
  });
  it('is undecided on an unknown with no failure', () => {
    expect(verdictOf({ sun: 'yes', earth: 'yes', slope: 'unknown', zone: 'yes' })).toBe('undecided');
  });
  it('passes only when every check passes', () => {
    expect(verdictOf({ sun: 'yes', earth: 'yes', slope: 'yes', zone: 'yes' })).toBe('pass');
  });
});

describe('rankSites', () => {
  it('puts a passing site first, whatever its sunlight', () => {
    const order = rankSites([
      { verdict: 'fail', earthVisiblePct: 100, longTermSunPct: 90 },
      { verdict: 'pass', earthVisiblePct: 40, longTermSunPct: 20 },
      { verdict: 'undecided', earthVisiblePct: 80, longTermSunPct: 85 },
    ]);
    expect(order).toEqual([1, 2, 0]);
  });

  it('breaks a tie on the verdict by 19-year sunlight, then by Earth in view', () => {
    const order = rankSites([
      { verdict: 'undecided', earthVisiblePct: 50, longTermSunPct: 70 },
      { verdict: 'undecided', earthVisiblePct: 90, longTermSunPct: 70 },
      { verdict: 'undecided', earthVisiblePct: 10, longTermSunPct: 80 },
    ]);
    expect(order).toEqual([2, 1, 0]);
  });

  it('ranks a spot outside the long-term maps below one inside them, and skips sites still being checked', () => {
    const order = rankSites([
      { verdict: 'fail', earthVisiblePct: 100 },
      undefined,
      { verdict: 'fail', earthVisiblePct: 0, longTermSunPct: 1 },
    ]);
    expect(order).toEqual([2, 0]);
  });
});

describe('bestOf', () => {
  it('marks the highest value, and every one that ties for it', () => {
    expect([...bestOf([10, 74, 53])]).toEqual([1]);
    expect([...bestOf([74, 10, 74])]).toEqual([0, 2]);
  });

  it('marks nothing when there is nothing to choose between', () => {
    expect(bestOf([53]).size).toBe(0);
    expect(bestOf([53, 53]).size).toBe(0);
    expect(bestOf([undefined, 53, Number.NaN]).size).toBe(0);
  });
});

describe('firstProblem', () => {
  const landing = Date.parse('2028-04-08T00:00:00Z');
  const at = (code: Reason['code'], atUtc: string): Reason => ({ code, atUtc, detail: {} });

  it('skips the slope note every site carries, to show the problem that differs', () => {
    const p = firstProblem(
      [reason('NO_DATA', { missing: 'slope' }), at('EARTH_BELOW_HORIZON', '2028-04-09T14:00:00Z')],
      landing,
    );
    expect(p).toEqual({ key: 'EARTH_BELOW_HORIZON', atUtc: '2028-04-09T14:00:00Z', atLanding: false });
  });

  it('says when the problem is already there at landing', () => {
    expect(firstProblem([at('SUN_BELOW_HORIZON', '2028-04-08T00:00:00.000Z')], landing)?.atLanding).toBe(true);
  });

  it('names what is missing for NO_DATA, and finds nothing when only the slope note is left', () => {
    expect(firstProblem([reason('NO_DATA', { missing: 'ephemeris' })], landing)?.key).toBe('NO_DATA_ephemeris');
    expect(firstProblem([reason('NO_DATA', { missing: 'slope' })], landing)).toBeUndefined();
    expect(firstProblem([], landing)).toBeUndefined();
  });
});

describe('cardFileName', () => {
  it('names the spot with hemispheres instead of minus signs, and the landing day', () => {
    expect(cardFileName(-89.45, -137.31, '2028-03-05T00:00:00.000Z')).toBe('siteline-89.45S_137.31W-2028-03-05.png');
    expect(cardFileName(12.5, 30, '2030-01-01T06:00:00.000Z')).toBe('siteline-12.5N_30E-2030-01-01.png');
  });
});

describe('shareLink', () => {
  it('opens the south-pole check with the same date, slip and spot', () => {
    const link = shareLink('https://siteline.example/', {
      landingUtc: '2028-03-03T00:00:00.000Z',
      slipDays: -2,
      latDeg: -89.45,
      lonDeg: 222.69 - 360,
    });
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe('https://siteline.example/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      open: 'pole',
      t: '2028-03-03T00:00:00.000Z',
      slip: '-2',
      lat: '-89.45',
      lon: String(222.69 - 360),
    });
  });
});
