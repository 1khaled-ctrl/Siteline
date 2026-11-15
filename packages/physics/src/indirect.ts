import type { HorizonSweep, PointGrid } from './surface';

/**
 * Light in the shadows: what reaches ground the Sun does not, as a share of direct sunlight on a surface square to the
 * Sun (so 1 is full sunlight, 0.03 is sunlight 1.7° above level ground). Two sources, both much dimmer than the Sun:
 * sunlight scattered off sunlit terrain nearby, and sunlight scattered off the Earth (earthshine).
 */

/** The Moon's Bond albedo (NASA Moon fact sheet): the share of sunlight its surface scatters back. */
export const MOON_BOND_ALBEDO = 0.11;
/** The Earth's geometric albedo (NASA Earth fact sheet): its brightness at full phase against a flat white disc. */
// biome-ignore lint/suspicious/noApproximativeNumericConstant: a measured albedo, not log10(e).
export const EARTH_GEOMETRIC_ALBEDO = 0.434;

/** Fractions along the way to the skyline where the terrain that scatters light toward a point is sampled. */
const ALONG = [0.55, 0.7, 0.85, 1] as const;

/** The skyline in one azimuth for every point of a grid, from `sweepHorizon`. */
export interface Horizon extends HorizonSweep {
  azDeg: number;
}

/**
 * Sunlight scattered once off the terrain around each point of `out`, onto the ground there. Each skyline is a sector
 * of the sky filled by terrain up to its elevation H; that terrain scatters as a Lambert surface of the Moon's albedo,
 * so a sector of width Δφ adds (albedo · D / π) · Δφ · sin²H′ / 2, D being the direct sunlight on that terrain
 * (`directAt`, the same units as the answer) and H′ the skyline's height above the ground's own plane in that azimuth
 * (`normals`, three.js's x east, y up, z south, one per point; level ground without them). D is the average over the
 * slope between the point and its skyline. Terrain below the ground's plane adds nothing.
 */
export function bouncedIrradiance(
  out: PointGrid,
  horizons: readonly Horizon[],
  directAt: (east: number, north: number) => number,
  albedo = MOON_BOND_ALBEDO,
  normals?: Float32Array,
): Float32Array {
  const result = new Float32Array(out.size * out.size);
  if (horizons.length === 0) return result;
  const dirs = horizons.map((h) => [Math.sin((h.azDeg * Math.PI) / 180), Math.cos((h.azDeg * Math.PI) / 180)]);
  for (let r = 0; r < out.size; r++) {
    const north = out.halfM - r * out.spacingM;
    for (let c = 0; c < out.size; c++) {
      const east = -out.halfM + c * out.spacingM;
      const i = r * out.size + c;
      let sum = 0;
      horizons.forEach((h, k) => {
        const dist = h.distM[i];
        if (!(dist > 0)) return;
        // How high the ground's own plane rises toward this azimuth: a slope sees terrain below the level.
        let plane = 0;
        if (normals && normals[3 * i + 1] > 1e-6) {
          const along = normals[3 * i] * dirs[k][0] - normals[3 * i + 2] * dirs[k][1];
          plane = Math.atan(-along / normals[3 * i + 1]);
        }
        const elev = Math.min(Math.PI / 2, h.elevRad[i] - plane);
        if (!(elev > 0)) return;
        let d = 0;
        let n = 0;
        for (const f of ALONG) {
          const v = directAt(east + dirs[k][0] * dist * f, north + dirs[k][1] * dist * f);
          if (Number.isFinite(v)) {
            d += v;
            n++;
          }
        }
        if (n > 0) sum += (d / n) * Math.sin(elev) ** 2;
      });
      // (albedo / π) · (2π / sectors) / 2 per sector.
      result[i] = (albedo * sum) / horizons.length;
    }
  }
  return result;
}

/** A Lambert sphere's brightness at phase angle `alphaRad` against its brightness when full: 1 full, 0 new. */
export function lambertPhase(alphaRad: number): number {
  const a = Math.min(Math.PI, Math.max(0, alphaRad));
  return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
}

/**
 * Earthshine on a surface square to the Earth, as a share of direct sunlight: p · (R / d)² · Φ(α), the Earth taken as a
 * Lambert sphere of geometric albedo p, radius R and distance d, at phase angle α (Sun–Earth–Moon, 0 at full Earth).
 * About 1 part in 10,000 at full Earth.
 */
export function earthshineIrradiance(phaseRad: number, distKm: number, radiusKm = 6371): number {
  return EARTH_GEOMETRIC_ALBEDO * (radiusKm / distKm) ** 2 * lambertPhase(phaseRad);
}
