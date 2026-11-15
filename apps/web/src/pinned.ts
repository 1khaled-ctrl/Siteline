import { polarXY, siteFrame } from '@siteline/physics';
import { REGIONS } from './regions';

/**
 * The named region a pinned spot lies in, if any: one of NASA's Artemis candidate regions whose centre is within half
 * its size of the spot, measured on LOLA's south polar plane (the nearest, where two overlap). A spot outside every
 * region has no name, and is shown by its latitude and longitude.
 */
export function regionOf(latDeg: number, lonDeg: number, regions = REGIONS): string | undefined {
  if (latDeg > 0) return undefined;
  const at = polarXY(siteFrame(latDeg, lonDeg).u);
  let best: { name: string; distM: number } | undefined;
  for (const r of regions) {
    const c = polarXY(siteFrame(r.lat, r.lon).u);
    const distM = Math.hypot(at.x - c.x, at.y - c.y);
    if (distM <= (r.sizeKm * 1000) / 2 && (!best || distM < best.distM)) best = { name: r.name, distM };
  }
  return best?.name;
}
