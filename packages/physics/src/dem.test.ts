import { describe, expect, it } from 'vitest';
import {
  type Dem,
  demFromInt16,
  demHeightM,
  type HeightPatch,
  HORIZON_MIN_DIST_M,
  heightsFromDem,
  heightsFromPatches,
  horizonFromDem,
  horizonFromHeights,
  MOON_RADIUS_M,
  patchHeightM,
  polarToUnit,
  polarXY,
  unitToLatLon,
} from './dem';
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

describe('height patches and sources', () => {
  /** Flat ground of a given cell size, wide enough to hold a site near the pole and a 2 km walk around it. */
  const flatPatch = (pixM: number): HeightPatch => {
    const n = Math.ceil(20000 / pixM) + 3;
    const half = ((n - 1) / 2) * pixM;
    return { cornerX: -half, cornerY: half, pixM, width: n, height: n, heightsM: new Float32Array(n * n) };
  };

  // A 3 x 3 patch of 10 m cells whose first cell's centre is at (100, 200), heights rising 1 m per cell east.
  const patch: HeightPatch = {
    cornerX: 100,
    cornerY: 200,
    pixM: 10,
    width: 3,
    height: 3,
    heightsM: Float32Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2]),
  };

  it('reads a height at a cell centre', () => {
    expect(patchHeightM(patch, 100, 200)).toBe(0);
    expect(patchHeightM(patch, 110, 200)).toBe(1);
    expect(patchHeightM(patch, 120, 190)).toBe(2);
  });

  it('interpolates between cells', () => {
    expect(patchHeightM(patch, 105, 200)).toBeCloseTo(0.5, 12);
    expect(patchHeightM(patch, 115, 195)).toBeCloseTo(1.5, 12);
  });

  it('is NaN outside the patch', () => {
    expect(patchHeightM(patch, 99, 200)).toBeNaN();
    expect(patchHeightM(patch, 100, 201)).toBeNaN();
    expect(patchHeightM(patch, 121, 200)).toBeNaN();
    expect(patchHeightM(patch, 100, 179)).toBeNaN();
  });

  it('reads the first patch that covers the point, so a fine patch wins over a coarse one', () => {
    const coarse: HeightPatch = {
      cornerX: 0,
      cornerY: 400,
      pixM: 200,
      width: 3,
      height: 3,
      heightsM: Float32Array.from([99, 99, 99, 99, 99, 99, 99, 99, 99]),
    };
    const source = heightsFromPatches([patch, coarse]);
    // Inside the fine patch: its own value, not the coarse 99.
    expect(source.heightAt(110, 200)).toBe(1);
    // Outside it but inside the coarse one.
    expect(source.heightAt(400, 200)).toBe(99);
    // Outside both.
    expect(source.heightAt(-50, 200)).toBeNaN();
  });

  it('starts the walk at a fixed distance, whatever the grid', () => {
    // A metre value, not a multiple of a cell: the same ground must be skipped on a fine grid and a coarse one.
    expect(HORIZON_MIN_DIST_M).toBeGreaterThan(0);
    const fine = horizonFromHeights(heightsFromPatches([flatPatch(5)]), -89.9, 0, { stepM: 5, maxDistM: 2000 });
    const coarse = horizonFromHeights(heightsFromPatches([flatPatch(50)]), -89.9, 0, { stepM: 50, maxDistM: 2000 });
    // Flat ground either way: the skyline is the curve of the Moon, not an artefact of the cell size.
    expect(fine?.mask[0]).toBeCloseTo(coarse?.mask[0] ?? Number.NaN, 2);
  });

  it('needs at least one patch', () => {
    expect(() => heightsFromPatches([])).toThrow(/at least one patch/);
  });

  it('reads a pole-centred grid the same way demHeightM does', () => {
    const dem = demFromInt16(Int16Array.from([0, 100, 200, 300, 400, 500, 600, 700, 800]), 3, 1000, 0.5);
    const source = heightsFromDem(dem);
    for (const [x, y] of [
      [0, 0],
      [500, -250],
      [-1000, 1000],
      [99999, 0],
    ]) {
      const viaSource = source.heightAt(x, y);
      const direct = demHeightM(dem, x, y);
      if (Number.isNaN(direct)) expect(viaSource).toBeNaN();
      else expect(viaSource).toBe(direct);
    }
  });

  it('gives a horizon from patches matching the one from the same grid', () => {
    // One pole-centred grid, read both ways: as a Dem, and as a patch covering the same cells.
    const n = 41;
    const pixM = 500;
    const values = new Int16Array(n * n);
    for (let l = 0; l < n; l++)
      for (let s = 0; s < n; s++) values[l * n + s] = Math.round(200 * Math.sin(s / 3) * Math.cos(l / 4));
    const dem = demFromInt16(values, n, pixM, 1);
    const half = ((n - 1) / 2) * pixM;
    const patchOfDem: HeightPatch = {
      cornerX: -half,
      cornerY: half,
      pixM,
      width: n,
      height: n,
      heightsM: dem.heightsM,
    };
    const lat = -89.9;
    const lon = 20;
    // The same cutoff on both sides: a grid read either way must give the same skyline.
    const minDistM = 2 * pixM;
    const fromDem = horizonFromDem(dem, lat, lon, { maxDistM: 8000, minDistM });
    const fromPatch = horizonFromHeights(heightsFromPatches([patchOfDem]), lat, lon, {
      maxDistM: 8000,
      stepM: pixM,
      minDistM,
    });
    expect(fromDem).toBeDefined();
    expect(fromPatch).toBeDefined();
    expect(fromPatch?.groundHeightM).toBeCloseTo(fromDem?.groundHeightM ?? Number.NaN, 9);
    for (let j = 0; j < (fromDem?.mask.length ?? 0); j++)
      expect(fromPatch?.mask[j]).toBeCloseTo(fromDem?.mask[j] ?? Number.NaN, 9);
  });
});
