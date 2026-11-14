import { polarXY } from './dem';
import { siteFrame } from './frames';

/** Precomputed polar layers on a square grid in the same south polar stereographic plane as the terrain. */
export interface PolarMaps {
  n: number;
  pixM: number;
  /** Long-term sunlight, percent. */
  sunPct: Float32Array;
  /** Long-term Earth visibility, percent. */
  earthPct: Float32Array;
  /** 1 where the ground is never sunlit. */
  shadowed: Uint8Array;
  /** Distance to the nearest never-sunlit cell, km, where the maps carry it; `shadowDistanceCapKm` is its reach. */
  shadowDistanceKm?: Float32Array;
  shadowDistanceCapKm?: number;
}

/**
 * Decode a maps file: n×n uint8 planes, sunlight ×2, Earth-view ×2, never-sunlit flag, and, when `distanceUnitKm`
 * is given, a fourth: the distance to the nearest never-sunlit cell in that unit (255 is as far as it reaches).
 */
export function mapsFromBytes(bytes: Uint8Array, n: number, pixM: number, distanceUnitKm?: number): PolarMaps {
  const size = n * n;
  const planes = distanceUnitKm === undefined ? 3 : 4;
  if (bytes.length !== planes * size) throw new Error(`maps need ${planes * size} bytes, got ${bytes.length}`);
  const maps: PolarMaps = {
    n,
    pixM,
    sunPct: Float32Array.from(bytes.subarray(0, size), (v) => v / 2),
    earthPct: Float32Array.from(bytes.subarray(size, 2 * size), (v) => v / 2),
    shadowed: Uint8Array.from(bytes.subarray(2 * size, 3 * size)),
  };
  if (distanceUnitKm !== undefined) {
    maps.shadowDistanceKm = Float32Array.from(bytes.subarray(3 * size, 4 * size), (v) => v * distanceUnitKm);
    maps.shadowDistanceCapKm = 255 * distanceUnitKm;
  }
  return maps;
}

/** The highest long-term sunlight anywhere on the maps, percent: where a colour ramp should top out. */
export function maxSunPct(maps: PolarMaps): number {
  let top = 0;
  for (const v of maps.sunPct) if (v > top) top = v;
  return top;
}

/** Bilinear value at plane coordinates in metres (row 0 at +y), NaN outside the grid. */
export function mapValue(maps: PolarMaps, plane: Float32Array, x: number, y: number): number {
  const half = (maps.n - 1) / 2;
  const last = maps.n - 1;
  const s = x / maps.pixM + half;
  const l = half - y / maps.pixM;
  if (!(s >= 0 && l >= 0 && s <= last && l <= last)) return Number.NaN;
  const s0 = Math.min(Math.floor(s), last - 1);
  const l0 = Math.min(Math.floor(l), last - 1);
  const fs = s - s0;
  const fl = l - l0;
  const i = l0 * maps.n + s0;
  const top = plane[i] * (1 - fs) + plane[i + 1] * fs;
  const bottom = plane[i + maps.n] * (1 - fs) + plane[i + maps.n + 1] * fs;
  return top * (1 - fl) + bottom * fl;
}

export function mapsAtSite(maps: PolarMaps, latDeg: number, lonDeg: number) {
  const p = polarXY(siteFrame(latDeg, lonDeg).u);
  const half = (maps.n - 1) / 2;
  const r = Math.round(half - p.y / maps.pixM);
  const c = Math.round(p.x / maps.pixM + half);
  const inside = r >= 0 && c >= 0 && r < maps.n && c < maps.n;
  return {
    sunPct: mapValue(maps, maps.sunPct, p.x, p.y),
    earthPct: mapValue(maps, maps.earthPct, p.x, p.y),
    shadowed: inside ? maps.shadowed[r * maps.n + c] === 1 : undefined,
    // Undefined where the maps carry no distance, or the nearest shadow is past what they reach.
    shadowDistanceKm: distanceAt(maps, p.x, p.y),
  };
}

function distanceAt(maps: PolarMaps, x: number, y: number): number | undefined {
  if (!maps.shadowDistanceKm || maps.shadowDistanceCapKm === undefined) return undefined;
  const km = mapValue(maps, maps.shadowDistanceKm, x, y);
  return Number.isFinite(km) && km < maps.shadowDistanceCapKm ? km : undefined;
}
