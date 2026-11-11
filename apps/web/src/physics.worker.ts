import type { StayQuery, StayResult } from '@siteline/contracts';
import {
  type BestSearch,
  type BestSpot,
  bestSpots,
  type Dem,
  type DemHorizon,
  demFromInt16,
  type EphemerisTable,
  flatHorizon,
  horizonFromDem,
  mapsAtSite,
  mapsFromBytes,
  marsSubsolarPoint,
  PLANET_NAMES,
  type PlanetName,
  type PlanetTable,
  type PolarMaps,
  parseEphemeris,
  parsePlanets,
  type SolarBodyKey,
  stayTest,
  subsolarPoint,
} from '@siteline/physics';
import * as Comlink from 'comlink';

const EPHEMERIS_SOURCES = ['spice-de440s', 'spice-moon-pa', 'spice-moon-fk', 'spice-naif0012'];
// From the file's own description: LOLA LDEM_75S_240M crop, 700 × 700 int16, 0.5 m per unit, 1200 m per pixel.
const TERRAIN = { id: 'lola-ldem-75s-240m', n: 700, pixM: 1200, metresPerUnit: 0.5 };
// From the file's own description: 186 × 186 at 2.4 km, long-term sunlight and Earth view, never-sunlit flag.
const MAPS = { id: 'landfall-polar-maps', n: 186, pixM: 2400 };

export interface DataUrls {
  data: string;
  terrain: string;
  maps: string;
}

export interface TerrainInfo {
  id: string;
  resolutionM: number;
  groundHeightM: number;
}

export interface LongTerm {
  id: string;
  sunPct: number;
  earthPct: number;
  shadowed?: boolean;
}

export interface StayResponse {
  result: StayResult;
  terrain?: TerrainInfo;
  terrainError?: string;
  longTerm?: LongTerm;
}

interface Base64File {
  bytes: number;
  sha256: string;
  b64: string;
}

const cache = new Map<string, Promise<unknown>>();
function memo<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function fetchChecked(url: string): Promise<Uint8Array> {
  const file = (await (await fetchOk(url)).json()) as Base64File;
  const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  if (bytes.length !== file.bytes || hex !== file.sha256) throw new Error(`${url} failed its checksum`);
  return bytes;
}

const loadEphemeris = (base: string): Promise<EphemerisTable> =>
  memo(`ephemeris:${base}`, async () =>
    parseEphemeris(await (await fetchOk(`${base}/ephemeris/moon_sun_earth.bin`)).arrayBuffer()),
  );

const loadPlanets = (base: string): Promise<PlanetTable> =>
  memo(`planets:${base}`, async () =>
    parsePlanets(await (await fetchOk(`${base}/ephemeris/planets.bin`)).arrayBuffer()),
  );

const loadDem = (url: string): Promise<Dem> =>
  memo(`dem:${url}`, async () => {
    const bytes = await fetchChecked(url);
    return demFromInt16(new Int16Array(bytes.buffer), TERRAIN.n, TERRAIN.pixM, TERRAIN.metresPerUnit);
  });

const loadMaps = (url: string): Promise<PolarMaps> =>
  memo(`maps:${url}`, async () => mapsFromBytes(await fetchChecked(url), MAPS.n, MAPS.pixM));

const horizons = new Map<string, DemHorizon | undefined>();
function horizonFor(dem: Dem, latDeg: number, lonDeg: number, observerHeightM: number): DemHorizon | undefined {
  const key = `${latDeg},${lonDeg},${observerHeightM}`;
  if (!horizons.has(key)) {
    if (horizons.size > 64) horizons.clear();
    horizons.set(key, horizonFromDem(dem, latDeg, lonDeg, { observerHeightM }));
  }
  return horizons.get(key);
}

const quiet = <T>(p: Promise<T>, onError: (message: string) => void): Promise<T | undefined> =>
  p.catch((e: unknown) => {
    onError(e instanceof Error ? e.message : String(e));
    return undefined;
  });

const api = {
  /** The terrain grid for drawing; a copy crosses to the main thread. */
  dem(url: string): Promise<Dem> {
    return loadDem(url);
  },

  maps(url: string): Promise<PolarMaps> {
    return loadMaps(url);
  },

  /** Sun position relative to the Moon's centre (km, MOON_ME), clamped to the table's range. */
  async sunKm(tUtcMs: number, dataUrl: string): Promise<readonly [number, number, number]> {
    const table = await loadEphemeris(dataUrl);
    return table.positionKm('sun', Math.min(table.endUtcMs, Math.max(table.startUtcMs, tUtcMs)));
  },

  /** One full orbit per planet, in km, for drawing the solar-system overview. */
  async planetOrbits(dataUrl: string): Promise<Record<PlanetName, Float32Array>> {
    const table = await loadPlanets(dataUrl);
    return Object.fromEntries(PLANET_NAMES.map((p) => [p, table.orbitKm(p)])) as Record<PlanetName, Float32Array>;
  },

  /** Planet positions from the Sun and the Moon's from the Earth (km, ECLIPJ2000), clamped to the table. */
  async planetsAt(tUtcMs: number, dataUrl: string): Promise<Record<SolarBodyKey, readonly [number, number, number]>> {
    const table = await loadPlanets(dataUrl);
    return table.snapshot(Math.min(table.endUtcMs, Math.max(table.startUtcMs, tUtcMs)));
  },

  /** Where the Sun is overhead on Earth (degrees, east-positive), from the planets table. */
  async earthSun(tUtcMs: number, dataUrl: string): Promise<{ latDeg: number; lonDeg: number }> {
    const table = await loadPlanets(dataUrl);
    const t = Math.min(table.endUtcMs, Math.max(table.startUtcMs, tUtcMs));
    const [x, y, z] = table.positionKm('earth', t);
    // The table holds the Earth as seen from the Sun; the Sun seen from the Earth is the opposite direction.
    return subsolarPoint([-x, -y, -z], t);
  },

  /** Where the Sun is overhead on Mars (degrees, east-positive), from the planets table. */
  async marsSun(tUtcMs: number, dataUrl: string): Promise<{ latDeg: number; lonDeg: number }> {
    const table = await loadPlanets(dataUrl);
    const t = Math.min(table.endUtcMs, Math.max(table.startUtcMs, tUtcMs));
    const [x, y, z] = table.positionKm('mars', t);
    return marsSubsolarPoint([-x, -y, -z], t);
  },

  async stay(query: StayQuery, urls: DataUrls): Promise<StayResponse> {
    const ephemeris = await loadEphemeris(urls.data);
    let terrainError: string | undefined;
    const dem = await quiet(loadDem(urls.terrain), (m) => {
      terrainError = m;
    });
    const maps = await quiet(loadMaps(urls.maps), () => {});
    const hz = dem && horizonFor(dem, query.site.latDeg, query.site.lonDeg, query.observerHeightM);
    const result = stayTest(hz ? { ...query, site: { ...query.site, heightM: hz.groundHeightM } } : query, {
      ephemeris,
      horizon: hz?.mask ?? flatHorizon(),
      // A 1.2 km grid cannot resolve the 100 m landing-slope rule.
      slope100mDeg: Number.NaN,
      slope2kmPctUnder20: Number.NaN,
      sources: hz ? [...EPHEMERIS_SOURCES, TERRAIN.id] : EPHEMERIS_SOURCES,
    });
    const terrain = hz && { id: TERRAIN.id, resolutionM: TERRAIN.pixM, groundHeightM: hz.groundHeightM };
    const at = maps && mapsAtSite(maps, query.site.latDeg, query.site.lonDeg);
    const longTerm = at && Number.isFinite(at.sunPct) ? { id: MAPS.id, ...at } : undefined;
    const { tUtcMs, sun, earth } = result.series;
    return Comlink.transfer({ result, terrain, terrainError, longTerm }, [tUtcMs.buffer, sun.buffer, earth.buffer]);
  },

  /** Rank spots inside a region; the timelines are left out to keep the reply small. */
  async best(search: BestSearch, query: Omit<StayQuery, 'site'>, urls: DataUrls): Promise<BestSpot[]> {
    const [ephemeris, dem] = await Promise.all([loadEphemeris(urls.data), loadDem(urls.terrain)]);
    return bestSpots(search, query, dem, ephemeris, {
      sources: [...EPHEMERIS_SOURCES, TERRAIN.id],
      stepMinutes: 60,
    });
  },
};

export type PhysicsApi = typeof api;
Comlink.expose(api);
