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
  polarScaleFactor,
  polarXY,
  type SolarBodyKey,
  siteFrame,
  siteSlopes,
  stayTest,
  subsolarPoint,
  WALK_RADIUS_M,
} from '@siteline/physics';
import * as Comlink from 'comlink';
import type { GeoTIFFImage } from 'geotiff';
import { type DayStrip, dayStrip } from './dayStrip';

const EPHEMERIS_SOURCES = ['spice-de440s', 'spice-moon-pa', 'spice-moon-fk', 'spice-naif0012'];
// From the file's own description: LOLA LDEM_75S_240M crop, 700 × 700 int16, 0.5 m per unit, 1200 m per pixel.
const TERRAIN = { id: 'lola-ldem-75s-240m', n: 700, pixM: 1200, metresPerUnit: 0.5 };
// From the file's own description: 186 × 186 at 2.4 km, long-term sunlight and Earth view, never-sunlit flag.
const MAPS = { id: 'landfall-polar-maps', n: 186, pixM: 2400 };
/** LOLA's 10 m terrain of the south pole inside 83°S (PGDA product 90), read only around the sites asked about. */
const FINE = { id: 'lola-spole-10m' };

export interface DataUrls {
  data: string;
  terrain: string;
  maps: string;
  /** LOLA's 10 m south pole terrain, a cloud-optimised GeoTIFF read by byte ranges; without it the slope is unknown. */
  fine?: string;
}

/** The slopes around a site, measured on the 10 m terrain. */
export interface SlopeInfo {
  id: string;
  resolutionM: number;
  slope100mDeg: number;
  slope2kmPctUnder20: number;
}

export interface TerrainInfo {
  id: string;
  resolutionM: number;
  groundHeightM: number;
}

export interface LongTerm {
  id: string;
  /** The grid the maps were computed on. */
  resolutionM: number;
  sunPct: number;
  earthPct: number;
  shadowed?: boolean;
}

export interface StayResponse {
  result: StayResult;
  terrain?: TerrainInfo;
  terrainError?: string;
  /** The slopes, when the site is on the 10 m terrain and its tiles arrived in time. */
  slope?: SlopeInfo;
  /** True when the slope's tiles were still on their way: asking again with more patience will bring the slope. */
  slopePending?: boolean;
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

/** The 10 m grid, opened once: its header and tile index only, never the whole 5 GB file. */
interface FineGrid {
  image: GeoTIFFImage;
  /** The plane coordinates of the grid's outer top-left corner, in metres. */
  cornerX: number;
  cornerY: number;
  pixM: number;
  width: number;
  height: number;
}

const loadFine = (url: string): Promise<FineGrid> =>
  memo(`fine:${url}`, async () => {
    const { fromUrl } = await import('geotiff');
    const image = await (await fromUrl(url)).getImage();
    const [x, y] = image.getOrigin();
    const [pixM, pixY] = image.getResolution();
    if (!(pixM > 0) || Math.abs(pixM + pixY) > 1e-9) throw new Error(`${url}: not a grid of square cells`);
    // The tie point is the first cell's outer corner, or its centre for a grid of points.
    const half = image.getGeoKeys()?.GTRasterTypeGeoKey === 2 ? pixM / 2 : 0;
    return { image, cornerX: x - half, cornerY: y + half, pixM, width: image.getWidth(), height: image.getHeight() };
  });

/**
 * The landing slope and the walkable share around a site, from the 10 m grid: only the cells within 1 km are read (one
 * to four of its tiles). Undefined off the grid, or where it has no data at the site.
 */
const slopeAt = (latDeg: number, lonDeg: number, url: string): Promise<SlopeInfo | undefined> =>
  memo(`slope:${url}:${latDeg},${lonDeg}`, async () => {
    const grid = await loadFine(url);
    const { x, y } = polarXY(siteFrame(latDeg, lonDeg).u);
    // The site in cells from the centre of the grid's first cell; rows run towards −y.
    const col = (x - grid.cornerX) / grid.pixM - 0.5;
    const row = (grid.cornerY - y) / grid.pixM - 0.5;
    const half = Math.ceil((WALK_RADIUS_M * polarScaleFactor(latDeg)) / grid.pixM) + 1;
    const n = 2 * half + 1;
    const c0 = Math.round(col) - half;
    const r0 = Math.round(row) - half;
    if (c0 < 0 || r0 < 0 || c0 + n > grid.width || r0 + n > grid.height) return undefined;
    const heightsM = await grid.image.readRasters({
      window: [c0, r0, c0 + n, r0 + n],
      samples: [0],
      interleave: true,
    });
    const s = siteSlopes({ heightsM, n, pixM: grid.pixM, col: col - c0, row: row - r0 }, latDeg);
    return Number.isFinite(s.slope100mDeg) ? { id: FINE.id, resolutionM: grid.pixM, ...s } : undefined;
  });

/** `p`, or undefined if it has not settled within `ms`. */
const within = <T>(p: Promise<T | undefined>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);

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

  /** The first and last moments the planets table covers; `planetsAt` holds still outside them. */
  async planetsSpan(dataUrl: string): Promise<{ startUtcMs: number; endUtcMs: number }> {
    const table = await loadPlanets(dataUrl);
    return { startUtcMs: table.startUtcMs, endUtcMs: table.endUtcMs };
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

  /**
   * The stay check. The slope's tiles load alongside everything else, and once the rest is worked out the check waits
   * up to `slopeWaitMs` more for them; if they are still on their way it answers without the slope and says so
   * (`slopePending`), and the same question asked again later finds them read.
   */
  async stay(query: StayQuery, urls: DataUrls, slopeWaitMs = 0): Promise<StayResponse> {
    const { latDeg, lonDeg } = query.site;
    // Set once the slope's read has finished, either way.
    let slopeDone: { value: SlopeInfo | undefined } | undefined = urls.fine ? undefined : { value: undefined };
    const slopeRun = urls.fine
      ? quiet(slopeAt(latDeg, lonDeg, urls.fine), (m) => console.warn(`slope: ${m}`)).then((value) => {
          slopeDone = { value };
          return value;
        })
      : Promise.resolve(undefined);
    const ephemeris = await loadEphemeris(urls.data);
    let terrainError: string | undefined;
    const dem = await quiet(loadDem(urls.terrain), (m) => {
      terrainError = m;
    });
    const maps = await quiet(loadMaps(urls.maps), () => {});
    const hz = dem && horizonFor(dem, query.site.latDeg, query.site.lonDeg, query.observerHeightM);
    // The 1.2 km grid cannot resolve the 100 m landing-slope rule; the 10 m one can, where it reaches (inside 83°S).
    const raced = await within(slopeRun, slopeWaitMs);
    const slope = slopeDone ? slopeDone.value : raced;
    const result = stayTest(hz ? { ...query, site: { ...query.site, heightM: hz.groundHeightM } } : query, {
      ephemeris,
      horizon: hz?.mask ?? flatHorizon(),
      slope100mDeg: slope?.slope100mDeg ?? Number.NaN,
      slope2kmPctUnder20: slope?.slope2kmPctUnder20 ?? Number.NaN,
      sources: [...EPHEMERIS_SOURCES, ...(hz ? [TERRAIN.id] : []), ...(slope ? [slope.id] : [])],
    });
    const terrain = hz && { id: TERRAIN.id, resolutionM: TERRAIN.pixM, groundHeightM: hz.groundHeightM };
    const at = maps && mapsAtSite(maps, query.site.latDeg, query.site.lonDeg);
    const longTerm = at && Number.isFinite(at.sunPct) ? { id: MAPS.id, resolutionM: MAPS.pixM, ...at } : undefined;
    const { tUtcMs, sun, earth } = result.series;
    const slopePending = slopeDone === undefined;
    return Comlink.transfer({ result, terrain, terrainError, longTerm, slope, slopePending }, [
      tUtcMs.buffer,
      sun.buffer,
      earth.buffer,
    ]);
  },

  /** Day by day across the whole ephemeris, how much of each day this spot has the Sun and the Earth. */
  async dayStrip(query: StayQuery, urls: DataUrls): Promise<DayStrip & { sources: string[] }> {
    const ephemeris = await loadEphemeris(urls.data);
    const dem = await quiet(loadDem(urls.terrain), () => {});
    const hz = dem && horizonFor(dem, query.site.latDeg, query.site.lonDeg, query.observerHeightM);
    const site = hz ? { ...query.site, heightM: hz.groundHeightM } : query.site;
    const strip = dayStrip(ephemeris, hz?.mask ?? flatHorizon(), { ...query, site });
    const sources = hz ? [...EPHEMERIS_SOURCES, TERRAIN.id] : EPHEMERIS_SOURCES;
    return Comlink.transfer({ ...strip, sources }, [strip.sun.buffer, strip.earth.buffer]);
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
