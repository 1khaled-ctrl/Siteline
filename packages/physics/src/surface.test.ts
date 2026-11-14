import { describe, expect, it } from 'vitest';
import { type HeightSource, MOON_RADIUS_M, polarXY } from './dem';
import { siteFrame } from './frames';
import {
  bodyToLocal,
  clampMove,
  discVisibility,
  EYE_HEIGHT_M,
  eyeSky,
  eyeUpAt,
  geoToLocal,
  gridNormals,
  gridPositions,
  gridTriangles,
  gridUpAt,
  horizonAlongDeg,
  type LocalGrid,
  levelsUpAt,
  localDirection,
  localElevAz,
  localFrame,
  localToGeo,
  rayGrids,
  resampleGrid,
  resampleToLocal,
  surfaceUpAt,
  sweepDiscVisibility,
} from './surface';
import { DEG, type Vec3 } from './vec';

const R = MOON_RADIUS_M;
const flat: HeightSource = { heightAt: () => 0 };

/** A grid whose local up is given by a function of east and north, as `resampleToLocal` would lay it out. */
function gridOf(spacingM: number, halfM: number, upAt: (e: number, n: number) => number): LocalGrid {
  const size = Math.round((2 * halfM) / spacingM) + 1;
  const up = new Float32Array(size * size);
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) up[r * size + c] = upAt(-halfM + c * spacingM, halfM - r * spacingM);
  return { size, spacingM, halfM, up };
}

/** Flat ground on a curved Moon, as a site's own grid sees it: lower by e²/2R away from the origin. */
const curvedFlat = (spacingM: number, halfM: number) =>
  gridOf(spacingM, halfM, (e, n) => Math.sqrt(R * R - e * e - n * n) - R);

describe('local frame', () => {
  const f = localFrame(-89.5, 45, 1200);

  it('puts the site itself, at its ground height, at the origin', () => {
    const p = geoToLocal(f, -89.5, 45, 1200);
    for (const v of p) expect(Math.abs(v)).toBeLessThan(1e-6);
    expect(bodyToLocal(f, f.origin)).toEqual([0, 0, 0]);
  });

  it('runs north toward the pole, east to the right of north, and down with the curvature', () => {
    // 0.01° of latitude is 303 m on the 1737.4 km sphere.
    const north = geoToLocal(f, -89.49, 45, 1200);
    expect(north[1]).toBeCloseTo(R * 0.01 * DEG, -0); // about 303 m
    expect(Math.abs(north[0])).toBeLessThan(0.5);
    expect(north[2]).toBeLessThan(0);
    const east = geoToLocal(f, -89.5, 45.5, 1200);
    expect(east[0]).toBeGreaterThan(0);
  });

  it('round-trips local points through latitude and longitude', () => {
    for (const [e, n, u] of [
      [0, 0, 0],
      [1500, -800, 12.5],
      [-40_000, 25_000, -300],
      [250_000, 120_000, -20_000],
    ]) {
      const g = localToGeo(f, e, n, u);
      const back = geoToLocal(f, g.latDeg, g.lonDeg, g.heightM);
      expect(back[0]).toBeCloseTo(e, 5);
      expect(back[1]).toBeCloseTo(n, 5);
      expect(back[2]).toBeCloseTo(u, 5);
    }
  });

  it('wraps longitude across ±180°', () => {
    const w = localFrame(-85, 179.99, 0);
    const across = geoToLocal(w, -85, -179.99, 0);
    // 0.02° of longitude at 85°S, eastward across the antimeridian.
    expect(across[0]).toBeCloseTo(R * Math.cos(85 * DEG) * 0.02 * DEG, 1);
    expect(Math.abs(across[1])).toBeLessThan(0.5);
    expect(localToGeo(w, across[0], across[1], across[2]).lonDeg).toBeCloseTo(-179.99, 6);
  });

  it('works exactly at the pole, with north along the 0° meridian', () => {
    const p = localFrame(-90, 123, 0);
    const towardZero = geoToLocal(p, -89.9, 0, 0);
    expect(towardZero[1]).toBeGreaterThan(0);
    expect(Math.abs(towardZero[0])).toBeLessThan(1e-6);
    const towardNinety = geoToLocal(p, -89.9, 90, 0);
    expect(towardNinety[0]).toBeGreaterThan(0);
    // The same convention as the stay check's own site frame.
    expect(siteFrame(-90, 123).n).toEqual(p.n);
  });

  it('turns body-fixed directions into local unit vectors', () => {
    const p = localFrame(-90, 0, 0);
    const d = localDirection(p, [5, 0, 0]);
    expect(d[0]).toBeCloseTo(0, 12);
    expect(d[1]).toBeCloseTo(1, 12);
    expect(d[2]).toBeCloseTo(0, 12);
    expect(localDirection(p, [0, 0, -2])[2]).toBeCloseTo(1, 12);
  });
});

describe('terrain on the local grid', () => {
  it('is at real scale: flat ground drops only by the curvature, e²/2R', () => {
    const f = localFrame(-88, 30, 0);
    expect(surfaceUpAt(f, [flat], 0, 0)).toBeCloseTo(0, 9);
    // 2 km out the ground is 1.151 m below the site's horizontal plane; 300 km out, about 25.9 km.
    expect(surfaceUpAt(f, [flat], 2000, 0)).toBeCloseTo(-(2000 ** 2) / (2 * R), 3);
    expect(surfaceUpAt(f, [flat], 0, -300_000)).toBeCloseTo(Math.sqrt(R * R - 300_000 ** 2) - R, 0);
  });

  it('keeps the terrain height at the selected point and never stretches heights', () => {
    const f = localFrame(-89, 60, 250);
    const site = polarXY(siteFrame(-89, 60).u);
    // A 100 m step up starting 500 m east of the site (in the polar plane, roughly).
    const step: HeightSource = { heightAt: (x, y) => (Math.hypot(x - site.x, y - site.y) < 300 ? 250 : 350) };
    expect(surfaceUpAt(f, [step], 0, 0)).toBeCloseTo(0, 6);
    const out = surfaceUpAt(f, [step], 1000, 0);
    expect(out).toBeCloseTo(100 - 1000 ** 2 / (2 * (R + 250)), 2);
  });

  it('marks missing data, and fills it from the next source where that has a height', () => {
    const f = localFrame(-89, 0, 0);
    const holey: HeightSource = { heightAt: (x) => (x > polarXY(siteFrame(-89, 0).u).x + 500 ? Number.NaN : 0) };
    const coarse: HeightSource = { heightAt: () => 10 };
    const g = resampleToLocal(f, [holey], 100, 1000);
    expect(g.size).toBe(21);
    expect(g.up.some(Number.isNaN)).toBe(true);
    expect(g.from?.includes(255)).toBe(true);
    const filled = resampleToLocal(f, [holey, coarse], 100, 1000);
    expect(filled.up.some(Number.isNaN)).toBe(false);
    expect(filled.from?.includes(1)).toBe(true);
    expect(filled.from?.[(filled.size * (filled.size - 1)) / 2]).toBe(0); // the middle row's centre: the fine source
  });

  it('refuses a grid that is not a whole number of cells', () => {
    expect(() => resampleToLocal(localFrame(-89, 0, 0), [flat], 30, 1000)).toThrow();
  });
});

describe('ground under the camera', () => {
  it('reads the drawn triangles, split along each cell’s north-east to south-west diagonal', () => {
    // One cell: only its south-east corner is raised.
    const g: LocalGrid = { size: 2, spacingM: 10, halfM: 5, up: Float32Array.from([0, 0, 0, 1]) };
    expect(gridUpAt(g, 0, 0)).toBeCloseTo(0, 9); // on the diagonal
    expect(gridUpAt(g, 2.5, -2.5)).toBeCloseTo(0.5, 9); // three quarters toward the south-east corner
    expect(gridUpAt(g, 5, -5)).toBeCloseTo(1, 9);
    expect(gridUpAt(g, 6, 0)).toBeNaN();
  });

  it('is exact on a tilted plane anywhere', () => {
    const g = gridOf(10, 100, (e, n) => 0.1 * e + 0.2 * n + 5);
    for (const [e, n] of [
      [3.3, -7.7],
      [-55.1, 12.9],
      [99, -99],
    ])
      expect(gridUpAt(g, e, n)).toBeCloseTo(0.1 * e + 0.2 * n + 5, 4);
  });

  it('keeps the eye 1.7 m above the ground everywhere it can stand', () => {
    expect(EYE_HEIGHT_M).toBe(1.7);
    const g = gridOf(10, 200, (e, n) => 30 * Math.sin(e / 37) * Math.cos(n / 23));
    for (let i = 0; i < 200; i++) {
      const e = -199 + ((i * 37) % 398);
      const n = 199 - ((i * 53) % 398);
      expect(eyeUpAt(g, e, n) - gridUpAt(g, e, n)).toBeCloseTo(EYE_HEIGHT_M, 9);
    }
  });

  it('reads the finest grid that has the spot, then coarser ones', () => {
    const fine = gridOf(10, 100, () => 1);
    const coarse = gridOf(100, 1000, () => 2);
    expect(levelsUpAt([fine, coarse], 50, 50)).toBe(1);
    expect(levelsUpAt([fine, coarse], 500, 50)).toBe(2);
    expect(levelsUpAt([fine, coarse], 5000, 50)).toBeNaN();
  });
});

describe('walking', () => {
  const g = gridOf(10, 100, (e, n) => (e > 40 && e < 60 && n > 40 && n < 60 ? Number.NaN : 0));

  it('takes steps inside the terrain', () => {
    expect(clampMove(g, { east: 0, north: 0 }, { east: 3, north: -2 }, 5)).toEqual({
      east: 3,
      north: -2,
      blocked: null,
    });
  });

  it('stops at the edge of the data and slides along it', () => {
    const r = clampMove(g, { east: 90, north: 0 }, { east: 97, north: 3 }, 5);
    expect(r.blocked).toBe('edge');
    expect(r.east).toBe(90);
    expect(r.north).toBe(3);
    expect(clampMove(g, { east: 95, north: 95 }, { east: 99, north: 99 }, 5)).toEqual({
      east: 95,
      north: 95,
      blocked: 'edge',
    });
  });

  it('will not walk into a hole in the data', () => {
    const r = clampMove(g, { east: 30, north: 30 }, { east: 45, north: 45 }, 5);
    expect(r.blocked).toBe('nodata');
    expect(Number.isFinite(gridUpAt(g, r.east, r.north))).toBe(true);
  });
});

describe('directions and skylines', () => {
  it('gives elevation and azimuth clockwise from north, wrapped to 0–360°', () => {
    expect(localElevAz([0, 1, 0])).toEqual({ elevDeg: 0, azDeg: 0 });
    expect(localElevAz([1, 0, 0]).azDeg).toBeCloseTo(90, 9);
    expect(localElevAz([-1, 0, 0]).azDeg).toBeCloseTo(270, 9);
    expect(localElevAz([0, 0, 1]).elevDeg).toBeCloseTo(90, 9);
    expect(localElevAz([1, -1e-12, 0]).azDeg).toBeLessThan(360);
  });

  it('keeps the highest ground of each grid and the coarser ones', () => {
    const r = rayGrids([gridOf(10, 100, () => 5), gridOf(100, 1000, () => 3), gridOf(1000, 10_000, () => 4)]);
    expect(r.maxUpOnward).toEqual([5, 4, 4]);
  });

  it('dips just below level over flat ground, from the curvature', () => {
    const g = curvedFlat(10, 2000);
    const h = horizonAlongDeg([g], 0, 0, EYE_HEIGHT_M, 90, { minDistM: 20 });
    expect(h).toBeLessThan(0);
    expect(h).toBeGreaterThan(-0.1);
  });

  it('sees a ridge at the angle it stands, and nothing the other way', () => {
    const g = gridOf(10, 2000, (e) => (e > 1000 ? 100 : 0));
    expect(horizonAlongDeg([g], 0, 0, 1.7, 90, { minDistM: 20 })).toBeCloseTo(Math.atan(98.3 / 1000) / DEG, 0);
    expect(horizonAlongDeg([g], 0, 0, 1.7, 270, { minDistM: 20 })).toBeLessThan(0);
  });

  it('crosses a finer grid when walking in from the coarse ground around it', () => {
    const fine = gridOf(10, 2000, (e, n) => (Math.abs(e - 1500) < 20 && Math.abs(n) < 20 ? 200 : 0));
    const coarse = gridOf(100, 20_000, () => 0);
    const h = horizonAlongDeg([fine, coarse], -8000, 0, 1.7, 90, { minDistM: 20 });
    expect(h).toBeCloseTo(Math.atan(198.3 / 9500) / DEG, 1);
  });

  it('works out the cast shadow of a ridge on each node', () => {
    // A 300 m high ridge 500 m east of the origin, the Sun 5° up in the east.
    const g = gridOf(10, 1000, (e) => (e > 500 ? 300 : 0));
    const sunEast: Vec3 = [Math.cos(5 * DEG), 0, Math.sin(5 * DEG)];
    const lit = discVisibility([g], 0, sunEast, 0.27, 2);
    const at = (e: number, n: number) => lit[Math.round((1000 - n) / 10) * g.size + Math.round((e + 1000) / 10)];
    expect(at(0, 0)).toBe(0); // in the ridge's shadow
    expect(at(-990, 0)).toBe(0); // 3.4 km of shadow at 5°
    expect(at(800, 0)).toBe(1); // on the ridge
    const sunWest: Vec3 = [-Math.cos(5 * DEG), 0, Math.sin(5 * DEG)];
    expect(discVisibility([g], 0, sunWest, 0.27, 2).every((v) => v === 1)).toBe(true);
  });

  it('tells what an eye sees of a disc: half of a Sun on the skyline, none behind a ridge', () => {
    const g = curvedFlat(10, 2000);
    const level = eyeSky([g], 0, 0, EYE_HEIGHT_M, [0, 1, 0], 0.27, 20);
    expect(level?.fraction).toBeGreaterThan(0.5);
    expect(level?.fraction).toBeLessThan(0.75);
    const ridge = gridOf(10, 2000, (_, n) => (n > 300 ? 100 : 0));
    expect(eyeSky([ridge], 0, 0, EYE_HEIGHT_M, [0, Math.cos(5 * DEG), Math.sin(5 * DEG)], 0.27, 20)?.fraction).toBe(0);
    expect(eyeSky([ridge], 5000, 0, EYE_HEIGHT_M, [0, 1, 0], 0.27, 20)).toBeUndefined();
  });
});

describe('shadows by sweeping toward the Sun', () => {
  const R0 = MOON_RADIUS_M;
  /** Rolling hills and a few sharp ridges on a curved Moon, in two nested grids. */
  const terrain = (spacingM: number, halfM: number) =>
    gridOf(spacingM, halfM, (e, n) => {
      const curve = Math.sqrt(R0 * R0 - e * e - n * n) - R0;
      return curve + 25 * Math.sin(e / 140) * Math.cos(n / 95) + (Math.abs(e - 300 + n * 0.3) < 15 ? 60 : 0);
    });
  const grids = [terrain(10, 1000), terrain(40, 6000)];
  const sun = (elevDeg: number, azDeg: number): Vec3 => [
    Math.sin(azDeg * DEG) * Math.cos(elevDeg * DEG),
    Math.cos(azDeg * DEG) * Math.cos(elevDeg * DEG),
    Math.sin(elevDeg * DEG),
  ];

  it('agrees with walking from every point toward the Sun', () => {
    for (const [elev, az] of [
      [1.5, 40],
      [4, 200],
      [0.8, 300],
    ]) {
      const swept = sweepDiscVisibility(grids, grids[0], sun(elev, az), 0.27, 1);
      const walked = discVisibility(grids, 0, sun(elev, az), 0.27, 1);
      let diff = 0;
      let lit = 0;
      for (let i = 0; i < swept.length; i++) {
        diff += Math.abs(swept[i] - walked[i]);
        lit += walked[i];
      }
      // The two sample the ground a little differently, so they differ only along shadow edges.
      expect(diff / swept.length).toBeLessThan(0.03);
      expect(lit / swept.length).toBeGreaterThan(0.05);
      expect(lit / swept.length).toBeLessThan(0.97);
    }
  });

  it('casts a ridge’s shadow the length its height and the Sun’s give it', () => {
    const g = gridOf(10, 1000, (e) => (e > 500 ? 300 : 0));
    const lit = sweepDiscVisibility([g], g, sun(5, 90), 0.27);
    const at = (e: number, n: number) => lit[Math.round((1000 - n) / 10) * g.size + Math.round((e + 1000) / 10)];
    expect(at(0, 0)).toBe(0);
    expect(at(-990, 300)).toBe(0); // 3.4 km of shadow at 5°
    expect(at(800, -200)).toBe(1); // on the ridge
    expect(sweepDiscVisibility([g], g, sun(5, 270), 0.27).every((v) => v === 1)).toBe(true);
  });

  it('works out a finer grid of points than the terrain’s own, for sharper shadow edges', () => {
    const g = gridOf(10, 1000, (e) => (e > 500 ? 300 : 0));
    const fine = sweepDiscVisibility([g], { size: 801, spacingM: 2.5, halfM: 1000 }, sun(5, 90), 0.27);
    expect(fine.length).toBe(801 * 801);
    // The shadow's edge, 300 m / tan 5° = 3.43 km west of the ridge, lies outside this square, so the band is all dark.
    const row = 400 * 801;
    expect(fine[row + 0]).toBe(0);
    expect(fine[row + 799]).toBe(1);
  });

  it('sees the whole disc with nothing in the way, and none of a Sun below the horizon', () => {
    // Level ground with more level ground around it, as the far rings always give.
    const level = [gridOf(20, 400, () => 0), gridOf(200, 4000, () => 0)];
    expect(sweepDiscVisibility(level, level[0], sun(10, 123), 0.27).every((v) => v === 1)).toBe(true);
    expect(sweepDiscVisibility(level, level[0], sun(-2, 123), 0.27).every((v) => v === 0)).toBe(true);
  });
});

describe('reading values from one grid onto another', () => {
  it('keeps the nodes they share and blends between them', () => {
    const from = { size: 3, spacingM: 10, halfM: 10 };
    const to = { size: 5, spacingM: 5, halfM: 10 };
    // A ramp rising eastward: 0, 1, 2 along every row.
    const values = Float32Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    const out = resampleGrid(values, from, to);
    expect(Array.from(out.slice(0, 5))).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(out[12]).toBe(1); // the centre
  });
});

describe('meshes from the grid', () => {
  it('points normals away from the rise: up a slope to the east faces west, up to the north faces south', () => {
    const east = gridNormals(gridOf(10, 50, (e) => 0.1 * e));
    const len = Math.hypot(0.1, 1);
    expect(east[0]).toBeCloseTo(-0.1 / len, 6);
    expect(east[1]).toBeCloseTo(1 / len, 6);
    expect(east[2]).toBeCloseTo(0, 6);
    const north = gridNormals(gridOf(10, 50, (_, n) => 0.2 * n));
    // three.js's z is south: a face toward the south has +z.
    expect(north[2]).toBeCloseTo(0.2 / Math.hypot(0.2, 1), 6);
  });

  it('draws two triangles a cell, facing up, leaving out holes and the part a finer grid covers', () => {
    const g = gridOf(10, 50, () => 0);
    expect(gridTriangles(g).length).toBe(10 * 10 * 6);
    const pos = gridPositions(g);
    const t = gridTriangles(g);
    const v = (i: number) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    const [a, b, c] = [v(t[0]), v(t[1]), v(t[2])];
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    expect(ny).toBeGreaterThan(0); // counter-clockwise from above: three.js's front face
    // A finer grid 20 m across in the middle: the 2 × 2 cells wholly inside its edge less a cell are cut.
    expect(gridTriangles(g, 20).length).toBe((100 - 4) * 6);
    const holey = gridOf(10, 50, (e, n) => (e === 0 && n === 0 ? Number.NaN : 0));
    expect(gridTriangles(holey).length).toBe((100 - 4) * 6);
  });

  it('lays nodes out west to east and north to south, sinking a coarse grid under a finer one', () => {
    const g = gridOf(10, 20, () => 7);
    const pos = gridPositions(g, 3, 10);
    expect([pos[0], pos[1], pos[2]]).toEqual([-20, 7, -20]); // north-west corner: x = east, z = −north
    const centre = ((g.size * g.size - 1) / 2) * 3;
    expect([pos[centre], pos[centre + 1], pos[centre + 2]]).toEqual([0, 4, 0]);
  });
});
