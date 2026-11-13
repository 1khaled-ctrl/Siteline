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

/**
 * A rectangle of heights anywhere on the polar grid, as a windowed read of a GeoTIFF gives it: the plane coordinates
 * of its first cell's centre, its cell size, and its heights row by row from +y down. A `Dem` is the special case
 * centred on the pole.
 */
export interface HeightPatch {
  cornerX: number;
  cornerY: number;
  pixM: number;
  width: number;
  height: number;
  heightsM: Float32Array;
}

/** Bilinear height in metres from a patch, NaN outside it or where the grid has no data. */
export function patchHeightM(patch: HeightPatch, x: number, y: number): number {
  const s = (x - patch.cornerX) / patch.pixM;
  const l = (patch.cornerY - y) / patch.pixM;
  if (!(s >= 0 && l >= 0 && s <= patch.width - 1 && l <= patch.height - 1)) return Number.NaN;
  const s0 = Math.min(Math.floor(s), patch.width - 2);
  const l0 = Math.min(Math.floor(l), patch.height - 2);
  const fs = s - s0;
  const fl = l - l0;
  const h = patch.heightsM;
  const i = l0 * patch.width + s0;
  return (
    (h[i] * (1 - fs) + h[i + 1] * fs) * (1 - fl) + (h[i + patch.width] * (1 - fs) + h[i + patch.width + 1] * fs) * fl
  );
}

/**
 * Where the horizon walk reads its heights. Several patches can back one source: the walk asks each in turn and takes
 * the first that has a height there, so a fine patch around the site is read near it and a coarse one further out.
 * That is what the 30 m terrain needs: reading 300 km of it at 30 m would be a 20,000 x 20,000 window, while a ridge
 * that far away is a few pixels of skyline whatever it was sampled at.
 */
export interface HeightSource {
  heightAt(x: number, y: number): number;
}

/** A height source reading the patches in order, finest first. */
export function heightsFromPatches(patches: readonly HeightPatch[]): HeightSource {
  if (patches.length === 0) throw new Error('a height source needs at least one patch');
  return {
    heightAt(x: number, y: number): number {
      for (const patch of patches) {
        const h = patchHeightM(patch, x, y);
        if (!Number.isNaN(h)) return h;
      }
      return Number.NaN;
    },
  };
}

/** A height source reading one pole-centred grid. */
export function heightsFromDem(dem: Dem): HeightSource {
  return { heightAt: (x, y) => demHeightM(dem, x, y) };
}

export interface DemHorizon {
  mask: HorizonMask;
  groundHeightM: number;
}

/**
 * How close to the site the skyline walk starts. It exists to clear the observer's own footprint: the first step of a
 * ray leaving a 2 m observer at a grazing Sun would otherwise graze the ground cell it stands on and read as blocked.
 * That is a physical distance, so it does not scale with the grid: as `2 * pixM` it silently meant 2.4 km on a 1.2 km
 * grid, which threw away real ground, and 60 m on a 30 m one.
 *
 * Sweeping it from 5 m to 200 m on the 30 m terrain moves the sunlight at the three validation points by at most 2.4
 * points, so the result does not hang on the exact value; 20 m clears a 30 m cell's own footprint with room to spare.
 */
export const HORIZON_MIN_DIST_M = 20;

export interface HorizonOptions {
  observerHeightM?: number;
  maxDistM?: number;
  /** Skip terrain closer than this, in metres; `HORIZON_MIN_DIST_M` by default. */
  minDistM?: number;
}

/** Skyline from the terrain, walking each azimuth along its great circle so lunar curvature is built in. */
export function horizonFromDem(
  dem: Dem,
  latDeg: number,
  lonDeg: number,
  options: HorizonOptions = {},
): DemHorizon | undefined {
  // A coarse grid's own cell is wider than the physical cutoff, so its walk still starts outside its own footprint.
  return horizonFromHeights(heightsFromDem(dem), latDeg, lonDeg, {
    stepM: dem.pixM,
    minDistM: Math.max(HORIZON_MIN_DIST_M, 2 * dem.pixM),
    ...options,
  });
}

/**
 * Skyline from any height source. `stepM` is how finely each azimuth is walked near the site, normally the finest
 * cell size the source has there; the step grows with distance, as a distant ridge subtends less.
 */
export function horizonFromHeights(
  heights: HeightSource,
  latDeg: number,
  lonDeg: number,
  {
    observerHeightM = 2,
    maxDistM = 300_000,
    stepM = 30,
    minDistM = HORIZON_MIN_DIST_M,
  }: HorizonOptions & { stepM?: number } = {},
): DemHorizon | undefined {
  const { u, e, n } = siteFrame(latDeg, lonDeg);
  const p = polarXY(u);
  const groundHeightM = heights.heightAt(p.x, p.y);
  if (Number.isNaN(groundHeightM)) return undefined;
  const r0 = MOON_RADIUS_M + groundHeightM + observerHeightM;
  const mask = new Float32Array(HORIZON_BINS);
  for (let j = 0; j < HORIZON_BINS; j++) {
    const a = j * HORIZON_STEP_DEG * DEG;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const d: Vec3 = [ca * n[0] + sa * e[0], ca * n[1] + sa * e[1], ca * n[2] + sa * e[2]];
    let best = -Math.PI / 2;
    for (let s = minDistM; s <= maxDistM; s += Math.max(stepM / 2, 0.002 * s)) {
      const th = s / MOON_RADIUS_M;
      const c = Math.cos(th);
      const sn = Math.sin(th);
      const q = polarXY([c * u[0] + sn * d[0], c * u[1] + sn * d[1], c * u[2] + sn * d[2]]);
      const h = heights.heightAt(q.x, q.y);
      if (Number.isNaN(h)) break;
      const rq = MOON_RADIUS_M + h;
      const el = Math.atan2(rq * c - r0, rq * sn);
      if (el > best) best = el;
    }
    mask[j] = best / DEG;
  }
  return { mask, groundHeightM };
}
