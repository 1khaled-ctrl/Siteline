import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { greatCircleKm } from './earthData';
import {
  decodeHeights,
  featureAt,
  findFeature,
  heightAtM,
  labelStyleOf,
  MARS_RADIUS_KM,
  type MarsFeatureRow,
  type MarsNamesJson,
  parseMarsFeatures,
} from './marsData';
import { readPngRgb } from './testPng';

const rows: MarsFeatureRow[] = [
  ['Small crater', 10, 20, 20, 'Crater'],
  ['Big plain', 10, 20, 3000, 'Planitia'],
  ['Far mons', -40, 100, 600, 'Mons'],
];

describe('named features', () => {
  const features = parseMarsFeatures(rows);

  it('lists the biggest first', () => {
    expect(features.map((f) => f.name)).toEqual(['Big plain', 'Far mons', 'Small crater']);
  });

  it('names the smallest feature a point is inside', () => {
    expect(featureAt(features, 10.05, 20.05)?.feature.name).toBe('Small crater');
    // 3 degrees away is 177 km: outside the 10 km crater, inside the 3000 km plain.
    expect(featureAt(features, 13, 20)?.feature.name).toBe('Big plain');
  });

  it('falls back to the nearest centre within 250 km and otherwise names nothing', () => {
    // 600 km wide, so its edge is 300 km out: 4 degrees (236 km) south of the centre is inside it.
    expect(featureAt(features, -44, 100)?.inside).toBe(true);
    const lone = parseMarsFeatures([['Lone crater', 0, 0, 20, 'Crater']]);
    expect(featureAt(lone, 2, 0)).toMatchObject({ inside: false });
    expect(featureAt(lone, 2, 0)?.distKm).toBeCloseTo((2 * Math.PI * MARS_RADIUS_KM) / 180, 3);
    expect(featureAt(lone, 6, 0)).toBeUndefined();
  });

  it('searches by exact name, then prefix, then any part', () => {
    expect(findFeature(features, 'far mons')?.name).toBe('Far mons');
    expect(findFeature(features, 'big')?.name).toBe('Big plain');
    expect(findFeature(features, 'crat')?.name).toBe('Small crater');
    expect(findFeature(features, 'zzz')).toBeUndefined();
    expect(findFeature(features, '  ')).toBeUndefined();
  });
});

describe('elevation grid', () => {
  // 3 columns × 3 rows: longitudes −180, 0, 180 and latitudes 90, 0, −90, in metres.
  const metres = [0, 100, 200, 300, 400, 500, 600, 700, 800];
  const rgba = metres.flatMap((m) => [(m + 32768) >> 8, (m + 32768) & 255, 0, 255]);
  const grid = decodeHeights(rgba, 3, 3);

  it('reads a 16-bit height from red and green, with 32768 as zero', () => {
    expect(Array.from(grid.metres)).toEqual(metres);
    expect(decodeHeights([0, 0, 0, 255], 1, 1).metres[0]).toBe(-32768);
  });

  it('puts the grid corners on the edges of the map and interpolates between them', () => {
    expect(heightAtM(grid, 90, -180)).toBe(0);
    expect(heightAtM(grid, 0, 0)).toBe(400);
    expect(heightAtM(grid, -90, 180)).toBe(800);
    expect(heightAtM(grid, 0, 90)).toBeCloseTo(450, 9);
    expect(heightAtM(grid, 45, 0)).toBeCloseTo(250, 9);
  });
});

const imgDir = fileURLToPath(new URL('../../../pipeline/raw/landfall/img/', import.meta.url));
const namesPath = fileURLToPath(new URL('../../../pipeline/out/names/mars_names.json', import.meta.url));
const haveMars = existsSync(`${imgDir}mars_height.png`) && existsSync(namesPath);

describe.skipIf(!haveMars)('the Landfall Mars data', () => {
  const png = haveMars ? readPngRgb(`${imgDir}mars_height.png`) : undefined;
  const grid = png ? decodeHeights(png.rgba, png.width, png.height) : undefined;
  const namesFile = haveMars ? (JSON.parse(readFileSync(namesPath, 'utf8')) as MarsNamesJson) : undefined;
  const names: MarsFeatureRow[] = namesFile?.features ?? [];

  it('has MOLA heights that agree with the well-known elevations of Mars', () => {
    if (!grid) throw new Error('no grid');
    expect([grid.width, grid.height]).toEqual([1025, 513]);
    // The highest ground on Mars is Olympus Mons (18.65°N, 133.8°W), 21.2 km above the areoid; the lowest is the
    // floor of the Hellas basin, about −8.2 km. A grid cell is 21 km wide, so each extreme lands a little short.
    const where = (i: number) => ({
      latDeg: 90 - (Math.floor(i / grid.width) / (grid.height - 1)) * 180,
      lonDeg: ((i % grid.width) / (grid.width - 1)) * 360 - 180,
    });
    let highest = 0;
    let lowest = 0;
    grid.metres.forEach((m, i) => {
      if (m > grid.metres[highest]) highest = i;
      if (m < grid.metres[lowest]) lowest = i;
    });
    expect(grid.metres[highest]).toBeGreaterThan(20_500);
    expect(grid.metres[highest]).toBeLessThan(22_000);
    expect(Math.abs(where(highest).latDeg - 18.65)).toBeLessThan(3);
    expect(Math.abs(where(highest).lonDeg + 133.8)).toBeLessThan(3);
    expect(grid.metres[lowest]).toBeGreaterThan(-8_500);
    expect(grid.metres[lowest]).toBeLessThan(-7_500);
    // Hellas Planitia is centred at 42.4°S, 70.5°E and 2,300 km across.
    expect(greatCircleKm(where(lowest).latDeg, where(lowest).lonDeg, -42.43, 70.5, MARS_RADIUS_KM)).toBeLessThan(1_150);
    // Viking 1 touched down near −3.6 km.
    expect(Math.abs(heightAtM(grid, 22.27, -47.95) + 3600)).toBeLessThan(500);
  });

  it('names the landing sites and the big volcano where the gazetteer puts them', () => {
    const features = parseMarsFeatures(names);
    expect(features.length).toBeGreaterThan(2000);
    // The summit sits inside Hera Patera, a caldera feature; a point on the flank is inside Olympus Mons alone.
    expect(findFeature(features, 'olympus mons')).toMatchObject({
      name: 'Olympus Mons',
      type: 'Mons',
      diameterKm: 610.13,
    });
    expect(featureAt(features, 18.65, -133.8)?.feature.name).toBe('Hera Patera');
    expect(featureAt(features, 20.65, -133.8)?.feature.name).toBe('Olympus Mons');
    expect(featureAt(features, 18.44, 77.45)?.feature).toMatchObject({ name: 'Jezero', type: 'Crater' });
    // Curiosity is on the flank of Mount Sharp, the smallest named feature inside Gale crater.
    expect(featureAt(features, -4.59, 137.44)?.feature.name).toBe('Aeolis Mons');
    expect(findFeature(features, 'gale')?.name).toBe('Gale');
    expect(findFeature(features, 'valles')?.name).toBe('Valles Marineris');
  });

  it('holds only names the IAU has adopted, from a file that says it is public domain', () => {
    expect(namesFile?.source.useConstraints).toMatch(/public domain/i);
    expect(names.some(([name]) => name.startsWith('['))).toBe(false);
    // The Gazetteer gives no size for a few old features (albedo regions mostly), and 0 stands for that.
    expect(names.filter((n) => n[3] === 0).length).toBeLessThan(names.length / 10);
    // Every feature has a plausible place on the planet and a descriptor term we know how to draw.
    for (const [, latDeg, lonDeg, diameterKm, type] of names) {
      expect(Math.abs(latDeg)).toBeLessThanOrEqual(90);
      expect(Math.abs(lonDeg)).toBeLessThanOrEqual(180);
      expect(diameterKm).toBeGreaterThanOrEqual(0);
      expect(['region', 'peak', 'linear', 'crater']).toContain(labelStyleOf(type));
    }
  });
});

describe('searching names', () => {
  it('ignores accents and case', () => {
    const features = parseMarsFeatures([
      ['Köppen', 1, 1, 10, 'Crater'],
      ['Hephaestus Rupēs', 2, 2, 100, 'Rupes'],
    ]);
    expect(findFeature(features, 'koppen')?.name).toBe('Köppen');
    expect(findFeature(features, 'HEPHAESTUS RUPES')?.name).toBe('Hephaestus Rupēs');
  });
});

describe('label styles', () => {
  it('give regions, mountains, long features and craters their own look', () => {
    expect(['Planitia', 'Mons', 'Vallis', 'Crater'].map(labelStyleOf)).toEqual(['region', 'peak', 'linear', 'crater']);
  });
});
