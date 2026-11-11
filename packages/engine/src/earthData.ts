// Natural Earth data as the concept demo packed it. Lines are base64 of little-endian int16 pairs, longitude and
// latitude in hundredths of a degree, with longitude 327.67 as "lift the pen".

const DEG = Math.PI / 180;
const PEN_UP = 32767;
/** IUGG mean radius. The map is a sphere, so distances on it are great-circle on a sphere. */
export const EARTH_MEAN_RADIUS_KM = 6371.0088;

export interface EarthCountry {
  id: number;
  name: string;
  nameAr: string;
  latDeg: number;
  lonDeg: number;
  /** Polygon area as the dataset gives it; used to size the fly-to, not shown. */
  areaKm2: number;
  /** 1 for the biggest country; labels of higher rank show only when zoomed in. */
  rank: number;
}

export interface EarthCity {
  name: string;
  nameAr: string;
  latDeg: number;
  lonDeg: number;
  population: number;
  /** The zoom level at which the dataset starts to show it; 1 is the biggest places. */
  zoomLevel: number;
  /** 2 for a national capital. */
  capital: number;
  country: string;
}

/** An RGBA raster in which a pixel's red and green hold a country id (red + 256 green) and blue is 255 on land. */
export interface EarthIds {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface EarthCountriesJson {
  source: string;
  borders: string;
  coast: string;
  labels: { i: number; n: string; ar?: string; lon: number; lat: number; a: number; r: number }[];
}

export interface EarthDetailJson {
  prov: string;
  roads: string;
  rivers: string;
  lakes: string;
  coast: string;
  cities: [string, string, number, number, number, number, number, string][];
}

/** Longitude and latitude to a point on the unit sphere in scene axes: +Y north, 0° longitude along +X, east toward −Z. */
export function lonLatToScene(latDeg: number, lonDeg: number): [number, number, number] {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
}

export function sceneToLonLat(x: number, y: number, z: number): { latDeg: number; lonDeg: number } {
  return { latDeg: Math.asin(y / Math.hypot(x, y, z)) / DEG, lonDeg: Math.atan2(-z, x) / DEG };
}

/** Longitude, latitude pairs in degrees; a pen lift becomes NaN, NaN. Assumes a little-endian host, as every browser is. */
export function decodeLines(b64: string): Float32Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const packed = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(packed.length);
  for (let i = 0; i < packed.length; i += 2) {
    const lift = packed[i] === PEN_UP;
    out[i] = lift ? Number.NaN : packed[i] / 100;
    out[i + 1] = lift ? Number.NaN : packed[i + 1] / 100;
  }
  return out;
}

/** Line segments on the unit sphere as pairs of xyz points. A jump across the antimeridian is not drawn. */
export function lineSegments(b64: string): Float32Array {
  const ll = decodeLines(b64);
  const out = new Float32Array(ll.length * 3);
  let n = 0;
  let prev: [number, number, number] | undefined;
  let prevLon = 0;
  for (let i = 0; i < ll.length; i += 2) {
    const lon = ll[i];
    if (Number.isNaN(lon)) {
      prev = undefined;
      continue;
    }
    const p = lonLatToScene(ll[i + 1], lon);
    if (prev && Math.abs(lon - prevLon) < 180) {
      out.set(prev, n);
      out.set(p, n + 3);
      n += 6;
    }
    prev = p;
    prevLon = lon;
  }
  return out.slice(0, n);
}

export function parseCountries(json: EarthCountriesJson): EarthCountry[] {
  return json.labels.map((l) => ({
    id: l.i,
    name: l.n,
    nameAr: l.ar ?? l.n,
    latDeg: l.lat,
    lonDeg: l.lon,
    areaKm2: l.a,
    rank: l.r,
  }));
}

/** Cities from the biggest zoom level down, the order they appear in as you zoom in. */
export function parseCities(rows: EarthDetailJson['cities']): EarthCity[] {
  return rows
    .map(([name, nameAr, latDeg, lonDeg, population, zoomLevel, capital, country]) => ({
      name,
      nameAr,
      latDeg,
      lonDeg,
      population,
      zoomLevel,
      capital,
      country,
    }))
    .sort((a, b) => a.zoomLevel - b.zoomLevel || b.population - a.population);
}

export function countryAt(
  ids: EarthIds,
  byId: ReadonlyMap<number, EarthCountry>,
  latDeg: number,
  lonDeg: number,
): EarthCountry | undefined {
  const x = Math.min(ids.width - 1, Math.max(0, Math.floor(((lonDeg + 180) / 360) * ids.width)));
  const y = Math.min(ids.height - 1, Math.max(0, Math.floor(((90 - latDeg) / 180) * ids.height)));
  const k = (y * ids.width + x) * 4;
  if (ids.data[k + 2] < 128) return undefined;
  return byId.get(ids.data[k] + ids.data[k + 1] * 256);
}

export function greatCircleKm(
  latADeg: number,
  lonADeg: number,
  latBDeg: number,
  lonBDeg: number,
  radiusKm = EARTH_MEAN_RADIUS_KM,
): number {
  const dLat = (latBDeg - latADeg) * DEG;
  const dLon = (lonBDeg - lonADeg) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(latADeg * DEG) * Math.cos(latBDeg * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearestCity(
  cities: readonly EarthCity[],
  latDeg: number,
  lonDeg: number,
  maxKm: number,
): { city: EarthCity; distKm: number } | undefined {
  let best: { city: EarthCity; distKm: number } | undefined;
  for (const city of cities) {
    // Cheap rejection before the trigonometry: one degree of latitude is 111 km.
    if (Math.abs(city.latDeg - latDeg) * 111 > maxKm) continue;
    const distKm = greatCircleKm(latDeg, lonDeg, city.latDeg, city.lonDeg);
    if (distKm <= maxKm && (!best || distKm < best.distKm)) best = { city, distKm };
  }
  return best;
}
