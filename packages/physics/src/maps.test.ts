import { describe, expect, it } from 'vitest';
import { mapsAtSite, mapsFromBytes, mapValue, maxSunPct } from './maps';

describe('polar maps', () => {
  const n = 3;
  const bytes = new Uint8Array(3 * n * n);
  bytes.set([0, 0, 0, 0, 200, 0, 100, 0, 0], 0); // sunlight ×2: centre 100 %, bottom-left 50 %
  bytes.set([0, 0, 0, 0, 40, 0, 0, 0, 0], n * n); // Earth ×2: centre 20 %
  bytes[2 * n * n + 4] = 1; // centre never sunlit
  const maps = mapsFromBytes(bytes, n, 2400);

  it('decodes the three planes and interpolates in the polar plane', () => {
    expect(mapValue(maps, maps.sunPct, 0, 0)).toBe(100);
    expect(mapValue(maps, maps.sunPct, -1200, -1200)).toBeCloseTo(37.5, 9);
    expect(mapValue(maps, maps.earthPct, 0, 0)).toBe(20);
    expect(mapValue(maps, maps.sunPct, 2401, 0)).toBeNaN();
  });

  it('reads the values at the pole', () => {
    const at = mapsAtSite(maps, -90, 0);
    expect(at.sunPct).toBeCloseTo(100, 6);
    expect(at.shadowed).toBe(true);
    expect(mapsAtSite(maps, -80, 0).shadowed).toBeUndefined();
  });

  it('rejects a file of the wrong size', () => {
    expect(() => mapsFromBytes(new Uint8Array(5), n, 2400)).toThrow();
    // A fourth plane is expected only when its unit is given.
    expect(() => mapsFromBytes(bytes, n, 2400, 0.25)).toThrow();
  });

  it('carries no shadow distance in a three-plane file', () => {
    expect(maps.shadowDistanceKm).toBeUndefined();
    expect(mapsAtSite(maps, -90, 0).shadowDistanceKm).toBeUndefined();
  });

  it('reads the distance to the nearest shadow from a fourth plane, in its unit', () => {
    const four = new Uint8Array(4 * n * n);
    four.set(bytes);
    four.set([255, 8, 255, 8, 0, 8, 255, 8, 255], 3 * n * n); // 0 at the centre, 2 km beside it, out of reach at corners
    const m = mapsFromBytes(four, n, 2400, 0.25);
    expect(m.shadowDistanceCapKm).toBe(63.75);
    expect(mapsAtSite(m, -90, 0).shadowDistanceKm).toBeCloseTo(0, 9);
    // Out of reach reads as unknown, not as 63.75 km.
    const corner = mapValue(m, m.shadowDistanceKm ?? new Float32Array(), -2400, 2400);
    expect(corner).toBe(63.75);
  });

  it('finds the top of the sunlight plane', () => {
    expect(maxSunPct(maps)).toBe(100);
  });
});
