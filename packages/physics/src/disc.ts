import { DEG } from './vec';

export const SUN_RADIUS_KM = 695_700;
export const EARTH_RADIUS_KM = 6371.0;

export const angularRadiusDeg = (radiusKm: number, distKm: number): number => Math.asin(radiusKm / distKm) / DEG;

/** Visible fraction of a disc above a locally straight horizon. */
export function discFraction(elevDeg: number, horizonDeg: number, radiusDeg: number): number {
  const x = Math.max(-1, Math.min(1, (elevDeg - horizonDeg) / radiusDeg));
  return (Math.acos(-x) + x * Math.sqrt(1 - x * x)) / Math.PI;
}
