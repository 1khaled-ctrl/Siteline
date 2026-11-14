import { describe, expect, it } from 'vitest';
import {
  landingCircle,
  longestDarkHours,
  moonDistanceKm,
  type RobotNeeds,
  robotFit,
  type SiteFacts,
  sunFractionAt,
} from './mission';
import type { HeightWindow } from './slope';

const N = 41;
const MID = 20;
const PIX_M = 10;

/** A window of heights at the pole (scale factor 1), the site in its middle cell. */
function window(height: (xM: number, yM: number) => number): HeightWindow {
  const heightsM = new Float64Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) heightsM[r * N + c] = height((c - MID) * PIX_M, (MID - r) * PIX_M);
  }
  return { heightsM, n: N, pixM: PIX_M, col: MID, row: MID };
}

const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

describe('landingCircle', () => {
  it('finds nothing steep on flat ground', () => {
    const c = landingCircle(
      window(() => 100),
      -90,
      100,
      10,
    );
    expect(c?.worstDeg).toBeCloseTo(0, 9);
    expect(c?.steepPct).toBe(0);
    expect(c?.points).toBeGreaterThan(300);
  });

  it('reads a uniform tilt as that tilt everywhere', () => {
    const gentle = landingCircle(
      window((x) => x * tan(5)),
      -90,
      100,
      10,
    );
    expect(gentle?.worstDeg).toBeCloseTo(5, 6);
    expect(gentle?.steepPct).toBe(0);
    const steep = landingCircle(
      window((x) => x * tan(15)),
      -90,
      100,
      10,
    );
    expect(steep?.steepPct).toBe(100);
  });

  it('catches a slope a 100 m circle reaches and a 50 m one does not, as in NASA’s precision-landing figure', () => {
    // Flat ground with a 45° bank from 105 m east. A point's landing slope reads the ground within 50 m of it, so the
    // bank is out of reach from anywhere within 50 m of the site, and well within it from 100 m out.
    const bank = window((x) => (x > 105 ? (x - 105) * tan(45) : 0));
    expect(landingCircle(bank, -90, 50, 10)?.steepPct).toBe(0);
    const wide = landingCircle(bank, -90, 100, 10);
    expect(wide?.steepPct).toBeGreaterThan(0);
    expect(wide?.worstDeg).toBeGreaterThan(10);
  });

  it('is undefined where the terrain has no data', () => {
    expect(
      landingCircle(
        window(() => Number.NaN),
        -90,
        100,
        10,
      ),
    ).toBeUndefined();
  });

  it('rejects a radius that is not a length', () => {
    const w = window(() => 0);
    expect(() => landingCircle(w, -90, Number.NaN, 10)).toThrow();
    expect(() => landingCircle(w, -90, -5, 10)).toThrow();
  });
});

const STEP_MS = 20 * 60_000;
const T0 = Date.parse('2027-01-01T00:00:00Z');
/** A timeline of `n` 20-minute samples, dark where `dark(k)`. */
const series = (n: number, dark: (k: number) => boolean) => ({
  tUtcMs: Float64Array.from({ length: n }, (_, k) => T0 + k * STEP_MS),
  sun: Float32Array.from({ length: n }, (_, k) => (dark(k) ? 0 : 0.8)),
});

describe('longestDarkHours', () => {
  it('is zero when the Sun is never fully hidden', () => {
    expect(
      longestDarkHours(
        series(100, () => false),
        T0,
        T0 + 30 * 3_600_000,
      ),
    ).toBe(0);
  });

  it('times the longest dark run to the sample', () => {
    // Dark at samples 10–15 (two hours), and at 40–42 (one hour).
    const s = series(100, (k) => (k >= 10 && k < 16) || (k >= 40 && k < 43));
    expect(longestDarkHours(s, T0, T0 + 30 * 3_600_000)).toBeCloseTo(2, 9);
  });

  it('stops a run that is still dark at the end of the stay', () => {
    const s = series(100, (k) => k >= 90);
    expect(longestDarkHours(s, T0, T0 + 90 * STEP_MS + 3_600_000)).toBeCloseTo(1, 9);
  });

  it('only counts darkness inside the stay', () => {
    const s = series(100, (k) => k < 30);
    expect(longestDarkHours(s, T0 + 30 * STEP_MS, T0 + 60 * STEP_MS)).toBe(0);
  });

  it('is NaN when the timeline does not cover the stay', () => {
    expect(
      longestDarkHours(
        series(10, () => false),
        T0,
        T0 + 30 * 3_600_000,
      ),
    ).toBeNaN();
    expect(
      longestDarkHours(
        series(0, () => false),
        T0,
        T0 + 1,
      ),
    ).toBeNaN();
  });
});

describe('sunFractionAt', () => {
  it('reads the nearest sample, and NaN off the timeline', () => {
    const s = series(10, (k) => k === 0);
    expect(sunFractionAt(s, T0)).toBe(0);
    expect(sunFractionAt(s, T0 + STEP_MS)).toBeCloseTo(0.8, 6);
    expect(sunFractionAt(s, T0 - 3_600_000)).toBeNaN();
  });
});

describe('moonDistanceKm', () => {
  it('is one degree of the 1737.4 km sphere along the equator', () => {
    expect(moonDistanceKm(0, 0, 0, 1)).toBeCloseTo((2 * Math.PI * 1737.4) / 360, 6);
  });
  it('wraps across ±180° longitude', () => {
    expect(moonDistanceKm(0, 179.5, 0, -179.5)).toBeCloseTo(moonDistanceKm(0, 0, 0, 1), 6);
  });
  it('is zero between two points at the pole whatever their longitude', () => {
    expect(moonDistanceKm(-90, 0, -90, 120)).toBeCloseTo(0, 6);
  });
});

const NEEDS: RobotNeeds = {
  litLanding: 'required',
  power: 'solar',
  night: 'battery',
  comms: 'direct_to_earth',
  mobility: 'stationary',
};
const FLAT = { radiusM: 100, limitDeg: 10, points: 300, worstDeg: 3, steepPct: 0 };
const facts = (patch: Partial<SiteFacts> = {}): SiteFacts => ({
  stayStartMs: T0,
  stayEndMs: T0 + 30 * 3_600_000,
  series: series(100, () => false),
  earthVisiblePct: 100,
  circle: FLAT,
  walkablePct: 70,
  shadowDistanceKm: 2,
  ...patch,
});
const check = (fit: ReturnType<typeof robotFit>, id: string) => fit.checks.find((c) => c.id === id);

describe('robotFit', () => {
  it('fits when every check that applies passes', () => {
    expect(robotFit(NEEDS, facts()).overall).toBe('fits');
  });

  it('never calls darkness a pass for a battery robot whose battery is not published', () => {
    const fit = robotFit(NEEDS, facts({ series: series(100, (k) => k >= 10 && k < 16) }));
    expect(check(fit, 'darkness')).toMatchObject({ status: 'unknown', reason: 'battery_size_unknown' });
    expect(check(fit, 'darkness')?.values.darkH).toBeCloseTo(2, 9);
    expect(fit.overall).toBe('not_enough_data');
  });

  it('does not judge darkness for a lander with no power of its own on the surface', () => {
    const fit = robotFit({ ...NEEDS, power: 'none' }, facts({ series: series(100, (k) => k > 5) }));
    expect(check(fit, 'darkness')?.status).toBe('not_evaluated');
  });

  it('fails a lit-landing robot at a site dark at landing, and skips the check for one that needs no light', () => {
    const dark = facts({ series: series(100, (k) => k === 0) });
    expect(check(robotFit(NEEDS, dark), 'litLanding')?.status).toBe('fail');
    expect(robotFit(NEEDS, dark).overall).toBe('does_not_fit');
    expect(check(robotFit({ ...NEEDS, litLanding: 'not_required' }, dark), 'litLanding')?.status).toBe('not_evaluated');
  });

  it('calls a landing circle with any steep point a fail, and an unmeasured one unknown', () => {
    expect(check(robotFit(NEEDS, facts({ circle: { ...FLAT, steepPct: 4 } })), 'landingCircle')?.status).toBe('fail');
    const unmeasured = robotFit(NEEDS, facts({ circle: undefined }));
    expect(check(unmeasured, 'landingCircle')?.status).toBe('unknown');
    expect(unmeasured.overall).toBe('not_enough_data');
  });

  it('reads Earth in view part of the time as unknown, not a pass, when the robot talks straight to Earth', () => {
    expect(check(robotFit(NEEDS, facts({ earthVisiblePct: 60 })), 'earth')?.status).toBe('unknown');
    expect(check(robotFit(NEEDS, facts({ earthVisiblePct: 0 })), 'earth')?.status).toBe('fail');
    expect(check(robotFit({ ...NEEDS, comms: 'unknown' }, facts({ earthVisiblePct: 0 })), 'earth')?.status).toBe(
      'info',
    );
  });

  it('lets a fail outweigh unknowns', () => {
    const fit = robotFit(NEEDS, facts({ earthVisiblePct: 0, circle: undefined }));
    expect(fit.overall).toBe('does_not_fit');
  });

  it('shows the terrain fact that matters for how the robot moves, with no verdict', () => {
    expect(check(robotFit({ ...NEEDS, mobility: 'rover' }, facts()), 'ground')).toMatchObject({
      status: 'info',
      values: { walkablePct: 70 },
    });
    expect(check(robotFit({ ...NEEDS, mobility: 'hopper' }, facts()), 'ground')).toMatchObject({
      status: 'info',
      values: { shadowKm: 2 },
    });
    expect(check(robotFit(NEEDS, facts()), 'ground')?.status).toBe('not_evaluated');
  });
});
