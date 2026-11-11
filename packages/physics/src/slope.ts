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
