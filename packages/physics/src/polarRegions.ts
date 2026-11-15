import { MOON_RADIUS_M, polarToUnit, polarXY } from './dem';
import { MOON_RADIUS_KM, siteFrame } from './frames';
import type { Vec3 } from './vec';

/**
 * Areas outlined as polygons in LOLA's south polar stereographic plane: metres, on the 1737.4 km sphere, centred on the
 * south pole, with x = ρ sin λ and y = ρ cos λ (the projection of `polarXY`). Polar shapefiles come in it, such as
 * Lemelin et al. 2021's water-ice-bearing permanently shadowed regions, and a GeoJSON converted from one keeps its
 * coordinates but names no CRS, so this reader assumes that plane.
 */
export interface PolarRegion {
  /** Every ring, outlines and holes alike, as plane metres x0, y0, x1, y1, … */
  rings: Float64Array[];
  /** The same vertices as unit vectors in the Moon's body-fixed frame, x0, y0, z0, … */
  unitRings: Float64Array[];
  /** The plane box that holds every vertex, metres. */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  /** The farthest any vertex lies from the pole in the plane, metres. */
  maxRhoM: number;
}

/** The region nearest a site, and how far away it is. */
export interface NearestRegion {
  /** The region's place in the list it came from. */
  index: number;
  /** Straight over the sphere to the region's outline, km; 0 when the site lies inside it. */
  distanceKm: number;
  inside: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function ringOf(raw: unknown, where: string): Float64Array {
  // GeoJSON closes each ring by repeating its first position, so a triangle takes four.
  if (!Array.isArray(raw) || raw.length < 4) throw new Error(`${where}: a ring needs at least four positions`);
  const xy = new Float64Array(raw.length * 2);
  raw.forEach((p: unknown, i) => {
    if (!Array.isArray(p) || !isNumber(p[0]) || !isNumber(p[1]))
      throw new Error(`${where}: position ${i} is not a pair of numbers`);
    xy[2 * i] = p[0];
    xy[2 * i + 1] = p[1];
  });
  return xy;
}

function regionOf(rings: Float64Array[]): PolarRegion {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let maxRhoM = 0;
  const unitRings = rings.map((xy) => {
    const unit = new Float64Array((xy.length / 2) * 3);
    for (let i = 0; i < xy.length / 2; i++) {
      const x = xy[2 * i];
      const y = xy[2 * i + 1];
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
      maxRhoM = Math.max(maxRhoM, Math.hypot(x, y));
      unit.set(polarToUnit(x, y), 3 * i);
    }
    return unit;
  });
  return { rings, unitRings, box, maxRhoM };
}

/**
 * The polygons of a GeoJSON FeatureCollection whose coordinates are metres in the south polar stereographic plane above
 * (Polygon or MultiPolygon features, holes kept), in the file's order. Refuses a file that names a CRS, since it would
 * be one this reader does not check.
 */
export function polarRegionsFromGeoJson(json: unknown): PolarRegion[] {
  if (!isObject(json) || json.type !== 'FeatureCollection' || !Array.isArray(json.features))
    throw new Error('not a GeoJSON FeatureCollection');
  if ('crs' in json) throw new Error('the file names a CRS; only the unnamed south polar stereographic plane is read');
  return json.features.map((feature: unknown, i) => {
    const geometry = isObject(feature) && isObject(feature.geometry) ? feature.geometry : undefined;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : undefined;
    if (!Array.isArray(polygons) || polygons.length === 0)
      throw new Error(`feature ${i}: not a Polygon or MultiPolygon`);
    const rings = polygons.flatMap((polygon: unknown, k) => {
      if (!Array.isArray(polygon) || polygon.length === 0) throw new Error(`feature ${i}, polygon ${k}: no rings`);
      return polygon.map((ring: unknown, j) => ringOf(ring, `feature ${i}, polygon ${k}, ring ${j}`));
    });
    return regionOf(rings);
  });
}

/** Even-odd rule over every ring, so a point in a hole is outside. Exact in the plane, which maps one-to-one. */
function insideRegion(region: PolarRegion, x: number, y: number): boolean {
  const { box } = region;
  if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) return false;
  let inside = false;
  for (const ring of region.rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i];
      const yi = ring[2 * i + 1];
      const xj = ring[2 * j];
      const yj = ring[2 * j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The angle between two unit vectors, radians, accurate however small. */
function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.hypot(cx, cy, cz), ax * bx + ay * by + az * bz);
}

/**
 * From a site to the great-circle arc between two vertices, radians: across to the arc where the foot of the
 * perpendicular falls on it, otherwise to the nearer end.
 */
function arcDistance(s: Vec3, a: Float64Array, i: number, j: number): number {
  const [sx, sy, sz] = s;
  const ax = a[i];
  const ay = a[i + 1];
  const az = a[i + 2];
  const bx = a[j];
  const by = a[j + 1];
  const bz = a[j + 2];
  let best = Math.min(angleBetween(sx, sy, sz, ax, ay, az), angleBetween(sx, sy, sz, bx, by, bz));
  // The arc's pole, n = a × b.
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen > 0) {
    const side = (sx * nx + sy * ny + sz * nz) / nLen;
    // The foot: the site with its component along the pole removed.
    const fx = sx - (side * nx) / nLen;
    const fy = sy - (side * ny) / nLen;
    const fz = sz - (side * nz) / nLen;
    // On the arc when a, foot and b turn the same way about n: (a × foot)·n ≥ 0 and (foot × b)·n ≥ 0.
    const afn = (ay * fz - az * fy) * nx + (az * fx - ax * fz) * ny + (ax * fy - ay * fx) * nz;
    const fbn = (fy * bz - fz * by) * nx + (fz * bx - fx * bz) * ny + (fx * by - fy * bx) * nz;
    if (afn >= 0 && fbn >= 0) best = Math.min(best, Math.asin(Math.min(1, Math.abs(side))));
  }
  return best;
}

/** From a site to the nearest point of a region's rings, radians. */
function regionDistance(region: PolarRegion, s: Vec3): number {
  let best = Infinity;
  for (const unit of region.unitRings) {
    const n = unit.length / 3;
    for (let i = 0; i < n; i++) best = Math.min(best, arcDistance(s, unit, 3 * i, 3 * ((i + 1) % n)));
  }
  return best;
}

/**
 * The least the distance over the sphere to a region can be, radians, from the plane distance to its box. Stereographic
 * scale is k = 1 + (ρ / 2R)², at least 1, so a path on the sphere is never longer in the plane than k times itself; and
 * the arc from the site to any point of the region stays inside the polar cap that holds both, as long as that cap is
 * smaller than a hemisphere. Outside that case it gives 0, which prunes nothing.
 */
function lowerBound(region: PolarRegion, x: number, y: number, siteRhoM: number): number {
  const rhoM = Math.max(siteRhoM, region.maxRhoM);
  if (rhoM >= 2 * MOON_RADIUS_M) return 0;
  const k = 1 + (rhoM / (2 * MOON_RADIUS_M)) ** 2;
  const dx = Math.max(region.box.minX - x, 0, x - region.box.maxX);
  const dy = Math.max(region.box.minY - y, 0, y - region.box.maxY);
  // A metre's slack: the arc between two vertices bows a hair away from the straight edge the box was drawn around.
  return Math.max(0, Math.hypot(dx, dy) / k - 1) / MOON_RADIUS_M;
}

/**
 * The region nearest a site, measured straight over the 1737.4 km sphere to its outline, 0 inside it. Undefined for no
 * regions or a site that is not a number.
 */
export function nearestPolarRegion(
  regions: readonly PolarRegion[],
  latDeg: number,
  lonDeg: number,
): NearestRegion | undefined {
  if (regions.length === 0 || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return undefined;
  const s = siteFrame(latDeg, lonDeg).u;
  const { x, y } = polarXY(s);
  for (let i = 0; i < regions.length; i++) {
    if (insideRegion(regions[i], x, y)) return { index: i, distanceKm: 0, inside: true };
  }
  const siteRhoM = Math.hypot(x, y);
  const order = regions
    .map((region, index) => ({ index, bound: lowerBound(region, x, y, siteRhoM) }))
    .sort((a, b) => a.bound - b.bound);
  let best = Infinity;
  let index = order[0].index;
  for (const candidate of order) {
    if (candidate.bound >= best) break;
    const d = regionDistance(regions[candidate.index], s);
    if (d < best) {
      best = d;
      index = candidate.index;
    }
  }
  return { index, distanceKm: best * MOON_RADIUS_KM, inside: false };
}
