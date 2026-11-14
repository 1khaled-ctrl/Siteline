/**
 * The close-up terrain around a landing site: a square of heights a degree or two across, stored as a PNG with each
 * height in red (high byte) and green (low byte), 32768 = 0 m, the way the globe height maps are.
 */

import type { Mission } from './landerData';
import { decodeHeights } from './marsData';

const DEG = Math.PI / 180;

/**
 * One entry of `sites.json`: the height range, the centre, and the half-width in degrees of latitude and of
 * longitude. Near a pole a degree of longitude is a few hundred metres, so a patch that is square on the ground is
 * many times wider in longitude than in latitude; the demo's patches are square in degrees, with both the same.
 */
export interface SitePatchMeta {
  minM: number;
  maxM: number;
  latDeg: number;
  lonDeg: number;
  halfDeg: number;
  lonHalfDeg: number;
  /** The source's resolution in metres a pixel, where known: the camera stops zooming in where it runs out. */
  pixM?: number;
  /** The dataset the patch was cut from (its id in CREDITS.md); absent for the demo's own patches. */
  source?: string;
}

export interface SitesJson {
  [key: string]: {
    min: number;
    max: number;
    lat: number;
    lon: number;
    half: number;
    lonHalf?: number;
    pixM?: number;
    src?: string;
  };
}

export function parseSites(json: SitesJson): Record<string, SitePatchMeta> {
  return Object.fromEntries(
    Object.entries(json).map(([key, s]) => [
      key,
      {
        minM: s.min,
        maxM: s.max,
        latDeg: s.lat,
        lonDeg: s.lon,
        halfDeg: s.half,
        lonHalfDeg: s.lonHalf ?? s.half,
        pixM: s.pixM,
        source: s.src,
      },
    ]),
  );
}

/** Key of a mission's patch in `sites.json` and its file name: `moon_apollo11`, `mars_viking1`. */
export const patchKey = (m: Mission): string | undefined => {
  // A named patch first (the demo's), else the mission's own id: the pipeline cuts close-ups under that name.
  const prefix = m.body === 'Moon' ? 'moon' : m.body === 'Mars' ? 'mars' : undefined;
  return prefix ? `${prefix}_${m.patch ?? m.id}` : undefined;
};

export interface SitePatch {
  meta: SitePatchMeta;
  width: number;
  height: number;
  /** Row by row from the north edge, in metres above the body's reference sphere. */
  metres: Float32Array;
}

export function decodePatch(meta: SitePatchMeta, rgba: ArrayLike<number>, width: number, height: number): SitePatch {
  return { meta, width, height, metres: decodeHeights(rgba, width, height).metres };
}

/** Height at a point by bilinear interpolation; undefined outside the square. */
export function patchHeightM(patch: SitePatch, latDeg: number, lonDeg: number): number | undefined {
  const { meta, width: w, height: h, metres } = patch;
  const fx = (lonDeg - (meta.lonDeg - meta.lonHalfDeg)) / (2 * meta.lonHalfDeg);
  const fy = (meta.latDeg + meta.halfDeg - latDeg) / (2 * meta.halfDeg);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return undefined;
  const x = fx * (w - 1);
  const y = fy * (h - 1);
  const x0 = Math.min(w - 2, Math.floor(x));
  const y0 = Math.min(h - 2, Math.floor(y));
  const ax = x - x0;
  const ay = y - y0;
  const at = (r: number, c: number) => metres[r * w + c];
  return (
    (at(y0, x0) * (1 - ax) + at(y0, x0 + 1) * ax) * (1 - ay) +
    (at(y0 + 1, x0) * (1 - ax) + at(y0 + 1, x0 + 1) * ax) * ay
  );
}

/**
 * RGBA slope map for the shader, rows from the north edge. Red and green hold the east and north tilt of the surface
 * normal as sign · sqrt(|tilt|) scaled to 0–255, the coding the globe maps use; blue is unused. A surface that falls
 * toward the east tilts east, so red is above 128 there.
 */
export function patchSlopes(patch: SitePatch, bodyRadiusM: number): Uint8Array {
  const { meta, width: w, height: h, metres: v } = patch;
  const dy = ((2 * meta.halfDeg) / h) * DEG * bodyRadiusM;
  const dxAtEquator = ((2 * meta.lonHalfDeg) / w) * DEG * bodyRadiusM;
  const out = new Uint8Array(w * h * 4);
  const code = (n: number) => Math.round((Math.sign(n) * Math.sqrt(Math.abs(n)) * 0.5 + 0.5) * 255);
  for (let y = 0; y < h; y++) {
    const latDeg = meta.latDeg + meta.halfDeg - ((y + 0.5) / h) * 2 * meta.halfDeg;
    // A pixel is narrower in metres toward a pole; keep it from reaching zero.
    const dx = Math.max(dy * 0.05, dxAtEquator * Math.cos(latDeg * DEG));
    for (let x = 0; x < w; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(w - 1, x + 1);
      const yu = Math.max(0, y - 1);
      const yd = Math.min(h - 1, y + 1);
      const gEast = (v[y * w + xr] - v[y * w + xl]) / ((xr - xl) * dx);
      const gNorth = (v[yu * w + x] - v[yd * w + x]) / ((yd - yu) * dy);
      const len = Math.hypot(gEast, gNorth, 1);
      const k = (y * w + x) * 4;
      out[k] = code(-gEast / len);
      out[k + 1] = code(-gNorth / len);
      out[k + 2] = 128;
      out[k + 3] = 255;
    }
  }
  return out;
}
