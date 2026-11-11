import { describe, expect, it } from 'vitest';
import { mapsAtSite, mapsFromBytes, mapValue } from './maps';

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
  });
});
