import { MOON_RADIUS_KM, siteFrame } from './frames';
import { HORIZON_BINS, HORIZON_STEP_DEG, type HorizonMask } from './horizon';
import { DEG, type Vec3 } from './vec';

export const MOON_RADIUS_M = MOON_RADIUS_KM * 1000;

/** Square height grid in LOLA's south polar stereographic projection, centred on the pole, row 0 at +y. */
export interface Dem {
  n: number;
  pixM: number;
  heightsM: Float32Array;
}

export function demFromInt16(values: Int16Array, n: number, pixM: number, metresPerUnit: number): Dem {
  if (values.length !== n * n) throw new Error(`DEM needs ${n * n} values, got ${values.length}`);
  return { n, pixM, heightsM: Float32Array.from(values, (v) => v * metresPerUnit) };
}

/** Plane coordinates in metres of a unit vector in the Moon's body-fixed frame: x = ρ sin λ, y = ρ cos λ. */
export function polarXY(q: Vec3): { x: number; y: number } {
  const k = (2 * MOON_RADIUS_M) / (1 - q[2]);
  return { x: k * q[1], y: k * q[0] };
}

/** Inverse of polarXY: the unit vector in the Moon's body-fixed frame at plane coordinates (metres). */
export function polarToUnit(x: number, y: number): Vec3 {
  const a = x / (2 * MOON_RADIUS_M);
  const b = y / (2 * MOON_RADIUS_M);
  const r2 = a * a + b * b;
  const k = 2 / (r2 + 1);
  return [b * k, a * k, (r2 - 1) / (r2 + 1)];
}

export function unitToLatLon(q: Vec3): { latDeg: number; lonDeg: number } {
  return { latDeg: Math.asin(Math.max(-1, Math.min(1, q[2]))) / DEG, lonDeg: Math.atan2(q[1], q[0]) / DEG };
}

/** Bilinear height in metres, NaN outside the grid. */
export function demHeightM(dem: Dem, x: number, y: number): number {
  const half = (dem.n - 1) / 2;
  const last = dem.n - 1;
  const s = x / dem.pixM + half;
  const l = half - y / dem.pixM;
  if (!(s >= 0 && l >= 0 && s <= last && l <= last)) return Number.NaN;
  const s0 = Math.min(Math.floor(s), last - 1);
  const l0 = Math.min(Math.floor(l), last - 1);
  const fs = s - s0;
  const fl = l - l0;
  const h = dem.heightsM;
  const i = l0 * dem.n + s0;
  return (h[i] * (1 - fs) + h[i + 1] * fs) * (1 - fl) + (h[i + dem.n] * (1 - fs) + h[i + dem.n + 1] * fs) * fl;
}

export interface DemHorizon {
  mask: HorizonMask;
  groundHeightM: number;
}

export interface HorizonOptions {
  observerHeightM?: number;
  maxDistM?: number;
  /**
   * Skip terrain closer than this; defaults to two pixels. Bilinear terrain within a pixel or two of the site
   * is a flat facet whose uphill side reads as skyline (on LOLA 1.2 km this cost 20 to 40 points of sunlight).
   */
  minDistM?: number;
}

/** Skyline from the terrain, walking each azimuth along its great circle so lunar curvature is built in. */
export function horizonFromDem(
  dem: Dem,
  latDeg: number,
  lonDeg: number,
  { observerHeightM = 2, maxDistM = 300_000, minDistM = 2 * dem.pixM }: HorizonOptions = {},
): DemHorizon | undefined {
  const { u, e, n } = siteFrame(latDeg, lonDeg);
  const p = polarXY(u);
  const groundHeightM = demHeightM(dem, p.x, p.y);
  if (Number.isNaN(groundHeightM)) return undefined;
  const r0 = MOON_RADIUS_M + groundHeightM + observerHeightM;
  const mask = new Float32Array(HORIZON_BINS);
  for (let j = 0; j < HORIZON_BINS; j++) {
    const a = j * HORIZON_STEP_DEG * DEG;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const d: Vec3 = [ca * n[0] + sa * e[0], ca * n[1] + sa * e[1], ca * n[2] + sa * e[2]];
    let best = -Math.PI / 2;
    for (let s = minDistM; s <= maxDistM; s += Math.max(dem.pixM / 2, 0.002 * s)) {
      const th = s / MOON_RADIUS_M;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const q = polarXY([c * u[0] + sn * d[0], c * u[1] + sn * d[1], c * u[2] + sn * d[2]]);
      const h = demHeightM(dem, q.x, q.y);
      if (Number.isNaN(h)) break;
      const rq = MOON_RADIUS_M + h;
      const el = Math.atan2(rq * c - r0, rq * sn);
      if (el > best) best = el;
    }
    mask[j] = best / DEG;
  }
  return { mask, groundHeightM };
}
