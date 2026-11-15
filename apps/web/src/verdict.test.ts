import type { Reason, StayResult } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import en from './i18n/en.json';
import {
  bestOf,
  COLD_TRAP,
  cardFileName,
  checksOf,
  firstProblem,
  ICE_LEVELS,
  ICE_OUTLINE,
  ICE_SOURCES,
  iceDetectedLineOf,
  iceLineOf,
  rankSites,
  shareLink,
  verdictOf,
} from './verdict';

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

  it('carries the robot and its landing circle only when one is chosen', () => {
    const base = { landingUtc: '2028-03-03T00:00:00.000Z', slipDays: 0, latDeg: -89.45, lonDeg: -137.31 };
    const withRobot = new URL(
      shareLink('https://siteline.example/', { ...base, robot: 'rlldpTripod', landingRadiusM: 50 }),
    );
    expect(withRobot.searchParams.get('robot')).toBe('rlldpTripod');
    expect(withRobot.searchParams.get('ring')).toBe('50');
    const none = new URL(shareLink('https://siteline.example/', { ...base, robot: null, landingRadiusM: 50 }));
    expect(none.searchParams.has('robot')).toBe(false);
    expect(none.searchParams.has('ring')).toBe(false);
  });
});

describe('iceLineOf', () => {
  const stay = (iceDistanceKm?: number) => ({ reasons: [], slope100mDeg: 1, iceDistanceKm }) as unknown as StayResult;

  it('gives the distance to the nearest permanent shadow, and says when the site itself is in one', () => {
    expect(iceLineOf(stay(2.4))).toEqual({ distanceKm: 2.4, atSite: false, level: 'canLast' });
    expect(iceLineOf(stay(0))).toEqual({ distanceKm: 0, atSite: true, level: 'canLast' });
  });

  it('gives nothing where the maps carry no distance, rather than a made-up one', () => {
    expect(iceLineOf(stay(undefined))).toBeUndefined();
    expect(iceLineOf(stay(Number.NaN))).toBeUndefined();
    expect(iceLineOf(stay(-1))).toBeUndefined();
  });

  it('never changes the verdict: it is not one of the checks', () => {
    const near = stay(0.1);
    const far = stay(40);
    expect(verdictOf(checksOf(near))).toBe(verdictOf(checksOf(far)));
    expect(Object.keys(checksOf(near))).not.toContain('ice');
  });
});

describe('iceDetectedLineOf', () => {
  it('gives the distance to the nearest ice-bearing region, and says when the site is within its outline', () => {
    expect(iceDetectedLineOf({ id: 'lemelin-2021-ice-psrs', distanceKm: 3.2, inside: false })).toEqual({
      distanceKm: 3.2,
      withinOutline: false,
      level: 'detectedNearby',
      id: 'lemelin-2021-ice-psrs',
    });
    expect(iceDetectedLineOf({ id: 'lemelin-2021-ice-psrs', distanceKm: 0, inside: true })?.withinOutline).toBe(true);
  });

  it('gives nothing without a region, rather than a made-up distance', () => {
    expect(iceDetectedLineOf(undefined)).toBeUndefined();
    expect(iceDetectedLineOf({ id: 'x', distanceKm: Number.NaN, inside: false })).toBeUndefined();
    expect(iceDetectedLineOf({ id: 'x', distanceKm: -1, inside: false })).toBeUndefined();
  });
});

describe('ice evidence wording', () => {
  it('names four levels, weakest first, and each reading only ever shows its own', () => {
    expect(ICE_LEVELS).toEqual(['canLast', 'consistent', 'detectedNearby', 'detected']);
    for (const km of [0, 0.4, 12, 80]) {
      expect(iceLineOf({ reasons: [], slope100mDeg: 1, iceDistanceKm: km } as unknown as StayResult)?.level).toBe(
        'canLast',
      );
      expect(iceDetectedLineOf({ id: 'lemelin-2021-ice-psrs', distanceKm: km, inside: km === 0 })?.level).toBe(
        'detectedNearby',
      );
    }
    // Every level has its words, and the note names the three kinds of evidence.
    for (const level of ICE_LEVELS) expect(en.report.iceLevels[level]).toBeTruthy();
    expect(en.report.iceEvidence).toMatch(/can last.*consistent with ice.*detected/s);
  });

  it('says what the detected-nearby distance is measured to, with its caveats, and takes its 280 m from the data', () => {
    expect(en.report.iceDetectedKm).toBe(
      '{{km}} km to a shadowed region where M3 detected surface ice (<link>Lemelin et al. 2021</link>)',
    );
    expect(en.report.iceDetectedNote).toContain(
      'Distance to the outline of a shadowed region, which extends {{m}} m beyond the shadow itself',
    );
    expect(en.report.iceDetectedNote).toContain('patchy and low in abundance');
    expect(en.report.iceDetectedNote).toContain('not a guarantee of ice at this site');
    // The figure is the paper's one M3 pixel, filled in from ICE_OUTLINE, never typed into the words.
    expect(ICE_OUTLINE).toEqual({ beyondShadowM: 280, source: ICE_SOURCES.detectedNearby });
    expect(en.report.iceDetectedNote).not.toContain('280');
    expect(en.sources.methods.ice).not.toContain('280');
  });

  it("shows NASA's two figures for a cold trap as NASA prints them, which agree to within its rounding", () => {
    expect(COLD_TRAP).toMatchObject({ belowF: -260, belowC: -163 });
    // −260 °F is −162.2 °C: NASA rounds both, so they agree to about a degree, and neither is worked out here.
    expect(Math.abs(((COLD_TRAP.belowF - 32) * 5) / 9 - COLD_TRAP.belowC)).toBeLessThan(1);
    expect(COLD_TRAP.source).toBe(ICE_SOURCES.coldTraps);
  });

  it('links every source by https, and names no URL twice', () => {
    const urls = Object.values(ICE_SOURCES);
    for (const url of urls) expect(url).toMatch(/^https:\/\//);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('never says ice is at a place, that it was found at the Artemis sites, or that it lies in large fields', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(en);
    const overstated =
      /\bice is here\b|found ice|ice (was|has been) found at the artemis|ice fields?\b|large (ice|deposits)/i;
    // The pattern itself catches what it guards against, so an empty list means something.
    for (const bad of ['Ice is here.', 'NASA found ice at the Artemis sites.', 'Large ice fields at the pole.']) {
      expect(overstated.test(bad), bad).toBe(true);
    }
    expect(overstated.test('Ice can last there, not that ice is there.')).toBe(false);
    expect(strings.length).toBeGreaterThan(100);
    expect(strings.filter((x) => overstated.test(x))).toEqual([]);
  });
});
