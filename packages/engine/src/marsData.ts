import { greatCircleKm } from './earthData';

/** Volumetric mean radius of Mars (IAU), the sphere the globe is drawn on. MOLA heights are measured from the areoid. */
export const MARS_RADIUS_KM = 3389.5;

export type MarsFeatureKind = 'crater' | 'vallis' | 'rima' | 'mons' | 'plain' | 'mare';

/** A named feature from the IAU Gazetteer of Planetary Nomenclature; longitude is east-positive. */
export interface MarsFeature {
  name: string;
  latDeg: number;
  lonDeg: number;
  diameterKm: number;
  kind: MarsFeatureKind;
}

export type MarsFeatureRow = [name: string, latDeg: number, lonDeg: number, diameterKm: number, kind: string];

/** Largest first, so labels can be drawn in order of importance and a search finds the famous one. */
export function parseMarsFeatures(rows: readonly MarsFeatureRow[]): MarsFeature[] {
  return rows
    .map(([name, latDeg, lonDeg, diameterKm, kind]) => ({
      name,
      latDeg,
      lonDeg,
      diameterKm,
      kind: kind as MarsFeatureKind,
    }))
    .sort((a, b) => b.diameterKm - a.diameterKm);
}

/** Elevation in metres on an equirectangular grid whose corner pixels sit on the edges: −180° to 180°, 90° to −90°. */
export interface HeightGrid {
  readonly width: number;
  readonly height: number;
  readonly metres: Float32Array;
}

/** Heights are stored as a 16-bit number in red (high byte) and green (low byte), 32768 being zero. */
export function decodeHeights(rgba: ArrayLike<number>, width: number, height: number): HeightGrid {
  const metres = new Float32Array(width * height);
  for (let i = 0; i < metres.length; i++) metres[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] - 32768;
  return { width, height, metres };
}

/** Bilinear elevation in metres at a planetocentric point. */
export function heightAtM(grid: HeightGrid, latDeg: number, lonDeg: number): number {
  const { width: w, height: h, metres } = grid;
  const col = ((lonDeg + 180) / 360) * (w - 1);
  const row = ((90 - latDeg) / 180) * (h - 1);
  const c0 = Math.max(0, Math.min(w - 2, Math.floor(col)));
  const r0 = Math.max(0, Math.min(h - 2, Math.floor(row)));
  const fc = Math.max(0, Math.min(1, col - c0));
  const fr = Math.max(0, Math.min(1, row - r0));
  const at = (r: number, c: number) => metres[r * w + c];
  return (
    (at(r0, c0) * (1 - fc) + at(r0, c0 + 1) * fc) * (1 - fr) +
    (at(r0 + 1, c0) * (1 - fc) + at(r0 + 1, c0 + 1) * fc) * fr
  );
}

/** How far from a feature's centre a click can be and still count as "near" it, when it is outside every feature. */
export const NEAR_FEATURE_KM = 250;

/** The smallest feature the point is inside; failing that, the nearest centre within `NEAR_FEATURE_KM`. */
export function featureAt(
  features: readonly MarsFeature[],
  latDeg: number,
  lonDeg: number,
): { feature: MarsFeature; distKm: number; inside: boolean } | undefined {
  let inside: { feature: MarsFeature; distKm: number; inside: boolean } | undefined;
  let near: { feature: MarsFeature; distKm: number; inside: boolean } | undefined;
  for (const feature of features) {
    // One degree of latitude is 59 km on Mars; reject far features before the trigonometry.
    if (Math.abs(feature.latDeg - latDeg) * 59 > Math.max(NEAR_FEATURE_KM, feature.diameterKm / 2)) continue;
    const distKm = greatCircleKm(latDeg, lonDeg, feature.latDeg, feature.lonDeg, MARS_RADIUS_KM);
    if (distKm <= feature.diameterKm / 2) {
      if (!inside || feature.diameterKm < inside.feature.diameterKm) inside = { feature, distKm, inside: true };
    } else if (distKm <= NEAR_FEATURE_KM && (!near || distKm < near.distKm)) near = { feature, distKm, inside: false };
  }
  return inside ?? near;
}

/** An exact name first, then names that start with the text, then names that contain it; bigger features win. */
export function findFeature(features: readonly MarsFeature[], query: string): MarsFeature | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    features.find((f) => f.name.toLowerCase() === q) ??
    features.find((f) => f.name.toLowerCase().startsWith(q)) ??
    features.find((f) => f.name.toLowerCase().includes(q))
  );
}
