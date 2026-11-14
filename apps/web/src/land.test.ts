import { MOON_RADIUS_M, polarToUnit, unitToLatLon } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import fineRegions from './a3clrRegions.json';
import {
  coverageAt,
  fineRegionAt,
  gridReachLatDeg,
  latestOnly,
  TERRAIN_EXTENT,
  touchdownFromQuery,
  touchdownUtcMsOf,
} from './land';

describe('touchdown time', () => {
  const landingUtc = '2026-11-14T12:38:00.000Z';

  it('adds the launch slip once', () => {
    expect(touchdownUtcMsOf(landingUtc, 0)).toBe(Date.parse(landingUtc));
    expect(touchdownUtcMsOf(landingUtc, 3)).toBe(Date.parse('2026-11-17T12:38:00.000Z'));
    expect(touchdownUtcMsOf(landingUtc, -2)).toBe(Date.parse('2026-11-12T12:38:00.000Z'));
  });

  it('takes a stay query’s landing date as it is, since the slip is already in it', () => {
    // As the site report's query is built (physics.ts queryFor): the slip goes in once, through touchdownUtcMsOf.
    const query = { landingUtc: new Date(touchdownUtcMsOf(landingUtc, 3)).toISOString() };
    expect(touchdownFromQuery(query)).toBe(Date.parse('2026-11-17T12:38:00.000Z'));
    // The site report's button and the passing-site search's button land at the same moment.
    expect(touchdownFromQuery(query)).toBe(touchdownUtcMsOf(landingUtc, 3));
  });
});

describe('terrain coverage', () => {
  it('offers the 10 m terrain near the pole and the 30 m further out', () => {
    expect(coverageAt(-90, 0)).toBe('fine');
    expect(coverageAt(-89.45, 222.69 - 360)).toBe('fine');
    expect(coverageAt(-84, 30)).toBe('fine');
    expect(coverageAt(-80, 30)).toBe('coarse');
  });

  it('refuses points outside the south polar terrain, and the north', () => {
    expect(coverageAt(0.67, 23.47)).toBe('none'); // Apollo 11
    expect(coverageAt(-60, 0)).toBe('none');
    expect(coverageAt(89, 0)).toBe('none');
  });

  it('wraps longitude: the same point either side of ±180° has the same coverage', () => {
    expect(coverageAt(-82.9, 179.999)).toBe(coverageAt(-82.9, -180.001 + 360 - 360));
  });

  it('works out how far each grid reaches from its own size', () => {
    expect(gridReachLatDeg(TERRAIN_EXTENT.coarse.halfM)).toBeCloseTo(-75, 0);
    expect(gridReachLatDeg(TERRAIN_EXTENT.fine.halfM)).toBeCloseTo(-82.9, 1);
  });
});

describe('switching sites while one is loading', () => {
  it('drops the answer of a request that a newer one replaced', async () => {
    const latest = latestOnly();
    const shown: string[] = [];
    const load = (name: string, ms: number) => {
      const id = latest.start();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (latest.isCurrent(id)) shown.push(name);
          resolve();
        }, ms),
      );
    };
    // The first site is slow and the second fast; then a third is cancelled.
    await Promise.all([load('first', 30), load('second', 5)]);
    expect(shown).toEqual(['second']);
    const third = load('third', 5);
    latest.cancel();
    await third;
    expect(shown).toEqual(['second']);
  });
});

describe('NASA’s 5 m terrain of the Artemis III regions', () => {
  // The middle of the Connecting Ridge region, from the table's own corner and size.
  const ridge = fineRegions.regions.find((r) => r.name === 'Connecting Ridge');
  const centre =
    ridge &&
    unitToLatLon(
      polarToUnit(ridge.cornerX + (ridge.width * ridge.pixM) / 2, ridge.cornerY - (ridge.height * ridge.pixM) / 2),
    );

  it('lists all thirteen regions, at 5 m, each with its download size', () => {
    expect(fineRegions.regions).toHaveLength(13);
    for (const r of fineRegions.regions) {
      expect(r.pixM).toBe(5);
      expect(r.compressedBytes).toBeGreaterThan(10_000_000);
    }
    expect(MOON_RADIUS_M).toBe(1_737_400);
  });

  it('offers the 5 m terrain inside a region and nowhere else', () => {
    expect(centre).toBeDefined();
    if (!centre) return;
    expect(fineRegionAt(centre.latDeg, centre.lonDeg)?.name).toBe('Connecting Ridge');
    expect(fineRegionAt(-80.5, 10)).toBeUndefined();
    expect(fineRegionAt(0.67, 23.47)).toBeUndefined();
  });

  it('wants room for the 5 m ring around the point', () => {
    if (!ridge || !centre) return;
    const nearEdge = unitToLatLon(polarToUnit(ridge.cornerX + 100, ridge.cornerY - (ridge.height * ridge.pixM) / 2));
    expect(fineRegionAt(nearEdge.latDeg, nearEdge.lonDeg)).toBeDefined();
    expect(fineRegionAt(nearEdge.latDeg, nearEdge.lonDeg, 800)).toBeUndefined();
  });
});
