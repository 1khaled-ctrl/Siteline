import { DEG } from './vec';

/** Scale factor of the south polar stereographic grid, true scale at the pole. */
export const polarScaleFactor = (latDeg: number): number => 2 / (1 + Math.sin(Math.abs(latDeg) * DEG));

/** Horn's method on a 3×3 window given row by row (z1..z9). */
export function hornSlopeDeg(z: ArrayLike<number>, gridSpacingM: number, latDeg: number): number {
  const dg = gridSpacingM / polarScaleFactor(latDeg);
  const zx = (z[2] + 2 * z[5] + z[8] - (z[0] + 2 * z[3] + z[6])) / (8 * dg);
  const zy = (z[6] + 2 * z[7] + z[8] - (z[0] + 2 * z[1] + z[2])) / (8 * dg);
  return Math.atan(Math.hypot(zx, zy)) / DEG;
}

/** Slope of the least-squares plane z = ax + by + c through the points. */
export function planeFitSlopeDeg(xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>): number {
  const n = zs.length;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
    mz += zs[i];
  }
  mx /= n;
  my /= n;
  mz /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    const z = zs[i] - mz;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sxz += x * z;
    syz += y * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (det === 0) throw new Error('plane fit needs points that are not all on one line');
  const a = (sxz * syy - syz * sxy) / det;
  const b = (syz * sxx - sxz * sxy) / det;
  return Math.atan(Math.hypot(a, b)) / DEG;
}

/** The landing slope is over 100 m: a plane fitted to the ground within this distance of the site. */
export const LANDING_RADIUS_M = 50;
/** The walking area is 2 km across, centred on the site. */
export const WALK_RADIUS_M = 1000;
/** Ground steeper than this cannot be walked. */
export const WALK_LIMIT_DEG = 20;

/**
 * A square window of heights from a grid in the south polar stereographic plane, read around a site: row by row, row 0
 * the one furthest towards +y. NaN where the grid has no data.
 */
export interface HeightWindow {
  heightsM: ArrayLike<number>;
  /** Cells per row (and rows: the window is square). */
  n: number;
  /** The grid's spacing in the plane, in metres. */
  pixM: number;
  /** Where the site falls in the window, in cells from the centre of cell (0, 0): across, then down. */
  col: number;
  row: number;
}

export interface SiteSlopes {
  /** Slope in degrees of the plane fitted to the heights within `LANDING_RADIUS_M` of the site; NaN if too few. */
  slope100mDeg: number;
  /**
   * The share (%) of the cells within `WALK_RADIUS_M` of the site whose own slope (Horn's method on the cell and its
   * eight neighbours) is under `WALK_LIMIT_DEG`; NaN if under half of that area has data.
   */
  slope2kmPctUnder20: number;
}

/**
 * The landing slope and the walking area's share of gentle ground at a site, from the heights around it. Distances in
 * the plane are stretched by the projection's scale factor k = 2 / (1 + sin|φ|), so the radii and the cell spacing are
 * taken back to the ground by dividing by k, as in Horn's method.
 */
export function siteSlopes(w: HeightWindow, latDeg: number): SiteSlopes {
  const k = polarScaleFactor(latDeg);
  const groundM = w.pixM / k;
  const z = w.heightsM;
  const at = (r: number, c: number) => z[r * w.n + c];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const cell = new Array<number>(9);
  let walkCells = 0;
  let walkKnown = 0;
  let gentle = 0;
  for (let r = 0; r < w.n; r++) {
    for (let c = 0; c < w.n; c++) {
      const xM = (c - w.col) * groundM;
      const yM = (w.row - r) * groundM;
      const d = Math.hypot(xM, yM);
      if (d > WALK_RADIUS_M) continue;
      walkCells++;
      const h = at(r, c);
      if (d <= LANDING_RADIUS_M && Number.isFinite(h)) {
        xs.push(xM);
        ys.push(yM);
        zs.push(h);
      }
      if (r === 0 || c === 0 || r === w.n - 1 || c === w.n - 1) continue;
      let known = true;
      for (let i = 0; i < 9 && known; i++) {
        cell[i] = at(r - 1 + Math.floor(i / 3), c - 1 + (i % 3));
        known = Number.isFinite(cell[i]);
      }
      if (!known) continue;
      walkKnown++;
      if (hornSlopeDeg(cell, w.pixM, latDeg) < WALK_LIMIT_DEG) gentle++;
    }
  }
  return {
    slope100mDeg: zs.length >= 3 ? fittedSlopeDeg(xs, ys, zs) : Number.NaN,
    slope2kmPctUnder20: walkCells > 0 && walkKnown >= walkCells / 2 ? (100 * gentle) / walkKnown : Number.NaN,
  };
}

/** `planeFitSlopeDeg`, or NaN where the points lie on one line. */
function fittedSlopeDeg(xs: number[], ys: number[], zs: number[]): number {
  try {
    return planeFitSlopeDeg(xs, ys, zs);
  } catch {
    return Number.NaN;
  }
}
