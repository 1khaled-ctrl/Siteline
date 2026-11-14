import { DEFAULT_STAY } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import { bestSpots, scoreOf } from './best';
import { type Dem, MOON_RADIUS_M } from './dem';
import type { Ephemeris } from './ephemeris';
import { siteFrame } from './frames';
import { add, DEG, scale, type Vec3 } from './vec';

const T0 = Date.UTC(2028, 2, 3);
const pole = siteFrame(-90, 0);
const direction = (elevDeg: number, azDeg: number): Vec3 => {
  const el = elevDeg * DEG;
  const az = azDeg * DEG;
  return add(
    scale(pole.u, Math.sin(el)),
    add(scale(pole.n, Math.cos(el) * Math.cos(az)), scale(pole.e, Math.cos(el) * Math.sin(az))),
  );
};
// Sun fixed 1.5° up toward the 0° meridian, Earth 5° up the other way.
const ephemeris: Ephemeris = {
  startUtcMs: T0 - 86_400_000,
  endUtcMs: T0 + 40 * 86_400_000,
  positionKm: (body) =>
    body === 'sun'
      ? add(pole.pKm, scale(direction(1.5, 0), 1.496e8))
      : add(pole.pKm, scale(direction(5, 180), 384_400)),
};

describe('bestSpots', () => {
  it('ranks the spot on top of a hill above spots in its shadow', () => {
    const n = 101;
    const dem: Dem = { n, pixM: 500, heightsM: new Float32Array(n * n) };
    // A 1.5 km hill at the centre: grid rows 48..52, cols 48..52.
    for (let r = 48; r <= 52; r++) for (let c = 48; c <= 52; c++) dem.heightsM[r * n + c] = 1500;
    const query = { ...DEFAULT_STAY, observerHeightM: 2, landingUtc: new Date(T0).toISOString() };
    const spots = bestSpots(
      { centreLatDeg: -90, centreLonDeg: 0, sizeKm: 12, grid: 7, top: 49 },
      query,
      dem,
      ephemeris,
      { sources: ['test'], stepMinutes: 120 },
    );
    expect(spots).toHaveLength(49);
    for (let i = 1; i < spots.length; i++) expect(spots[i - 1].score).toBeGreaterThanOrEqual(spots[i].score);
    const distKm = (s: { latDeg: number }) => ((90 + s.latDeg) * DEG * MOON_RADIUS_M) / 1000;
    const hillTop = spots.find((s) => distKm(s) < 0.1);
    // The hill top sees both the Sun and Earth, so it shares the top score.
    expect(hillTop?.result.sunFractionMin).toBeGreaterThan(0.99);
    expect(hillTop?.result.earthVisiblePct).toBe(100);
    expect(hillTop?.score).toBe(spots[0].score);
    // 2 km behind the hill (toward the 180° meridian) the hill hides the low Sun.
    const behind = spots.find((s) => Math.abs(distKm(s) - 2) < 0.1 && Math.abs(Math.abs(s.lonDeg) - 180) < 1);
    expect(behind?.result.sunFractionMin).toBe(0);
    expect(behind?.score).toBeLessThan(spots[0].score);
  });

  it('sees a far ridge with its full reach, and misses it with a short one', () => {
    // A 6 km wall 40 km out toward the Sun hides it from the pole; a 20 km reach never gets that far.
    const n = 201;
    const dem: Dem = { n, pixM: 500, heightsM: new Float32Array(n * n) };
    // The Sun is toward the 0° meridian, which is +y: rows above the centre (row 100), 80 rows = 40 km up.
    for (let r = 18; r <= 22; r++) for (let c = 0; c < n; c++) dem.heightsM[r * n + c] = 6000;
    const query = { ...DEFAULT_STAY, observerHeightM: 2, landingUtc: new Date(T0).toISOString() };
    const at = (reachM?: number) =>
      bestSpots({ centreLatDeg: -90, centreLonDeg: 0, sizeKm: 1, grid: 2, top: 1, reachM }, query, dem, ephemeris, {
        sources: ['test'],
        stepMinutes: 120,
      })[0];
    expect(at()?.result.sunFractionMin).toBe(0);
    expect(at(20_000)?.result.sunFractionMin).toBeGreaterThan(0.99);
  });

  it('scores a full pass above a fail with the same light', () => {
    const base = {
      uncertain: false,
      reasons: [],
      sunFractionMin: 1,
      earthVisiblePct: 100,
      slope100mDeg: 1,
      slope2kmPctUnder20: 100,
      series: { tUtcMs: new Float64Array(), sun: new Float32Array(), earth: new Float32Array() },
      sources: [],
    };
    expect(scoreOf({ ...base, pass: true })).toBeGreaterThan(scoreOf({ ...base, pass: false }));
  });
});
