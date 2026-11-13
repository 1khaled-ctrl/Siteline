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
  type HeightPatch,
  type HeightSource,
  heightsFromPatches,
  horizonFromDem,
  horizonFromHeights,
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
/**
 * The small 1.2 km grid the south-pole view is drawn from (the Landfall demo's LOLA crop: 700 × 700 int16, 0.5 m a
 * unit). It shapes the model on screen and nothing else; what a site is judged by is `TERRAIN` below.
 */
const DRAWN = { id: 'lola-ldem-75s-240m', n: 700, pixM: 1200, metresPerUnit: 0.5 };
/**
 * LOLA's 30 m south pole terrain (PGDA product 90), the skyline every stay check is judged against. It is a tiled
 * GeoTIFF with overviews, read by byte ranges: never the whole 2.8 GB file.
 *
 * The horizon walk reaches 300 km, which at 30 m would be a 20,000 × 20,000 window, so each site is read as two
 * windows: the cells within `NEAR_RADIUS_M` at full 30 m, and the whole reach from an overview about 20 times
 * coarser. A ridge 300 km away is a few pixels of skyline whatever it was sampled at, while the ground near the site
 * is what actually sets its horizon. `TerrainInfo.resolutionM` reports the near-site figure, the one the site is
 * judged by; CREDITS.md carries the caveat that the far skyline is coarser.
 */
const TERRAIN = { id: 'lola-ldem-75s-30m' };
/** How far around a site the terrain is read at its full resolution. */
const NEAR_RADIUS_M = 6_000;
/** The coarsest cell the far skyline may be read at; the file's overviews pick the nearest level at or under it. */
const FAR_PIX_M = 1_000;
/** How far the skyline is looked for, the same reach the horizon walk has always used. */
const HORIZON_REACH_M = 300_000;
// From the file's own description: 186 × 186 at 2.4 km, long-term sunlight and Earth view, never-sunlit flag.
const MAPS = { id: 'landfall-polar-maps', n: 186, pixM: 2400 };
/** LOLA's 10 m terrain of the south pole inside 83°S (PGDA product 90), read only around the sites asked about. */
const FINE = { id: 'lola-spole-10m' };

export interface DataUrls {
  data: string;
  terrain: string;
  maps: string;
  /**
   * LOLA's 30 m south pole terrain, a tiled GeoTIFF with overviews read by byte ranges. Where it is named, the stay
   * check's skyline comes from it; where it is not, from the small 1.2 km grid `terrain` names (see physics.ts).
   */
  horizonTerrain?: string;
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

/** The grid the south-pole view is drawn from, as a whole small array. */
const loadDrawnDem = (url: string): Promise<Dem> =>
  memo(`drawn:${url}`, async () => {
    const bytes = await fetchChecked(url);
    return demFromInt16(new Int16Array(bytes.buffer), DRAWN.n, DRAWN.pixM, DRAWN.metresPerUnit);
  });

/** One level of a terrain GeoTIFF: its image, where its grid starts, and how big its cells are. */
interface TerrainLevel {
  image: GeoTIFFImage;
  cornerX: number;
  cornerY: number;
  pixM: number;
  width: number;
  height: number;
}

/** The terrain's full-resolution level and the coarse overview the far skyline is read from. */
interface TerrainGrids {
  near: TerrainLevel;
  far: TerrainLevel;
}

const levelOf = (image: GeoTIFFImage, base: GeoTIFFImage): TerrainLevel => {
  // An overview carries no geotransform of its own; it is placed by the full-resolution image's.
  const [x, y] = base.getOrigin();
  const [basePix, basePixY] = base.getResolution();
  if (!(basePix > 0) || Math.abs(basePix + basePixY) > 1e-9)
    throw new Error('the terrain is not a grid of square cells');
  const pixM = (basePix * base.getWidth()) / image.getWidth();
  const half = base.getGeoKeys()?.GTRasterTypeGeoKey === 2 ? pixM / 2 : 0;
  return { image, cornerX: x - half, cornerY: y + half, pixM, width: image.getWidth(), height: image.getHeight() };
};

/** The terrain's levels, opened once: headers and tile indexes only, never the whole file. */
const loadTerrain = (url: string): Promise<TerrainGrids> =>
  memo(`terrain:${url}`, async () => {
    const { fromUrl } = await import('geotiff');
    const tiff = await fromUrl(url);
    const base = await tiff.getImage();
    const near = levelOf(base, base);
    let far = near;
    for (let i = 1; i < (await tiff.getImageCount()); i++) {
      const level = levelOf(await tiff.getImage(i), base);
      // The coarsest level still at or under the far cell size, so the 300 km reach is a window of a few hundred cells.
      if (level.pixM <= FAR_PIX_M && level.pixM > far.pixM) far = level;
    }
    return { near, far };
  });

/** A rectangle of heights around a point, or undefined where the level does not cover it. */
async function patchAround(
  level: TerrainLevel,
  x: number,
  y: number,
  radiusM: number,
): Promise<HeightPatch | undefined> {
  const half = Math.ceil(radiusM / level.pixM);
  const col = Math.round((x - level.cornerX) / level.pixM);
  const row = Math.round((level.cornerY - y) / level.pixM);
  const c0 = Math.max(0, col - half);
  const r0 = Math.max(0, row - half);
  const c1 = Math.min(level.width, col + half + 1);
  const r1 = Math.min(level.height, row + half + 1);
  if (c1 - c0 < 2 || r1 - r0 < 2) return undefined;
  const values = await level.image.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: true });
  const heightsM = values instanceof Float32Array ? values : Float32Array.from(values as ArrayLike<number>);
  return {
    cornerX: level.cornerX + c0 * level.pixM,
    cornerY: level.cornerY - r0 * level.pixM,
    pixM: level.pixM,
    width: c1 - c0,
    height: r1 - r0,
    heightsM,
  };
}

/**
 * The heights around a site: full resolution within `NEAR_RADIUS_M`, an overview out to the horizon's whole reach.
 * Undefined if the site is off the terrain altogether.
 */
const heightsAround = (grids: TerrainGrids, latDeg: number, lonDeg: number, reachM: number) =>
  memo(`heights:${latDeg},${lonDeg},${reachM}`, async (): Promise<HeightSource | undefined> => {
    const { x, y } = polarXY(siteFrame(latDeg, lonDeg).u);
    const [near, far] = await Promise.all([
      patchAround(grids.near, x, y, NEAR_RADIUS_M),
      patchAround(grids.far, x, y, reachM),
    ]);
    const patches = [near, far].filter((p): p is HeightPatch => p !== undefined);
    return patches.length ? heightsFromPatches(patches) : undefined;
  });

const loadMaps = (url: string): Promise<PolarMaps> =>
  memo(`maps:${url}`, async () => mapsFromBytes(await fetchChecked(url), MAPS.n, MAPS.pixM));

/**
 * The site's skyline and the ground under it, with the resolution it was judged at. From the 30 m terrain where
 * `urls.horizonTerrain` names it, otherwise from the small 1.2 km grid. Undefined where the terrain does not reach.
 */
const horizonFor = (
  urls: DataUrls,
  latDeg: number,
  lonDeg: number,
  observerHeightM: number,
): Promise<(DemHorizon & { resolutionM: number; id: string }) | undefined> =>
  memo(`horizon:${urls.horizonTerrain ?? urls.terrain}:${latDeg},${lonDeg},${observerHeightM}`, async () => {
    if (urls.horizonTerrain) {
      const grids = await loadTerrain(urls.horizonTerrain);
      const heights = await heightsAround(grids, latDeg, lonDeg, HORIZON_REACH_M);
      if (!heights) return undefined;
      const hz = horizonFromHeights(heights, latDeg, lonDeg, {
        observerHeightM,
        stepM: grids.near.pixM,
        maxDistM: HORIZON_REACH_M,
      });
      // The resolution the site itself is judged at; the far skyline comes from a coarser overview (see TERRAIN).
      return hz && { ...hz, resolutionM: grids.near.pixM, id: TERRAIN.id };
    }
    const dem = await loadDrawnDem(urls.terrain);
    const hz = horizonFromDem(dem, latDeg, lonDeg, { observerHeightM });
    return hz && { ...hz, resolutionM: dem.pixM, id: DRAWN.id };
  });

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
    return loadDrawnDem(url);
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
    const maps = await quiet(loadMaps(urls.maps), () => {});
    const hz = await quiet(horizonFor(urls, query.site.latDeg, query.site.lonDeg, query.observerHeightM), (m) => {
      terrainError = m;
    });
    // The 30 m grid cannot resolve the 100 m landing-slope rule; the 10 m one can, where it reaches (inside 83°S).
    const raced = await within(slopeRun, slopeWaitMs);
    const slope = slopeDone ? slopeDone.value : raced;
    const result = stayTest(hz ? { ...query, site: { ...query.site, heightM: hz.groundHeightM } } : query, {
      ephemeris,
      horizon: hz?.mask ?? flatHorizon(),
      slope100mDeg: slope?.slope100mDeg ?? Number.NaN,
      slope2kmPctUnder20: slope?.slope2kmPctUnder20 ?? Number.NaN,
      sources: [...EPHEMERIS_SOURCES, ...(hz ? [hz.id] : []), ...(slope ? [slope.id] : [])],
    });
    const terrain = hz && { id: hz.id, resolutionM: hz.resolutionM, groundHeightM: hz.groundHeightM };
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
    const hz = await quiet(horizonFor(urls, query.site.latDeg, query.site.lonDeg, query.observerHeightM), () => {});
    const site = hz ? { ...query.site, heightM: hz.groundHeightM } : query.site;
    const strip = dayStrip(ephemeris, hz?.mask ?? flatHorizon(), { ...query, site });
    const sources = hz ? [...EPHEMERIS_SOURCES, hz.id] : EPHEMERIS_SOURCES;
    return Comlink.transfer({ ...strip, sources }, [strip.sun.buffer, strip.earth.buffer]);
  },

  /** Rank spots inside a region; the timelines are left out to keep the reply small. */
  async best(search: BestSearch, query: Omit<StayQuery, 'site'>, urls: DataUrls): Promise<BestSpot[]> {
    const ephemeris = await loadEphemeris(urls.data);
    // One read for the whole region: its own width plus the skyline's reach on every side.
    const terrain = urls.horizonTerrain
      ? await heightsAround(
          await loadTerrain(urls.horizonTerrain),
          search.centreLatDeg,
          search.centreLonDeg,
          HORIZON_REACH_M + (search.sizeKm * 1000) / 2,
        )
      : await loadDrawnDem(urls.terrain);
    if (!terrain) return [];
    return bestSpots(search, query, terrain, ephemeris, {
      sources: [...EPHEMERIS_SOURCES, urls.horizonTerrain ? TERRAIN.id : DRAWN.id],
      stepMinutes: 60,
    });
  },
};

export type PhysicsApi = typeof api;
Comlink.expose(api);
