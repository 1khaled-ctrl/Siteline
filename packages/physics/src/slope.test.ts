import { describe, expect, it } from 'vitest';
import {
  type HeightWindow,
  LANDING_RADIUS_M,
  polarScaleFactor,
  siteSlopes,
  WALK_LIMIT_DEG,
  WALK_RADIUS_M,
} from './slope';
import { DEG } from './vec';

/**
 * A window like the one the app reads from LOLA's 10 m grid: just wide enough for the walking area and one cell more,
 * the site in its middle cell, heights from `heightAt(x, y)` with x and y in metres across the plane.
 */
function windowOf(heightAt: (x: number, y: number) => number, latDeg = -90, pixM = 10): HeightWindow {
  const half = Math.ceil((WALK_RADIUS_M * polarScaleFactor(latDeg)) / pixM) + 1;
  const n = 2 * half + 1;
  const heightsM = new Float64Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) heightsM[r * n + c] = heightAt((c - half) * pixM, (half - r) * pixM);
  return { heightsM, n, pixM, col: half, row: half };
}

describe('siteSlopes', () => {
  it('reads a flat plain as level ground, all of it walkable', () => {
    const s = siteSlopes(
      windowOf(() => 120),
      -90,
    );
    expect(s.slope100mDeg).toBe(0);
    expect(s.slope2kmPctUnder20).toBe(100);
  });

  it('measures a tilted plane at its own angle, whichever way it tilts', () => {
    for (const [deg, dir] of [
      [5, 0],
      [9.5, 1.1],
      [30, 2.5],
    ]) {
      const g = Math.tan(deg * DEG);
      const s = siteSlopes(
        windowOf((x, y) => g * (x * Math.cos(dir) + y * Math.sin(dir))),
        -90,
      );
      expect(s.slope100mDeg).toBeCloseTo(deg, 9);
      expect(s.slope2kmPctUnder20).toBe(deg < WALK_LIMIT_DEG ? 100 : 0);
    }
  });

  it('takes plane distances back to the ground with the scale factor away from the pole', () => {
    // At 80°S the plane is stretched by k ≈ 1.0077: a 10° slope on the ground rises tan(10°) / k per metre of plane.
    const latDeg = -80;
    const g = Math.tan(10 * DEG) / polarScaleFactor(latDeg);
    const s = siteSlopes(
      windowOf((x) => g * x, latDeg),
      latDeg,
    );
    expect(s.slope100mDeg).toBeCloseTo(10, 9);
  });

  it('fits the landing plane only to the ground within 50 m of the site', () => {
    // Level within 60 m of the site and a 40° slope beyond: the landing slope sees only the level part.
    const steep = Math.tan(40 * DEG);
    const s = siteSlopes(
      windowOf((x, y) => Math.max(0, Math.hypot(x, y) - 60) * steep),
      -90,
    );
    expect(LANDING_RADIUS_M).toBeLessThan(60);
    expect(s.slope100mDeg).toBe(0);
    // Ground steeper than 20° covers all but the inner 60 m of the 1 km circle (Horn's 3 × 3 cells blur its edge).
    const level = (60 / WALK_RADIUS_M) ** 2 * 100;
    expect(s.slope2kmPctUnder20).toBeGreaterThan(level - 0.3);
    expect(s.slope2kmPctUnder20).toBeLessThan(level + 0.6);
  });

  it('gives the walkable share of mixed ground: half of the circle steep, half gentle', () => {
    const s = siteSlopes(
      windowOf((x) => (x > 0 ? x * Math.tan(35 * DEG) : x * Math.tan(5 * DEG))),
      -90,
    );
    expect(s.slope2kmPctUnder20).toBeGreaterThan(49);
    expect(s.slope2kmPctUnder20).toBeLessThan(51);
  });

  it('works for a site between cells, as a click usually is', () => {
    const g = Math.tan(7 * DEG);
    const w = windowOf((_x, y) => g * y);
    const s = siteSlopes({ ...w, col: w.col + 0.37, row: w.row - 0.81 }, -90);
    expect(s.slope100mDeg).toBeCloseTo(7, 9);
  });

  it('says it cannot tell (NaN) where the grid has no data', () => {
    expect(
      siteSlopes(
        windowOf(() => Number.NaN),
        -90,
      ),
    ).toEqual({
      slope100mDeg: Number.NaN,
      slope2kmPctUnder20: Number.NaN,
    });
    // Data on only a third of the walking area is too little to give its share.
    const s = siteSlopes(
      windowOf((x) => (x < -350 ? 0 : Number.NaN)),
      -90,
    );
    expect(s.slope2kmPctUnder20).toBeNaN();
  });

  it('keeps the walkable share where the data cover most of the walking area', () => {
    const s = siteSlopes(
      windowOf((x) => (x > 800 ? Number.NaN : 0)),
      -90,
    );
    expect(s.slope100mDeg).toBe(0);
    expect(s.slope2kmPctUnder20).toBe(100);
  });
});
