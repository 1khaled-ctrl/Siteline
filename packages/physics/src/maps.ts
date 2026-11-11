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
}

/** Decode the concept demo's maps file: three n×n uint8 planes, sunlight ×2, Earth-view ×2, never-sunlit flag. */
export function mapsFromBytes(bytes: Uint8Array, n: number, pixM: number): PolarMaps {
  const size = n * n;
  if (bytes.length !== 3 * size) throw new Error(`maps need ${3 * size} bytes, got ${bytes.length}`);
  return {
    n,
    pixM,
    sunPct: Float32Array.from(bytes.subarray(0, size), (v) => v / 2),
    earthPct: Float32Array.from(bytes.subarray(size, 2 * size), (v) => v / 2),
    shadowed: Uint8Array.from(bytes.subarray(2 * size, 3 * size)),
  };
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
  };
}
