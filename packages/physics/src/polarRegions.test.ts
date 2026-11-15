import { describe, expect, it } from 'vitest';
import { polarToUnit, polarXY } from './dem';
import { MOON_RADIUS_KM, siteFrame } from './frames';
import { nearestPolarRegion, polarRegionsFromGeoJson } from './polarRegions';
import { DEG } from './vec';

type XY = [number, number];
const xyOf = (latDeg: number, lonDeg: number): XY => {
  const p = polarXY(siteFrame(latDeg, lonDeg).u);
  return [p.x, p.y];
};
/** A ring through latitude/longitude corners, closed the way GeoJSON closes it. */
const ring = (...corners: [number, number][]): XY[] => {
  const r = corners.map(([lat, lon]) => xyOf(lat, lon));
  return [...r, r[0]];
};
/** A ring through plane points, closed. */
const planeRing = (...points: XY[]): XY[] => [...points, points[0]];
const square = (cx: number, cy: number, halfM: number): XY[] =>
  planeRing([cx - halfM, cy - halfM], [cx + halfM, cy - halfM], [cx + halfM, cy + halfM], [cx - halfM, cy + halfM]);
const polygon = (...rings: XY[][]) => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: rings },
});
const collection = (...features: unknown[]) => ({ type: 'FeatureCollection', features });
const regionsOf = (...features: unknown[]) => polarRegionsFromGeoJson(collection(...features));
/** One degree of arc on the 1737.4 km sphere, km. */
const DEGREE_KM = MOON_RADIUS_KM * DEG;
/** Distance to the great circle of a meridian, from a site `dLonDeg` away from it at `latDeg`: asin(cos φ sin Δλ). */
const offMeridianKm = (latDeg: number, dLonDeg: number) =>
  Math.asin(Math.cos(latDeg * DEG) * Math.sin(Math.abs(dLonDeg) * DEG)) * MOON_RADIUS_KM;

/** A repeatable stream of numbers in [0, 1). */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

describe('nearestPolarRegion', () => {
  // A strip one degree of longitude wide, from 88° S to 86° S, west of the 0° meridian: its east edge is that meridian.
  const strip = polygon(ring([-88, 0], [-86, 0], [-86, -1], [-88, -1]));

  it('is 0 inside a region', () => {
    expect(nearestPolarRegion(regionsOf(strip), -87, -0.5)).toEqual({ index: 0, distanceKm: 0, inside: true });
  });

  it('measures across to an edge over the sphere: a site off the meridian edge', () => {
    const near = nearestPolarRegion(regionsOf(strip), -87, 0.5);
    expect(near?.inside).toBe(false);
    expect(Math.abs((near?.distanceKm ?? Number.NaN) - offMeridianKm(-87, 0.5))).toBeLessThan(0.001);
  });

  it('measures to the nearer end where the perpendicular misses the edge: one degree north of the strip', () => {
    const near = nearestPolarRegion(regionsOf(strip), -85, 0);
    expect(Math.abs((near?.distanceKm ?? Number.NaN) - DEGREE_KM)).toBeLessThan(0.001);
  });

  it('counts a hole as outside, and measures to its edge', () => {
    // A 20 km square around the pole with an 8 km hole in its middle; the pole is 4 km from the hole's sides.
    const holed = regionsOf(polygon(square(0, 0, 10_000), square(0, 0, 4_000)));
    const atPole = nearestPolarRegion(holed, -90, 0);
    expect(atPole?.inside).toBe(false);
    expect(Math.abs((atPole?.distanceKm ?? Number.NaN) - 4)).toBeLessThan(0.001);
    // Between the hole and the outline is inside.
    expect(nearestPolarRegion(holed, ...latLonOf(7_000, 0))?.inside).toBe(true);
  });

  it('works from exactly the pole', () => {
    // A triangle whose tip points at the pole from 89° S: the tip is the nearest point, one degree away.
    const tip = regionsOf(polygon(ring([-89, 45], [-88, 40], [-88, 50])));
    expect(Math.abs((nearestPolarRegion(tip, -90, 0)?.distanceKm ?? Number.NaN) - DEGREE_KM)).toBeLessThan(0.001);
    expect(nearestPolarRegion(regionsOf(polygon(square(0, 0, 1_000))), -90, 123)?.inside).toBe(true);
  });

  it('handles a region across longitude ±180°', () => {
    const across = regionsOf(polygon(ring([-86, 179], [-86, -179], [-88, -179], [-88, 179])));
    expect(nearestPolarRegion(across, -87, 180)?.inside).toBe(true);
    expect(nearestPolarRegion(across, -87, -180)?.inside).toBe(true);
    const west = nearestPolarRegion(across, -87, 178);
    expect(Math.abs((west?.distanceKm ?? Number.NaN) - offMeridianKm(-87, 1))).toBeLessThan(0.001);
  });

  it('agrees with the nearest vertex of a finely drawn outline, within half the vertex spacing', () => {
    // A 5 km circle at 85° S drawn with 2,000 vertices, about 16 m apart, like the published outlines.
    const [cx, cy] = xyOf(-85, 30);
    const n = 2_000;
    const points: XY[] = Array.from({ length: n }, (_, i) => [
      cx + 5_000 * Math.sin((2 * Math.PI * i) / n),
      cy + 5_000 * Math.cos((2 * Math.PI * i) / n),
    ]);
    const circle = regionsOf(polygon(planeRing(...points)));
    const spacingKm = (2 * Math.PI * 5) / n;
    const units = points.map(([x, y]) => polarToUnit(x, y));
    const rand = random(11);
    for (let k = 0; k < 40; k++) {
      const a = 2 * Math.PI * rand();
      const r = 5_500 + 30_000 * rand();
      const [lat, lon] = latLonOf(cx + r * Math.sin(a), cy + r * Math.cos(a));
      const s = siteFrame(lat, lon).u;
      const bruteKm = Math.min(...units.map((u) => angle(s, u))) * MOON_RADIUS_KM;
      const km = nearestPolarRegion(circle, lat, lon)?.distanceKm ?? Number.NaN;
      expect(km).toBeLessThanOrEqual(bruteKm + 1e-9);
      expect(bruteKm - km).toBeLessThan(spacingKm / 2);
    }
  });

  it('finds the same nearest region with its pruning as by measuring every region', () => {
    // Thin strips at every angle, crowded together: a tilted strip's box is far bigger than the strip, so the boxes rank
    // the strips differently from their true distances, which is where a careless pruning would go wrong.
    const rand = random(5);
    const [cx, cy] = xyOf(-86, 60);
    const strip = () => {
      const x = cx + 80_000 * (rand() - 0.5);
      const y = cy + 80_000 * (rand() - 0.5);
      const a = Math.PI * rand();
      const [dx, dy] = [Math.cos(a), Math.sin(a)];
      const [len, wid] = [3_000 + 9_000 * rand(), 100 + 200 * rand()];
      return polygon(
        planeRing(
          [x + len * dx + wid * dy, y + len * dy - wid * dx],
          [x - len * dx + wid * dy, y - len * dy - wid * dx],
          [x - len * dx - wid * dy, y - len * dy + wid * dx],
          [x + len * dx - wid * dy, y + len * dy + wid * dx],
        ),
      );
    };
    const scattered = regionsOf(...Array.from({ length: 60 }, strip));
    for (let k = 0; k < 60; k++) {
      const [lat, lon] = latLonOf(cx + 90_000 * (rand() - 0.5), cy + 90_000 * (rand() - 0.5));
      const pruned = nearestPolarRegion(scattered, lat, lon);
      const each = scattered.map((r) => nearestPolarRegion([r], lat, lon)?.distanceKm ?? Number.POSITIVE_INFINITY);
      const best = Math.min(...each);
      expect(pruned?.distanceKm).toBeCloseTo(best, 9);
      expect(each[pruned?.index ?? -1]).toBeCloseTo(best, 9);
    }
  });

  it('gives nothing without regions or a site', () => {
    expect(nearestPolarRegion([], -89, 0)).toBeUndefined();
    expect(nearestPolarRegion(regionsOf(strip), Number.NaN, 0)).toBeUndefined();
  });
});

describe('polarRegionsFromGeoJson', () => {
  it('reads polygons and multipolygons in the file order, holes kept', () => {
    const multi = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0, 1_000)], [square(50_000, 0, 1_000)]] },
    };
    const regions = regionsOf(polygon(square(0, 20_000, 1_000), square(0, 20_000, 200)), multi);
    expect(regions).toHaveLength(2);
    expect(regions[0].rings).toHaveLength(2);
    expect(regions[1].rings).toHaveLength(2);
    expect(nearestPolarRegion(regions, ...latLonOf(50_000, 0))).toEqual({ index: 1, distanceKm: 0, inside: true });
  });

  it('refuses what it cannot read rather than guess', () => {
    expect(() => polarRegionsFromGeoJson({ type: 'Feature' })).toThrow(/FeatureCollection/);
    expect(() => polarRegionsFromGeoJson({ ...collection(), crs: { type: 'name' } })).toThrow(/CRS/);
    const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } };
    expect(() => regionsOf(point)).toThrow(/Polygon/);
    expect(() =>
      regionsOf(
        polygon([
          [0, 0],
          [1, 0],
          [0, 0],
        ]),
      ),
    ).toThrow(/four positions/);
    expect(() =>
      regionsOf(
        polygon([
          [0, 0],
          [1, 0],
          [1, Number.NaN],
          [0, 0],
        ] as XY[]),
      ),
    ).toThrow(/pair of numbers/);
  });
});

function latLonOf(x: number, y: number): [number, number] {
  const u = polarToUnit(x, y);
  return [Math.asin(u[2]) / DEG, Math.atan2(u[1], u[0]) / DEG];
}

function angle(a: readonly number[], b: readonly number[]): number {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}
