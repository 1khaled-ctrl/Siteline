import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cross,
  dot,
  MOON_RADIUS_KM,
  nearestPolarRegion,
  norm,
  polarRegionsFromGeoJson,
  polarToUnit,
  siteFrame,
  type Vec3,
} from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import regionsFile from '../../../data/regions.json';
import { ICE_OUTLINE } from './verdict';

/**
 * Lemelin et al. 2021's ice-bearing regions as the bucket holds them (CREDITS.md `lemelin-2021-ice-psrs`), fetched into
 * the pipeline's raw folder, which git ignores; without it these tests skip.
 */
const path = fileURLToPath(new URL('../../../pipeline/raw/ice/psr-volatiles-lemelin2021.geojson', import.meta.url));

interface Feature {
  properties: { Name: string | null; Latitude: number; Longitude: number; Area_m2: number };
  geometry: { coordinates: number[][][] };
}

describe.skipIf(!existsSync(path))("Lemelin et al. 2021's ice-bearing regions, as published", () => {
  const json = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { type: 'FeatureCollection', features: [] };
  const features: Feature[] = json.features;
  const regions = polarRegionsFromGeoJson(json);

  it('lies thousands of km from a northern site, so the report must not offer it as the nearest ice there', () => {
    // Apollo 11 (data/missions.json): the file covers the south polar region only, which is why the report shows this
    // reading only beside the permanent-shadow one (iceDetectedLineOf).
    const apollo11 = nearestPolarRegion(regions, 0.6741, 23.473);
    expect(apollo11?.inside).toBe(false);
    expect(apollo11?.distanceKm).toBeCloseTo(2345.4, 1);
  });

  it('reads all 169 regions in the south polar stereographic plane', () => {
    expect(regions).toHaveLength(169);
  });

  it("puts each region's own listed centre inside its outline, all but Wiechert J's, which the source lists elsewhere", () => {
    // A check that the plane is read the right way round: a wrong projection would put the centres anywhere.
    const outside = features.filter(
      (f, i) => !nearestPolarRegion([regions[i]], f.properties.Latitude, f.properties.Longitude)?.inside,
    );
    expect(outside.map((f) => f.properties.Name)).toEqual(['Wiechert J']);
  });

  it('outlines every region one M3 pixel beyond its shadow, the figure the ice line shows', () => {
    // A shadow of area A0 grown by d has area A0 + P d − π d² for its new perimeter P, so d follows from the outline
    // and the shadow's own area (`Area_m2`). Exact for a region without holes; holes shrink, so those fit less tightly.
    for (const f of features) {
      let area = 0;
      let perimeter = 0;
      f.geometry.coordinates.forEach((ring, k) => {
        let a = 0;
        for (let i = 1; i < ring.length; i++) {
          const [x0, y0] = ring[i - 1];
          const [x1, y1] = ring[i];
          a += (x0 * y1 - x1 * y0) / 2;
          perimeter += Math.hypot(x1 - x0, y1 - y0);
        }
        area += k === 0 ? Math.abs(a) : -Math.abs(a);
      });
      const grown = area - f.properties.Area_m2;
      const d = (perimeter - Math.sqrt(perimeter ** 2 - 4 * Math.PI * grown)) / (2 * Math.PI);
      const tolerance = f.geometry.coordinates.length === 1 ? 1 : 5;
      expect(Math.abs(d - ICE_OUTLINE.beyondShadowM), f.properties.Name ?? 'unnamed').toBeLessThan(tolerance);
    }
  });

  it("agrees at the nine Artemis regions' centres with the nearest of all 33,000 outline vertices", () => {
    // The vertex nearest a site is at most half an edge farther than the outline itself.
    let longestEdgeM = 0;
    const vertices: Vec3[] = [];
    for (const f of features)
      for (const ring of f.geometry.coordinates)
        ring.forEach(([x, y], i) => {
          vertices.push(polarToUnit(x, y));
          if (i > 0) longestEdgeM = Math.max(longestEdgeM, Math.hypot(x - ring[i - 1][0], y - ring[i - 1][1]));
        });
    for (const r of regionsFile.regions) {
      const s = siteFrame(r.lat, r.lon).u;
      const bruteKm = Math.min(...vertices.map((v) => angleBetween(s, v))) * MOON_RADIUS_KM;
      const near = nearestPolarRegion(regions, r.lat, r.lon);
      expect(near, r.name).toBeDefined();
      const km = near?.distanceKm ?? Number.NaN;
      expect(km, r.name).toBeLessThanOrEqual(bruteKm + 1e-9);
      expect(bruteKm - km, r.name).toBeLessThan(longestEdgeM / 2000);
    }
  });
});

function angleBetween(a: Vec3, b: Vec3): number {
  return Math.atan2(norm(cross(a, b)), dot(a, b));
}
