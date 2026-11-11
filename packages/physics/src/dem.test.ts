import { describe, expect, it } from 'vitest';
import { type Dem, demHeightM, horizonFromDem, MOON_RADIUS_M, polarToUnit, polarXY, unitToLatLon } from './dem';
import { siteFrame } from './frames';
import { DEG } from './vec';

const flatDem = (n: number, pixM: number): Dem => ({ n, pixM, heightsM: new Float32Array(n * n) });

describe('polar stereographic grid', () => {
  it('matches ρ = 2R tan(45° + φ/2), x = ρ sin λ, y = ρ cos λ', () => {
    const rho = 2 * MOON_RADIUS_M * Math.tan((45 + -80 / 2) * DEG);
    const p = polarXY(siteFrame(-80, 30).u);
    expect(p.x).toBeCloseTo(rho * Math.sin(30 * DEG), 3);
    expect(p.y).toBeCloseTo(rho * Math.cos(30 * DEG), 3);
  });

  it('inverts back to the same latitude and longitude', () => {
    const p = polarXY(siteFrame(-86.0, -0.2).u);
    const back = unitToLatLon(polarToUnit(p.x, p.y));
    expect(back.latDeg).toBeCloseTo(-86.0, 9);
    expect(back.lonDeg).toBeCloseTo(-0.2, 9);
  });

  it('interpolates heights with row 0 at +y and is NaN off the grid', () => {
    const dem = flatDem(3, 100);
    dem.heightsM.set([0, 0, 0, 0, 10, 0, 40, 0, 0]);
    expect(demHeightM(dem, 0, 0)).toBe(10);
    expect(demHeightM(dem, -50, -50)).toBeCloseTo(12.5, 9);
    expect(demHeightM(dem, -100, -100)).toBe(40);
    expect(demHeightM(dem, 101, 0)).toBeNaN();
  });
});

describe('horizonFromDem', () => {
  it('gives the curvature dip of about 0.087° for an observer 2 m above a smooth Moon', () => {
    const hz = horizonFromDem(flatDem(201, 500), -90, 0, { maxDistM: 40_000 });
    const dip = -Math.sqrt((2 * 2) / MOON_RADIUS_M) / DEG;
    expect(Math.max(...hz!.mask)).toBeCloseTo(dip, 2);
    expect(Math.min(...hz!.mask)).toBeCloseTo(dip, 2);
  });

  it('sees a 1 km ridge 19 km away toward the 0° meridian, and nothing the other way', () => {
    const dem = flatDem(201, 500);
    for (let row = 58; row <= 62; row++) dem.heightsM.fill(1000, row * 201, (row + 1) * 201);
    const hz = horizonFromDem(dem, -90, 0, { maxDistM: 45_000 });
    const th = 19_000 / MOON_RADIUS_M;
    const r = MOON_RADIUS_M + 1000;
    const expected = Math.atan2(r * Math.cos(th) - (MOON_RADIUS_M + 2), r * Math.sin(th)) / DEG;
    expect(hz!.mask[0]).toBeCloseTo(expected, 2);
    expect(hz!.mask[360]).toBeLessThan(0);
    expect(hz!.mask[180]).toBeLessThan(0);
  });

  it('returns nothing for a site off the grid', () => {
    expect(horizonFromDem(flatDem(11, 100), -80, 0)).toBeUndefined();
  });
});
