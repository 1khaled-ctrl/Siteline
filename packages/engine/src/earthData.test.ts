import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countryAt,
  decodeLines,
  type EarthCountriesJson,
  type EarthCountry,
  type EarthDetailJson,
  greatCircleKm,
  lineSegments,
  lonLatToScene,
  nearestCity,
  parseCities,
  parseCountries,
  sceneToLonLat,
} from './earthData';

const pack = (...pairs: number[]) => Buffer.from(Int16Array.from(pairs).buffer).toString('base64');
const PEN_UP = 32767;

describe('packed Earth lines', () => {
  it('reads hundredths of a degree and turns a pen lift into NaN', () => {
    const ll = decodeLines(pack(3550, 3387, PEN_UP, PEN_UP, -12000, -4500));
    expect(Array.from(ll.subarray(0, 2))).toEqual([35.5, 33.87].map(Math.fround));
    expect(Number.isNaN(ll[2]) && Number.isNaN(ll[3])).toBe(true);
    expect(Array.from(ll.subarray(4))).toEqual([-120, -45]);
  });

  it('joins consecutive points, breaks at a pen lift and does not draw across the antimeridian', () => {
    const segments = lineSegments(pack(0, 0, 1000, 0, PEN_UP, PEN_UP, 2000, 0, 17900, 0, -17900, 0, -17800, 0));
    // 0°→10°, then 20°→179° and −179°→−178; the jump 179°→−179° is skipped.
    expect(segments).toHaveLength(3 * 6);
    for (let i = 0; i < segments.length; i += 3) {
      expect(Math.hypot(segments[i], segments[i + 1], segments[i + 2])).toBeCloseTo(1, 6);
    }
  });
});

describe('sphere coordinates', () => {
  it('puts 0°E on +X, 90°E on −Z and the north pole on +Y', () => {
    expect(lonLatToScene(0, 0)).toEqual([1, 0, -0]);
    const east = lonLatToScene(0, 90);
    expect(east[0]).toBeCloseTo(0, 12);
    expect(east[2]).toBeCloseTo(-1, 12);
    expect(lonLatToScene(90, 0)[1]).toBe(1);
  });

  it('round-trips latitude and longitude', () => {
    for (const [lat, lon] of [
      [33.874, 35.508],
      [-54.8, -68.3],
      [0, 179.9],
    ]) {
      const back = sceneToLonLat(...lonLatToScene(lat, lon));
      expect(back.latDeg).toBeCloseTo(lat, 9);
      expect(back.lonDeg).toBeCloseTo(lon, 9);
    }
  });

  it('measures a degree of longitude on the equator as 2π·R/360', () => {
    expect(greatCircleKm(0, 10, 0, 11)).toBeCloseTo(111.1949, 3);
    expect(greatCircleKm(10, 20, 10, 20)).toBe(0);
  });
});

describe('picking', () => {
  const lebanon: EarthCountry = {
    id: 258,
    name: 'Lebanon',
    nameAr: 'لبنان',
    latDeg: 0,
    lonDeg: 0,
    areaKm2: 1,
    rank: 1,
  };
  const byId = new Map([[lebanon.id, lebanon]]);
  // A 4 × 2 raster: the pixel at column 3, row 0 is land with id 258 (258 = 2 + 1 × 256).
  const data = new Uint8Array(4 * 2 * 4);
  data.set([2, 1, 255, 255], 3 * 4);

  it('finds the country under a point, and nothing at sea', () => {
    const ids = { width: 4, height: 2, data };
    expect(countryAt(ids, byId, 45, 135)?.name).toBe('Lebanon');
    expect(countryAt(ids, byId, 45, -135)).toBeUndefined();
    expect(countryAt(ids, byId, -45, 135)).toBeUndefined();
  });

  it('clamps the poles and the antimeridian to the raster edge', () => {
    const ids = { width: 4, height: 2, data };
    expect(countryAt(ids, byId, 90, 180)?.name).toBe('Lebanon');
  });

  it('finds the nearest city inside a radius, and none outside', () => {
    const cities = parseCities([
      ['Far', '', 40, 40, 1000, 5, 0, 'X'],
      ['Near', '', 10.1, 20.1, 500, 5, 0, 'X'],
    ]);
    expect(nearestCity(cities, 10, 20, 50)?.city.name).toBe('Near');
    expect(nearestCity(cities, 10, 20, 5)).toBeUndefined();
  });

  it('orders cities by zoom level, then by population', () => {
    const cities = parseCities([
      ['Small', '', 0, 0, 10, 5, 0, 'X'],
      ['Big', '', 0, 0, 100, 5, 0, 'X'],
      ['Huge', '', 0, 0, 1, 1, 0, 'X'],
    ]);
    expect(cities.map((c) => c.name)).toEqual(['Huge', 'Big', 'Small']);
  });
});

const dataDir = fileURLToPath(new URL('../../../pipeline/raw/landfall/data/', import.meta.url));
const haveData = existsSync(`${dataDir}earth.json`) && existsSync(`${dataDir}earth10.json`);

describe.skipIf(!haveData)('the Landfall Earth data', () => {
  const load = <T>(name: string) => JSON.parse(readFileSync(`${dataDir}${name}`, 'utf8')) as T;

  it('has the 241 labelled countries, and Lebanon where it should be', () => {
    const countries = parseCountries(load<EarthCountriesJson>('earth.json'));
    expect(countries).toHaveLength(241);
    const lebanon = countries.find((c) => c.name === 'Lebanon');
    expect(lebanon?.latDeg).toBeCloseTo(33.92, 1);
    expect(lebanon?.lonDeg).toBeCloseTo(35.88, 1);
    expect(new Set(countries.map((c) => c.id)).size).toBe(241);
  });

  it('finds Beirut from a point in the city, and ranks it among the first-level cities', () => {
    const cities = parseCities(load<EarthDetailJson>('earth10.json').cities);
    expect(cities).toHaveLength(7342);
    const found = nearestCity(cities, 33.89, 35.5, 20);
    expect(found?.city.name).toBe('Beirut');
    expect(found?.city.country).toBe('Lebanon');
    expect(found?.distKm).toBeLessThan(5);
    expect(cities[0].zoomLevel).toBeLessThanOrEqual(cities[cities.length - 1].zoomLevel);
  });

  it('draws only short segments, so no line streaks across the map', () => {
    const json = load<EarthCountriesJson>('earth.json');
    for (const packed of [json.coast, json.borders]) {
      const s = lineSegments(packed);
      expect(s.length).toBeGreaterThan(6000);
      for (let i = 0; i < s.length; i += 6) {
        const chord = Math.hypot(s[i] - s[i + 3], s[i + 1] - s[i + 4], s[i + 2] - s[i + 5]);
        // 60° of arc would be a chord of 1; real 1:50m segments are a few degrees at most.
        if (chord > 0.5) throw new Error(`segment of ${chord} at ${i}`);
      }
    }
  });
});
