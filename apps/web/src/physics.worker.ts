import type { StayQuery, StayResult } from '@siteline/contracts';
import {
  angularRadiusDeg,
  type BestSearch,
  type BestSpot,
  bestSpots,
  type Dem,
  type DemHorizon,
  demFromInt16,
  EARTH_RADIUS_KM,
  type EphemerisTable,
  EYE_HEIGHT_M,
  elevAz,
  eyeSky,
  flatHorizon,
  gridNormals,
  gridPositions,
  gridTriangles,
  type HeightPatch,
  type HeightSource,
  HORIZON_MIN_DIST_M,
  heightsFromPatches,
  horizonFromDem,
  horizonFromHeights,
  type LocalFrame,
  type LocalGrid,
  levelsUpAt,
  localDirection,
  localFrame,
  localToGeo,
  mapsAtSite,
  mapsFromBytes,
  marsSubsolarPoint,
  PLANET_NAMES,
  type PlanetName,
  type PlanetTable,
  type PointGrid,
  type PolarMaps,
  parseEphemeris,
  parsePlanets,
  patchHeightM,
  polarScaleFactor,
  polarToUnit,
  polarXY,
  resampleGrid,
  resampleToLocal,
  type SolarBodyKey,
  SUN_RADIUS_KM,
  siteFrame,
  siteSlopes,
  stayTest,
  subsolarPoint,
  sweepDiscVisibility,
  unitToLatLon,
  type Vec3,
  WALK_RADIUS_M,
} from '@siteline/physics';
import * as Comlink from 'comlink';
import type { GeoTIFFImage } from 'geotiff';
import fineRegions from './a3clrRegions.json';
import { type DayStrip, dayStrip } from './dayStrip';
import { checksOf, verdictOf } from './verdict';

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
 * windows: the cells within `NEAR_RADIUS_M` at full 30 m, and the whole reach from its coarsest overview,
 * about 1.9 km. A ridge 300 km away is a few pixels of skyline whatever it was sampled at, while the ground near the site
 * is what actually sets its horizon. `TerrainInfo.resolutionM` reports the near-site figure, the one the site is
 * judged by; CREDITS.md carries the caveat that the far skyline is coarser.
 */
const TERRAIN = { id: 'lola-ldem-75s-30m' };
/**
 * How far around a site the terrain is read at its full resolution. Together with FAR_PIX_M, the configuration
 * horizon30m.validation.test.ts checks against NASA's own sunlight maps, and a few tiles a site.
 */
const NEAR_RADIUS_M = 3_000;
/** The coarsest cell the far skyline may be read at; the file's overviews pick the nearest level at or under it:
 * its coarsest, 1.9 km, holds the whole 300 km reach in one tile. */
const FAR_PIX_M = 2_000;
/** How far the skyline is looked for, the same reach the horizon walk has always used. */
const HORIZON_REACH_M = 300_000;
/**
 * The concept demo's long-term maps, from its file's own description: 186 × 186 at 2.4 km, sunlight and Earth view
 * and the never-sunlit flag. Read only where NASA's (PGDA product 69, built by the pipeline) have not been published;
 * those name their own grid, cell size and dataset in their header.
 */
const DEMO_MAPS = { id: 'landfall-polar-maps', n: 186, pixM: 2400 };
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
  /** NASA's long-term maps (PGDA product 69), as the pipeline publishes them; `maps` is read where they are not. */
  illumination?: string;
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
  /** Distance to the nearest never-sunlit ground, km: where ice can persist, not where it is known to be. */
  shadowDistanceKm?: number;
}

export interface StayResponse {
  result: StayResult;
  terrain?: TerrainInfo;
  terrainError?: string;
  /** The slopes, when the site is on the 10 m terrain and its tiles arrived in time. */
  slope?: SlopeInfo;
  /** True when the slope's tiles were still on their way: asking again with more patience will bring the slope. */
  slopePending?: boolean;
  /**
   * True when the 30 m terrain was still on its way, so this answer was worked out on the 1.2 km grid: asking again
   * with more patience brings the skyline the site is judged against.
   */
  terrainPending?: boolean;
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
  return checked((await (await fetchOk(url)).json()) as Base64File, url);
}

/** A base64 file's bytes, refused unless their length and sha256 match its header. */
async function checked(file: Base64File, url: string): Promise<Uint8Array> {
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

/**
 * Every level of a terrain GeoTIFF, finest first, opened once per file: headers and tile indexes only, never the whole
 * file. The stay check, the slope and the surface view all read through this one copy, so a file's header is fetched
 * once and its tiles share one cache.
 */
const loadPyramid = (url: string): Promise<TerrainLevel[]> =>
  memo(`pyramid:${url}`, async () => {
    const { fromUrl } = await import('geotiff');
    const tiff = await fromUrl(url);
    const base = await tiff.getImage();
    const levels = [levelOf(base, base)];
    for (let i = 1; i < (await tiff.getImageCount()); i++) levels.push(levelOf(await tiff.getImage(i), base));
    return levels;
  });

/** The terrain's full-resolution level and the overview the far skyline is read from. */
const loadTerrain = (url: string): Promise<TerrainGrids> =>
  memo(`terrain:${url}`, async () => {
    const levels = await loadPyramid(url);
    const near = levels[0];
    let far = near;
    for (const level of levels.slice(1)) {
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
const heightsAround = (
  grids: TerrainGrids,
  latDeg: number,
  lonDeg: number,
  reachM: number,
  nearM: number = NEAR_RADIUS_M,
) =>
  memo(`heights:${latDeg},${lonDeg},${reachM},${nearM}`, async (): Promise<HeightSource | undefined> => {
    const { x, y } = polarXY(siteFrame(latDeg, lonDeg).u);
    const [near, far] = await Promise.all([patchAround(grids.near, x, y, nearM), patchAround(grids.far, x, y, reachM)]);
    const patches = [near, far].filter((p): p is HeightPatch => p !== undefined);
    return patches.length ? heightsFromPatches(patches) : undefined;
  });

/** A maps file and the dataset it is, from its own header where it has one (the demo's has none). */
interface LoadedMaps {
  maps: PolarMaps;
  id: string;
}

interface MapsFile extends Base64File {
  n?: number;
  pixM?: number;
  distanceUnitKm?: number;
  datasetId?: string;
}

const loadMapsFile = (url: string): Promise<LoadedMaps> =>
  memo(`maps:${url}`, async () => {
    const file = (await (await fetchOk(url)).json()) as MapsFile;
    const bytes = await checked(file, url);
    return file.n && file.pixM
      ? { maps: mapsFromBytes(bytes, file.n, file.pixM, file.distanceUnitKm), id: file.datasetId ?? url }
      : { maps: mapsFromBytes(bytes, DEMO_MAPS.n, DEMO_MAPS.pixM), id: DEMO_MAPS.id };
  });

/** NASA's maps where the pipeline has published them, the demo's otherwise. */
const loadMaps = (urls: DataUrls): Promise<LoadedMaps> =>
  urls.illumination ? loadMapsFile(urls.illumination).catch(() => loadMapsFile(urls.maps)) : loadMapsFile(urls.maps);

type JudgedHorizon = DemHorizon & { resolutionM: number; id: string };

/**
 * The site's skyline from the 30 m terrain, read around it and cached; undefined where the terrain does not reach or
 * cannot be read (no network, or a host the bucket does not serve), so the caller can fall back to the 1.2 km grid.
 */
const fineHorizon = (urls: DataUrls, latDeg: number, lonDeg: number, observerHeightM: number) =>
  memo(`horizon30:${urls.horizonTerrain}:${latDeg},${lonDeg},${observerHeightM}`, async () => {
    if (!urls.horizonTerrain) return undefined;
    const url = urls.horizonTerrain;
    return (async (): Promise<JudgedHorizon | undefined> => {
      const grids = await loadTerrain(url);
      const heights = await heightsAround(grids, latDeg, lonDeg, HORIZON_REACH_M);
      if (!heights) return undefined;
      const hz = horizonFromHeights(heights, latDeg, lonDeg, {
        observerHeightM,
        stepM: grids.near.pixM,
        maxDistM: HORIZON_REACH_M,
      });
      // The resolution the site itself is judged at; the far skyline comes from a coarser overview (see TERRAIN).
      return hz && { ...hz, resolutionM: grids.near.pixM, id: TERRAIN.id };
    })().catch(() => undefined);
  });

/** The site's skyline from the small 1.2 km grid the 3D view already has: instant, and the fallback. */
const coarseHorizon = (urls: DataUrls, latDeg: number, lonDeg: number, observerHeightM: number) =>
  memo(`horizon12:${urls.terrain}:${latDeg},${lonDeg},${observerHeightM}`, async () => {
    const dem = await loadDrawnDem(urls.terrain);
    const hz = horizonFromDem(dem, latDeg, lonDeg, { observerHeightM });
    return hz && ({ ...hz, resolutionM: dem.pixM, id: DRAWN.id } satisfies JudgedHorizon);
  });

/** The finest skyline there is, however long it takes: for the views that do not race it. */
const horizonFor = async (urls: DataUrls, latDeg: number, lonDeg: number, observerHeightM: number) =>
  (await fineHorizon(urls, latDeg, lonDeg, observerHeightM)) ??
  (await coarseHorizon(urls, latDeg, lonDeg, observerHeightM));

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

// The full-resolution level's tie point is its first cell's outer corner, or its centre for a grid of points; `levelOf`
// turns either into the outer corner.
const loadFine = (url: string): Promise<FineGrid> => memo(`fine:${url}`, async () => (await loadPyramid(url))[0]);

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

/** A landing site that passes all four checks, as the site report itself judges them. */
export interface PassingSite {
  latDeg: number;
  lonDeg: number;
  /** The least share of the Sun's disc above the horizon over the stay, 0 to 1. */
  sunFractionMin: number;
  earthVisiblePct: number;
  slope100mDeg: number;
}

export interface PassingSearch {
  sites: PassingSite[];
  /** Points screened on the coarse terrain, and candidates run through the full check. */
  screened: number;
  checked: number;
}

/** How many of the coarse screen's best points go through the full check, at most. */
const PASSING_CANDIDATES = 8;
/** How far the quick screen looks for each point's skyline, metres. */
const SCREEN_REACH_M = 120_000;
/** How many candidates go through the full check at once. */
const CHECKS_AT_ONCE = 2;
/** How far around a too-steep candidate to look for flatter ground, metres. */
const FLATTER_STEPS_M = [120, 250];
/** How long the full check may wait for a candidate's 30 m skyline and 10 m slope tiles. */
const PASSING_PATIENCE_MS = 45_000;

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

// --- Land Here: the ground around one point at real scale, for the surface view ---

/** One ring of the surface view's terrain: how far it reaches and how finely it is drawn. */
interface SurfaceRing {
  /** 0 is the walkable ground; each ring after it has cells twice the size and reaches twice as far. */
  index: number;
  spacingM: number;
  halfM: number;
}

export type SurfaceQuality = 'high' | 'low';

/** Cells along each side of every ring: the same for all of them, so each draws the same detail on screen. */
const RING_CELLS: Record<SurfaceQuality, number> = { high: 320, low: 160 };
/** The walkable ground's cell: the 10 m terrain's own. */
const WALK_SPACING_M = 10;
/** Cells across each coarse stand-in read: a single tile, or a few, of the 30 m terrain's overviews. */
const STAND_IN_CELLS = 100;
/** How many rings are sharpened at once, nearest first: the near ones are the ones you notice. */
const RINGS_AT_ONCE = 2;
/** The walkable ground's shadow map, finer than its 10 m mesh so shadow edges stay sharp. */
const SHADOW_MAP_M: Record<SurfaceQuality, number> = { high: 2.5, low: 5 };

/**
 * The surface view's terrain as nested squares around the landing point (a geometry clipmap): the walkable ground at
 * the terrain's own 10 m, then rings whose cells double in size as they double in reach, out past the skyline's
 * 300 km (the stay check's own reach). A cell then looks about the same size on screen at every distance, so far ridges
 * stay as sharp as near ones. `low` draws a quarter of the triangles: the same 10 m ground, half as far across. With
 * NASA's 5 m terrain, one more ring at 5 m goes inside the walkable ground.
 */
function surfaceRings(quality: SurfaceQuality, innerSpacingM = WALK_SPACING_M): SurfaceRing[] {
  const cells = RING_CELLS[quality];
  const rings: SurfaceRing[] = [];
  for (let index = 0, spacingM = innerSpacingM; ; index++, spacingM *= 2) {
    const halfM = (cells / 2) * spacingM;
    rings.push({ index, spacingM, halfM });
    if (halfM >= HORIZON_REACH_M) return rings;
  }
}

export interface SurfaceRequest {
  /** Names this request, so a newer one, or Cancel, can stop it. */
  id: number;
  latDeg: number;
  lonDeg: number;
  quality: SurfaceQuality;
  /**
   * Also download NASA's 5 m terrain of the Artemis III region the point lies in (`a3clr-sfs-5m`), for the ground
   * around it: one member of the region's zip, 16 to 73 MB, fetched whole. Asked for only when the person chooses it.
   */
  fine5?: boolean;
}

export interface SurfaceProgress {
  /** What is under way: opening the files' headers, reading the first terrain, building the meshes. */
  now: 'opening' | 'reading' | 'building';
  /** Whether the walkable ground is in, and the coarse reads that stand in for the rest until each ring's own arrives. */
  walkRead: boolean;
  farRead: boolean;
  /** The 5 m terrain's download, when asked for: bytes so far, of all. */
  fineBytes?: number;
  fineTotal?: number;
}

/**
 * One ring rebuilt from its own detailed read, after the first scene went up with a coarse stand-in for it; or, with
 * `done`, word that every ring is in (the shadows are then worth working out again).
 */
export type RingUpdate = { key: string; level: SurfaceLevelData; done?: undefined } | { key: string; done: true };

export interface SurfaceLevelData {
  /** 0 is the walkable ground; each ring after it has cells twice the size and reaches twice as far. */
  index: number;
  /** The terrain file the heights came from, by its id in CREDITS.md. */
  datasetId: string;
  /** The cell size of the level of that file that was read, metres. */
  sourcePixM: number;
  /** The drawn mesh's node spacing, metres. */
  spacingM: number;
  halfM: number;
  size: number;
  /** Nodes with no height at all, and nodes whose height came from a coarser read, percent. */
  missingPct: number;
  filledPct: number;
  /** True while this ring is drawn from a coarse stand-in, before its own read arrives. */
  provisional: boolean;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Local up of each node; sent for the rings the camera can be over (the walkable ground and the next ring). */
  up?: Float32Array;
}

export interface SurfaceScene {
  key: string;
  /** The ring you walk on: 0, or 1 when a 5 m ring lies inside it. */
  walkIndex: number;
  /** The Artemis III region whose 5 m terrain the innermost ring comes from, if it does. */
  fineRegion?: string;
  latDeg: number;
  lonDeg: number;
  /** The ground's height at the point above the 1737.4 km sphere, metres. */
  groundHeightM: number;
  levels: SurfaceLevelData[];
}

export type SurfaceOutcome =
  | { status: 'ready'; scene: SurfaceScene }
  /** The point is outside every terrain file's grid. */
  | { status: 'outside' }
  /** Inside a grid, but no file has a height at the point itself. */
  | { status: 'nodata' }
  | { status: 'cancelled' };

export interface SkyBody {
  /** Local east, north, up unit vector from the landing point. */
  dir: [number, number, number];
  distKm: number;
  radiusDeg: number;
}

export interface EyeView {
  east: number;
  north: number;
  /** Where the eye is, and the ground under it: local up, metres. */
  groundUpM: number;
  eyeHeightM: number;
  latDeg: number;
  lonDeg: number;
  /** Elevation and azimuth in the eye's own frame, degrees. */
  sun: { elevDeg: number; azDeg: number; horizonDeg: number; fraction: number };
  earth: { elevDeg: number; azDeg: number; horizonDeg: number; fraction: number };
}

export interface SurfaceSky {
  /** The moment worked out, clamped to the ephemeris (`clamped` says if it was). */
  tUtcMs: number;
  clamped: boolean;
  sun: SkyBody;
  earth: SkyBody;
  /** The share of the Sun's disc each node of each ring sees above the terrain, 0 to 1, ring by ring. */
  sunlit?: Float32Array[];
  /** The same on the walkable ground, at `spacingM` (finer than its mesh), as bytes 0 to 255, laid out like a grid. */
  shadowMap?: { data: Uint8Array; size: number; spacingM: number; halfM: number };
  /** How finely the shadows were worked out on the walkable ground, metres. */
  shadowM?: number;
  eye?: EyeView;
}

/** What is said about each ring, beside its grid. */
type RingInfo = Omit<SurfaceLevelData, 'positions' | 'normals' | 'indices' | 'up' | 'size'>;

/**
 * A surface the worker has built: its frame and grids, kept for the light and the eye, and to draw again without
 * reading the terrain again when the same point is visited twice.
 */
interface BuiltSurface {
  frame: LocalFrame;
  grids: LocalGrid[];
  rings: RingInfo[];
  /** How finely the walkable ground's shadow map is worked out, metres. */
  shadowMapM: number;
  /** False while rings still wait for their own reads; only a complete surface is drawn again from memory. */
  complete: boolean;
  walkIndex: number;
  fineRegion?: string;
}

/** One ring's mesh, ready to send to the main thread (fresh arrays, so they can be transferred). */
function levelOfBuilt(built: BuiltSurface, i: number): SurfaceLevelData {
  const grid = built.grids[i];
  const ring = built.rings[i];
  const finer = i > 0 ? built.rings[i - 1] : undefined;
  return {
    ...ring,
    size: grid.size,
    // Under a finer ring a coarse one sinks a little (5% of its cell, plus a metre), so the finer ground is the one seen.
    positions: gridPositions(grid, finer ? 0.05 * ring.spacingM + 1 : 0, finer?.halfM),
    normals: gridNormals(grid),
    indices: gridTriangles(grid, finer?.halfM),
    up: ring.index <= built.walkIndex + 1 ? grid.up.slice() : undefined,
  };
}

const levelBuffers = (l: SurfaceLevelData) => [
  l.positions.buffer,
  l.normals.buffer,
  l.indices.buffer,
  ...(l.up ? [l.up.buffer] : []),
];

/** The meshes of a built surface, ready to send to the main thread. */
function sceneOf(key: string, latDeg: number, lonDeg: number, built: BuiltSurface): SurfaceScene {
  const levels = built.grids.map((_, i) => levelOfBuilt(built, i));
  return {
    key,
    latDeg,
    lonDeg,
    groundHeightM: built.frame.groundHeightM,
    levels,
    walkIndex: built.walkIndex,
    fineRegion: built.fineRegion,
  };
}

/** What a resampled grid says about where its heights came from. */
function ringInfoOf(
  grid: LocalGrid,
  ring: SurfaceRing,
  read: { patch: HeightPatch; datasetId: string },
  provisional: boolean,
): RingInfo {
  let missing = 0;
  let filled = 0;
  for (const f of grid.from ?? []) {
    if (f === 255) missing++;
    else if (f > 0) filled++;
  }
  return {
    index: ring.index,
    datasetId: read.datasetId,
    sourcePixM: read.patch.pixM,
    spacingM: ring.spacingM,
    halfM: ring.halfM,
    missingPct: (100 * missing) / grid.up.length,
    filledPct: (100 * filled) / grid.up.length,
    provisional,
  };
}

const surfaces = new Map<string, BuiltSurface>();
const surfaceRequests = new Map<number, AbortController>();
const SURFACES_KEPT = 3;

const surfaceKey = (r: Pick<SurfaceRequest, 'latDeg' | 'lonDeg' | 'quality' | 'fine5'>) =>
  `${r.latDeg},${r.lonDeg},${r.quality}${r.fine5 ? ',5m' : ''}`;

/**
 * A rectangle of a terrain level around a local square, read by byte ranges: the square's outline is carried into the
 * polar plane and its bounding box read, plus a margin. `cornerX`/`cornerY` are the first cell's centre, as
 * `patchHeightM` reads them. `complete` is false where the level's edge cut the rectangle short; undefined where the
 * level does not reach at all.
 */
async function windowFor(
  level: TerrainLevel,
  frame: LocalFrame,
  halfM: number,
  signal: AbortSignal,
): Promise<{ patch: HeightPatch; complete: boolean } | undefined> {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const along = -halfM + (2 * halfM * i) / steps;
    for (const [e, n] of [
      [along, halfM],
      [along, -halfM],
      [halfM, along],
      [-halfM, along],
    ]) {
      // The square's outline on the site's horizontal plane, carried straight down onto the sphere.
      const x = frame.origin[0] + e * frame.e[0] + n * frame.n[0];
      const y = frame.origin[1] + e * frame.e[1] + n * frame.n[1];
      const z = frame.origin[2] + e * frame.e[2] + n * frame.n[2];
      const len = Math.hypot(x, y, z);
      const q = polarXY([x / len, y / len, z / len]);
      minX = Math.min(minX, q.x);
      maxX = Math.max(maxX, q.x);
      minY = Math.min(minY, q.y);
      maxY = Math.max(maxY, q.y);
    }
  }
  // Heights shift where the ground meets the plane by up to about 1% of the reach; two cells more for the bilinear read.
  const margin = 0.01 * halfM + 2 * level.pixM;
  const wantC0 = Math.floor((minX - margin - level.cornerX) / level.pixM);
  const wantC1 = Math.ceil((maxX + margin - level.cornerX) / level.pixM);
  const wantR0 = Math.floor((level.cornerY - maxY - margin) / level.pixM);
  const wantR1 = Math.ceil((level.cornerY - minY + margin) / level.pixM);
  const c0 = Math.max(0, wantC0);
  const c1 = Math.min(level.width, wantC1);
  const r0w = Math.max(0, wantR0);
  const r1w = Math.min(level.height, wantR1);
  if (c1 - c0 < 2 || r1w - r0w < 2) return undefined;
  const complete = c0 === wantC0 && c1 === wantC1 && r0w === wantR0 && r1w === wantR1;
  const values = await level.image.readRasters({
    window: [c0, r0w, c1, r1w],
    samples: [0],
    interleave: true,
    signal,
  });
  const heightsM = values instanceof Float32Array ? values : Float32Array.from(values as ArrayLike<number>);
  // The files mark missing cells NaN; anything else non-finite or absurd is treated the same.
  for (let i = 0; i < heightsM.length; i++) if (!(Math.abs(heightsM[i]) < 20_000)) heightsM[i] = Number.NaN;
  return {
    patch: {
      cornerX: level.cornerX + (c0 + 0.5) * level.pixM,
      cornerY: level.cornerY - (r0w + 0.5) * level.pixM,
      pixM: level.pixM,
      width: c1 - c0,
      height: r1w - r0w,
      heightsM,
    },
    complete,
  };
}

/** The coarsest level of a pyramid that is still at least as fine as `spacingM`. */
function levelFor(levels: readonly TerrainLevel[], spacingM: number): TerrainLevel {
  let best = levels[0];
  for (const level of levels) if (level.pixM <= spacingM * 1.001 && level.pixM > best.pixM) best = level;
  return best;
}

/** A patch's height at a polar point, NaN where it has none. */
const patchSource = (patch: HeightPatch): HeightSource => heightsFromPatches([patch]);

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';

/** One Artemis III region's 5 m elevation model inside its zip, as `scripts/a3clr-regions.mjs` read it. */
interface FineRegion {
  archive: string;
  name: string;
  method: number;
  crc32: number;
  compressedBytes: number;
  bytes: number;
  dataOffset: number;
  width: number;
  height: number;
  pixM: number;
  cornerX: number;
  cornerY: number;
}
const FINE5 = { id: 'a3clr-sfs-5m' };

/** The region whose 5 m model covers a polar point, if any. */
function fineRegionAt(x: number, y: number): FineRegion | undefined {
  return (fineRegions.regions as FineRegion[]).find(
    (r) => x > r.cornerX && x < r.cornerX + r.width * r.pixM && y < r.cornerY && y > r.cornerY - r.height * r.pixM,
  );
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The zip format's CRC-32 of some bytes. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A byte range fetched as six side-by-side requests, `onBytes` told the running total. */
async function fetchRange(
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(new ArrayBuffer(length));
  const parts = 6;
  const size = Math.ceil(length / parts);
  let total = 0;
  await Promise.all(
    Array.from({ length: parts }, async (_, i) => {
      const start = i * size;
      const end = Math.min(length, start + size) - 1;
      if (start > end) return;
      const r = await fetch(url, { headers: { Range: `bytes=${offset + start}-${offset + end}` }, signal });
      if (r.status !== 206 || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
      const reader = r.body.getReader();
      let at = start;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.set(value, at);
        at += value.length;
        total += value.length;
        onBytes(total);
      }
      if (at !== end + 1) throw new Error(`${url}: the range came back short`);
    }),
  );
  return out;
}

/**
 * A region's 5 m elevation model as a terrain level: its member of the zip fetched whole (the zip stores it deflated,
 * so no window of it can be read alone), inflated, checked against the zip's own size and CRC-32, and opened.
 */
async function loadFineRegion(
  region: FineRegion,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<TerrainLevel> {
  const url = `${fineRegions.baseUrl}/${region.archive}`;
  const packed = await fetchRange(url, region.dataOffset, region.compressedBytes, signal, onBytes);
  let bytes: Uint8Array;
  if (region.method === 0) bytes = packed;
  else if (region.method === 8) {
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  } else throw new Error(`${region.archive}: compression method ${region.method} is not handled`);
  throwIfCancelled(signal);
  if (bytes.length !== region.bytes || crc32(bytes) !== region.crc32)
    throw new Error(`${region.archive}: the 5 m terrain failed its check`);
  const { fromArrayBuffer } = await import('geotiff');
  const image = await (await fromArrayBuffer(bytes.buffer as ArrayBuffer)).getImage();
  return levelOf(image, image);
}

/** A first scene to show, and the work that sharpens it afterwards. */
interface SurfaceBuild {
  outcome: SurfaceOutcome;
  refine?: () => Promise<void>;
}

/**
 * The surface view's terrain around a point, in two steps so it shows quickly even on a slow connection:
 *
 * 1. The walkable ground at the 10 m terrain's full detail (or the 30 m terrain's, outside 83°S), and two small coarse
 *    reads of the 30 m terrain that stand in for every other ring. That is a few tiles, and the scene goes up.
 * 2. Then every other ring is read at its own detail, all at once, each from the level of a file whose cells match its
 *    own, and handed over through `onRing` as it is rebuilt.
 *
 * Everything is resampled at real scale onto the point's local frame. No height is invented: a hole in one read is
 * filled from a coarser read of real terrain, and a hole in all of them is left out of the mesh.
 */
async function buildSurface(
  request: SurfaceRequest,
  urls: DataUrls,
  onProgress: (p: SurfaceProgress) => void,
  onRing: (update: RingUpdate) => void,
  signal: AbortSignal,
): Promise<SurfaceBuild> {
  const { latDeg, lonDeg } = request;
  const site = polarXY(siteFrame(latDeg, lonDeg).u);
  const fineRegion = request.fine5 ? fineRegionAt(site.x, site.y) : undefined;
  const rings = surfaceRings(request.quality, fineRegion ? fineRegion.pixM : WALK_SPACING_M);
  // The ring you walk on is the one at the 10 m terrain's spacing; a 5 m ring, if any, lies inside it.
  const walkIndex = fineRegion ? 1 : 0;
  let walkRead = false;
  let farRead = false;
  let fineBytes: number | undefined = fineRegion ? 0 : undefined;
  const report = (now: SurfaceProgress['now']) =>
    onProgress({ now, walkRead, farRead, fineBytes, fineTotal: fineRegion?.compressedBytes });
  report('opening');
  if (!urls.horizonTerrain) throw new Error('no terrain is configured for the surface view');
  const [coarseLevels, fineLevels] = await Promise.all([
    loadPyramid(urls.horizonTerrain),
    urls.fine ? loadPyramid(urls.fine).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  throwIfCancelled(signal);
  const inside = (l: TerrainLevel) =>
    site.x > l.cornerX &&
    site.x < l.cornerX + l.width * l.pixM &&
    site.y < l.cornerY &&
    site.y > l.cornerY - l.height * l.pixM;
  if (!inside(coarseLevels[0]) && !(fineLevels && inside(fineLevels[0]))) return { outcome: { status: 'outside' } };

  // A provisional frame for choosing windows; the ground height only shifts it by a fraction of a cell.
  const guess = localFrame(latDeg, lonDeg, 0);
  type Read = { patch: HeightPatch; datasetId: string };
  /**
   * A ring's own read, from the level whose cells match its own: the 10 m file where the ring lies inside it (the
   * walkable ground and the next ring even where they only partly do, filled from the 30 m file), the 30 m file else.
   */
  const readRing = async (ring: SurfaceRing): Promise<Read | undefined> => {
    if (fineLevels) {
      const window = await windowFor(levelFor(fineLevels, ring.spacingM), guess, ring.halfM, signal);
      if (window && (window.complete || ring.index <= 1) && Number.isFinite(patchHeightM(window.patch, site.x, site.y)))
        return { patch: window.patch, datasetId: FINE.id };
    }
    const window = await windowFor(levelFor(coarseLevels, ring.spacingM), guess, ring.halfM, signal);
    return window && { patch: window.patch, datasetId: TERRAIN.id };
  };
  /** A coarse read of the 30 m terrain over a square, one tile or so, to stand in for rings not yet read. */
  const standIn = async (cells: number, halfM: number): Promise<Read | undefined> => {
    const window = await windowFor(levelFor(coarseLevels, (2 * halfM) / cells), guess, halfM, signal);
    return window && { patch: window.patch, datasetId: TERRAIN.id };
  };

  report('reading');
  const outermost = rings[rings.length - 1];
  const middle = rings[Math.min(3 + walkIndex, rings.length - 1)];
  /** The 5 m model's window around the point, when asked for and the point lies in a region. */
  const readFine = async (ring: SurfaceRing): Promise<Read | undefined> => {
    if (!fineRegion) return undefined;
    let shown = 0;
    const level = await loadFineRegion(fineRegion, signal, (bytes) => {
      fineBytes = bytes;
      // A report every half megabyte is plenty.
      if (bytes - shown >= 500_000 || bytes === fineRegion.compressedBytes) {
        shown = bytes;
        report('reading');
      }
    });
    const window = await windowFor(level, guess, ring.halfM, signal);
    return window && Number.isFinite(patchHeightM(window.patch, site.x, site.y))
      ? { patch: window.patch, datasetId: FINE5.id }
      : undefined;
  };
  // The rings out to the one you walk on, each at full detail (the innermost from the 5 m model if asked for), and
  // two coarse stand-ins for everything beyond.
  const [inner, mid, far] = await Promise.all([
    Promise.all(
      rings.slice(0, walkIndex + 1).map((ring) => (ring.index === 0 && fineRegion ? readFine(ring) : readRing(ring))),
    ).then((r) => {
      walkRead = true;
      report('reading');
      return r;
    }),
    standIn(STAND_IN_CELLS, middle.halfM),
    standIn(STAND_IN_CELLS, outermost.halfM).then((r) => {
      farRead = true;
      report('reading');
      return r;
    }),
  ]);
  throwIfCancelled(signal);
  report('building');
  // The ground's height, and with it the frame, from the finest read that has the point itself.
  const groundRead = inner.find((r) => r !== undefined);
  const groundHeightM = groundRead ? patchHeightM(groundRead.patch, site.x, site.y) : Number.NaN;
  if (!groundRead || !Number.isFinite(groundHeightM)) return { outcome: { status: 'nodata' } };
  if (fineRegion && !inner[0]) throw new Error(`the 5 m terrain of ${fineRegion.name} has no heights at this point`);

  const frame = localFrame(latDeg, lonDeg, groundHeightM);
  const standIns = [mid, far].filter((r): r is Read => r !== undefined);
  const innerReads = inner.filter((r): r is Read => r !== undefined);
  const grids: LocalGrid[] = [];
  const infos: RingInfo[] = [];
  for (const ring of rings) {
    // Rings out to the walkable one: their own reads, finest first, then the stand-ins; the rest: stand-ins only.
    const reads = ring.index <= walkIndex ? [...innerReads.slice(ring.index), ...standIns] : standIns;
    if (reads.length === 0) break;
    const grid = resampleToLocal(
      frame,
      reads.map((r) => patchSource(r.patch)),
      ring.spacingM,
      ring.halfM,
    );
    grids.push(grid);
    infos.push(ringInfoOf(grid, ring, reads[0], ring.index > walkIndex));
    throwIfCancelled(signal);
  }
  const key = surfaceKey(request);
  const built: BuiltSurface = {
    frame,
    grids,
    rings: infos,
    shadowMapM: SHADOW_MAP_M[request.quality],
    complete: grids.length <= walkIndex + 1,
    walkIndex,
    fineRegion: fineRegion?.name,
  };
  const scene = sceneOf(key, latDeg, lonDeg, built);
  throwIfCancelled(signal);
  surfaces.delete(key);
  surfaces.set(key, built);
  for (const old of surfaces.keys()) {
    if (surfaces.size <= SURFACES_KEPT) break;
    surfaces.delete(old);
  }

  const refine = async () => {
    const own = new Map<number, Read>();
    const queue = rings.slice(walkIndex + 1, grids.length);
    const sharpen = async (ring: SurfaceRing) => {
      const read = await readRing(ring);
      throwIfCancelled(signal);
      if (!read) return;
      own.set(ring.index, read);
      // Its own read first; for a hole in it, any coarser ring's own read already in; then the stand-ins.
      const coarser = [...own.entries()]
        .filter(([i]) => i > ring.index)
        .sort((a, b) => a[0] - b[0])
        .map(([, r]) => r);
      const reads = [read, ...coarser, ...standIns];
      const grid = resampleToLocal(
        frame,
        reads.map((r) => patchSource(r.patch)),
        ring.spacingM,
        ring.halfM,
      );
      throwIfCancelled(signal);
      built.grids[ring.index] = grid;
      built.rings[ring.index] = ringInfoOf(grid, ring, read, false);
      const level = levelOfBuilt(built, ring.index);
      onRing(Comlink.transfer({ key, level }, levelBuffers(level)));
    };
    // A few at a time, nearest first, each worker taking the next ring as it finishes one.
    await Promise.all(
      Array.from({ length: Math.min(RINGS_AT_ONCE, queue.length) }, async () => {
        for (let ring = queue.shift(); ring; ring = queue.shift()) await sharpen(ring);
      }),
    );
    built.complete = true;
    onRing({ key, done: true });
  };
  return { outcome: { status: 'ready', scene }, refine: built.complete ? undefined : refine };
}

/** The Sun and the Earth seen from a built surface at a moment, from the SPICE ephemeris table. */
async function skyAt(
  surface: BuiltSurface,
  tUtcMs: number,
  dataUrl: string,
): Promise<{ t: number; clamped: boolean; sunKm: Vec3; earthKm: Vec3; sun: SkyBody; earth: SkyBody }> {
  const table = await loadEphemeris(dataUrl);
  const t = Math.min(table.endUtcMs, Math.max(table.startUtcMs, tUtcMs));
  const originKm: Vec3 = [
    surface.frame.origin[0] / 1000,
    surface.frame.origin[1] / 1000,
    surface.frame.origin[2] / 1000,
  ];
  const body = (km: Vec3, radiusKm: number): SkyBody => {
    const d: Vec3 = [km[0] - originKm[0], km[1] - originKm[1], km[2] - originKm[2]];
    const distKm = Math.hypot(d[0], d[1], d[2]);
    return { dir: [...localDirection(surface.frame, d)], distKm, radiusDeg: angularRadiusDeg(radiusKm, distKm) };
  };
  const sunKm = table.positionKm('sun', t);
  const earthKm = table.positionKm('earth', t);
  return {
    t,
    clamped: t !== tUtcMs,
    sunKm,
    earthKm,
    sun: body(sunKm, SUN_RADIUS_KM),
    earth: body(earthKm, EARTH_RADIUS_KM),
  };
}

/** What an eye 1.7 m above the ground at (east, north) sees of the Sun and the Earth, from the drawn terrain. */
function eyeAt(
  surface: BuiltSurface,
  east: number,
  north: number,
  sky: { sunKm: Vec3; earthKm: Vec3; sun: SkyBody; earth: SkyBody },
): EyeView | undefined {
  const { grids, frame } = surface;
  const sun = eyeSky(grids, east, north, EYE_HEIGHT_M, sky.sun.dir, sky.sun.radiusDeg, HORIZON_MIN_DIST_M);
  const earth = eyeSky(grids, east, north, EYE_HEIGHT_M, sky.earth.dir, sky.earth.radiusDeg, HORIZON_MIN_DIST_M);
  if (!sun || !earth) return undefined;
  const groundUpM = levelsUpAt(grids, east, north);
  const at = localToGeo(frame, east, north, groundUpM);
  // Elevation and azimuth in the eye's own frame (2 km from the point, the local vertical turns by 0.07°).
  const own = siteFrame(at.latDeg, at.lonDeg, at.heightM, EYE_HEIGHT_M);
  const sunSeen = elevAz(sky.sunKm, own);
  const earthSeen = elevAz(sky.earthKm, own);
  return {
    east,
    north,
    groundUpM,
    eyeHeightM: EYE_HEIGHT_M,
    latDeg: at.latDeg,
    lonDeg: at.lonDeg,
    sun: { elevDeg: sunSeen.elevDeg, azDeg: sunSeen.azDeg, horizonDeg: sun.horizonDeg, fraction: sun.fraction },
    earth: {
      elevDeg: earthSeen.elevDeg,
      azDeg: earthSeen.azDeg,
      horizonDeg: earth.horizonDeg,
      fraction: earth.fraction,
    },
  };
}

/** The point `dx`, `dy` metres away in the polar plane (rounded as the app rounds a picked site). */
function offset(latDeg: number, lonDeg: number, dxM: number, dyM: number): { latDeg: number; lonDeg: number } {
  const { x, y } = polarXY(siteFrame(latDeg, lonDeg).u);
  const p = unitToLatLon(polarToUnit(x + dxM, y + dyM));
  return { latDeg: round4(p.latDeg), lonDeg: round4(p.lonDeg) };
}

const api = {
  /** The terrain grid for drawing; a copy crosses to the main thread. */
  dem(url: string): Promise<Dem> {
    return loadDrawnDem(url);
  },

  /** The long-term maps for the layers: NASA's where published, the demo's otherwise. */
  async maps(urls: DataUrls): Promise<PolarMaps> {
    return (await loadMaps(urls)).maps;
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
    // The 30 m skyline's tiles load alongside the rest and are raced the same way as the slope's.
    let fineDone: { value: JudgedHorizon | undefined } | undefined = urls.horizonTerrain
      ? undefined
      : { value: undefined };
    const fineRun = fineHorizon(urls, latDeg, lonDeg, query.observerHeightM).then((value) => {
      fineDone = { value };
      return value;
    });
    const ephemeris = await loadEphemeris(urls.data);
    let terrainError: string | undefined;
    // NASA's long-term maps where the pipeline has published them, the demo's otherwise (#19).
    const loaded = await quiet(loadMaps(urls), () => {});
    const [fineRaced, raced] = await Promise.all([within(fineRun, slopeWaitMs), within(slopeRun, slopeWaitMs)]);
    const fine = fineDone ? fineDone.value : fineRaced;
    const hz =
      fine ??
      (await quiet(coarseHorizon(urls, latDeg, lonDeg, query.observerHeightM), (m) => {
        terrainError = m;
      }));
    const terrainPending = fineDone === undefined;
    // The 30 m grid cannot resolve the 100 m landing-slope rule; the 10 m one can, where it reaches (inside 83°S).
    const slope = slopeDone ? slopeDone.value : raced;
    const at = loaded && mapsAtSite(loaded.maps, query.site.latDeg, query.site.lonDeg);
    const result = stayTest(hz ? { ...query, site: { ...query.site, heightM: hz.groundHeightM } } : query, {
      ephemeris,
      horizon: hz?.mask ?? flatHorizon(),
      slope100mDeg: slope?.slope100mDeg ?? Number.NaN,
      slope2kmPctUnder20: slope?.slope2kmPctUnder20 ?? Number.NaN,
      // The nearest permanent shadow, a cold trap where ice can persist: a proxy, named as one wherever it is shown.
      iceDistanceKm: at?.shadowDistanceKm,
      sources: [
        ...EPHEMERIS_SOURCES,
        ...(hz ? [hz.id] : []),
        ...(slope ? [slope.id] : []),
        ...(at?.shadowDistanceKm !== undefined && loaded ? [loaded.id] : []),
      ],
    });
    const terrain = hz && { id: hz.id, resolutionM: hz.resolutionM, groundHeightM: hz.groundHeightM };
    const longTerm =
      at && loaded && Number.isFinite(at.sunPct) ? { id: loaded.id, resolutionM: loaded.maps.pixM, ...at } : undefined;
    const { tUtcMs, sun, earth } = result.series;
    const slopePending = slopeDone === undefined;
    return Comlink.transfer({ result, terrain, terrainError, longTerm, slope, slopePending, terrainPending }, [
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
  /** Sites in a region that pass all four checks for this landing date, by the site report's own verdict. */
  passing(search: BestSearch, query: Omit<StayQuery, 'site'>, urls: DataUrls): Promise<PassingSearch> {
    return passingSites(search, query, urls);
  },

  /**
   * Land Here: the terrain around a point for the surface view, reported stage by stage through `onProgress`. Starting
   * a request stops any other still running, so a site picked after another never shows the first one's ground; the
   * main thread checks the id as well. A point visited lately is drawn again from what was read, without the network.
   */
  async surface(
    request: SurfaceRequest,
    urls: DataUrls,
    onProgress: (p: SurfaceProgress) => void,
    onRing: (update: RingUpdate) => void,
  ): Promise<SurfaceOutcome> {
    for (const [id, other] of surfaceRequests) {
      other.abort();
      surfaceRequests.delete(id);
    }
    const controller = new AbortController();
    surfaceRequests.set(request.id, controller);
    const release = () => {
      if (surfaceRequests.get(request.id) === controller) surfaceRequests.delete(request.id);
    };
    const send = (outcome: SurfaceOutcome): SurfaceOutcome =>
      outcome.status === 'ready' ? Comlink.transfer(outcome, outcome.scene.levels.flatMap(levelBuffers)) : outcome;
    try {
      const key = surfaceKey(request);
      const known = surfaces.get(key);
      if (known?.complete) {
        onProgress({ now: 'building', walkRead: true, farRead: true });
        release();
        return send({ status: 'ready', scene: sceneOf(key, request.latDeg, request.lonDeg, known) });
      }
      const { outcome, refine } = await buildSurface(request, urls, onProgress, onRing, controller.signal);
      if (refine) {
        // The scene goes back now; the rings keep sharpening until done, cancelled or replaced.
        refine()
          .catch((e: unknown) => {
            if (!isAbort(e) && !controller.signal.aborted)
              console.warn(`surface: ${e instanceof Error ? e.message : e}`);
          })
          .finally(release);
      } else release();
      return send(outcome);
    } catch (e) {
      release();
      if (isAbort(e) || controller.signal.aborted) return { status: 'cancelled' };
      throw e;
    }
  },

  /** Stops a surface request (Cancel, or the view closing); it answers `cancelled`. */
  surfaceCancel(id: number): void {
    surfaceRequests.get(id)?.abort();
    surfaceRequests.delete(id);
  },

  /**
   * The Sun and the Earth over a built surface at a moment, the cast shadows on every ring, and what the eye at
   * (east, north) sees of both. `quick` works the shadows out four times coarser, for a first answer while the clock
   * is being dragged. Undefined if the surface is no longer kept.
   */
  async surfaceSky(
    key: string,
    tUtcMs: number,
    dataUrl: string,
    eye: { east: number; north: number } | null,
    quick: boolean,
  ): Promise<SurfaceSky | undefined> {
    const surface = surfaces.get(key);
    if (!surface) return undefined;
    const sky = await skyAt(surface, tUtcMs, dataUrl);
    const { grids } = surface;
    const sun = (out: PointGrid) => sweepDiscVisibility(grids, out, sky.sun.dir, sky.sun.radiusDeg);
    // Every ring node by node; the quick pass every other node, filled in between.
    const sunlit = grids.map((g) => {
      if (!quick) return sun(g);
      const coarse: PointGrid = { size: (g.size - 1) / 2 + 1, spacingM: g.spacingM * 2, halfM: g.halfM };
      return resampleGrid(sun(coarse), coarse, g);
    });
    // The walkable ground's own shadow map, finer than its mesh (four times coarser on the quick pass).
    const walk = grids[surface.walkIndex];
    const mapM = surface.shadowMapM * (quick ? 4 : 1);
    const mapSize = Math.round((2 * walk.halfM) / mapM) + 1;
    const map = sun({ size: mapSize, spacingM: mapM, halfM: walk.halfM });
    const data = new Uint8Array(map.length);
    for (let i = 0; i < map.length; i++) data[i] = Math.round(map[i] * 255);
    const result: SurfaceSky = {
      tUtcMs: sky.t,
      clamped: sky.clamped,
      sun: sky.sun,
      earth: sky.earth,
      sunlit,
      shadowMap: { data, size: mapSize, spacingM: mapM, halfM: walk.halfM },
      shadowM: mapM,
      eye: eye ? eyeAt(surface, eye.east, eye.north, sky) : undefined,
    };
    return Comlink.transfer(result, [...sunlit.map((s) => s.buffer), data.buffer]);
  },

  /** Only what the eye at (east, north) sees of the Sun and the Earth: cheap, for after each walk. */
  async surfaceEye(
    key: string,
    tUtcMs: number,
    dataUrl: string,
    east: number,
    north: number,
  ): Promise<SurfaceSky | undefined> {
    const surface = surfaces.get(key);
    if (!surface) return undefined;
    const sky = await skyAt(surface, tUtcMs, dataUrl);
    return {
      tUtcMs: sky.t,
      clamped: sky.clamped,
      sun: sky.sun,
      earth: sky.earth,
      eye: eyeAt(surface, east, north, sky),
    };
  },

  async best(search: BestSearch, query: Omit<StayQuery, 'site'>, urls: DataUrls): Promise<BestSpot[]> {
    const ephemeris = await loadEphemeris(urls.data);
    // One read for the whole region: its own width plus the skyline's reach on every side, at 30 m where it can be
    // read and on the 1.2 km grid otherwise.
    const fine = urls.horizonTerrain
      ? await loadTerrain(urls.horizonTerrain)
          .then((grids) =>
            heightsAround(
              grids,
              search.centreLatDeg,
              search.centreLonDeg,
              HORIZON_REACH_M + (search.sizeKm * 1000) / 2,
              // Every spot in the region is read at 30 m around it, as a single site's check would be.
              NEAR_RADIUS_M + (search.sizeKm * 1000) / 2,
            ),
          )
          .catch(() => undefined)
      : undefined;
    const terrain = fine ?? (await loadDrawnDem(urls.terrain));
    if (!terrain) return [];
    return bestSpots(search, query, terrain, ephemeris, {
      sources: [...EPHEMERIS_SOURCES, fine ? TERRAIN.id : DRAWN.id],
      stepMinutes: 60,
    });
  },
};

/**
 * Sites in a region that pass all four checks (Sun up for the whole stay, Earth in view, landing slope under 10°,
 * within 6° of the pole) for this landing date. A fast screen ranks points on the 1.2 km grid; the best of them then
 * go through exactly the check the site report runs (`stay`, at 30 m and 10 m) and are judged by the report's own
 * verdict, so a site this returns is one the report passes. A candidate that passes everything but its slope is
 * moved to the flattest ground within a few hundred metres that still passes.
 */
async function passingSites(
  search: BestSearch,
  query: Omit<StayQuery, 'site'>,
  urls: DataUrls,
): Promise<PassingSearch> {
  const ephemeris = await loadEphemeris(urls.data);
  const dem = await loadDrawnDem(urls.terrain);
  const grid = search.grid ?? 9;
  // The screen walks each skyline 120 km, not 300: quicker, and only ever more hopeful (see BestSearch.reachM).
  const screen = bestSpots({ ...search, grid, top: grid * grid, reachM: SCREEN_REACH_M }, query, dem, ephemeris, {
    sources: [...EPHEMERIS_SOURCES, DRAWN.id],
    stepMinutes: 60,
  });
  // Candidates: points inside the zone with the Sun and the Earth up for the whole stay on the coarse terrain, best
  // first. The coarse terrain is the optimistic one (it misses the rises near a site that shade it), so a point it
  // fails would not pass at 30 m either; a region with none answers at once.
  const blocks = new Set(['SUN_BELOW_HORIZON', 'EARTH_BELOW_HORIZON', 'OUTSIDE_ZONE']);
  const candidates = screen
    .filter((s) => !s.result.reasons.some((r) => blocks.has(r.code)))
    .slice(0, PASSING_CANDIDATES);

  const check = async (latDeg: number, lonDeg: number) => {
    const site = { id: `moon:${latDeg},${lonDeg}`, body: 'moon' as const, latDeg, lonDeg };
    const r = await api.stay({ ...query, site } as StayQuery, urls, PASSING_PATIENCE_MS);
    return { r, checks: checksOf(r.result), passes: verdictOf(checksOf(r.result)) === 'pass' };
  };
  const found: PassingSite[] = [];
  const top = search.top ?? 3;
  let checked = 0;
  /** One candidate through the full check, moved to flatter ground nearby if only its slope fails. */
  const confirm = async (c: BestSpot): Promise<PassingSite | undefined> => {
    const latDeg = round4(c.latDeg);
    const lonDeg = round4(c.lonDeg);
    checked++;
    let at = { latDeg, lonDeg };
    let verdict = await check(latDeg, lonDeg);
    const onlySlope = verdict.checks.slope === 'no' && verdict.checks.sun === 'yes' && verdict.checks.earth === 'yes';
    if (!verdict.passes && onlySlope && urls.fine) {
      // Lit and in view but too steep: the flattest ground close by, if any is under the limit.
      const fine = urls.fine;
      const around = FLATTER_STEPS_M.flatMap((d) =>
        [0, 45, 90, 135, 180, 225, 270, 315].map((a) =>
          offset(latDeg, lonDeg, d * Math.sin((a * Math.PI) / 180), d * Math.cos((a * Math.PI) / 180)),
        ),
      );
      const slopes = await Promise.all(around.map((p) => slopeAt(p.latDeg, p.lonDeg, fine).catch(() => undefined)));
      const flattest = around
        .map((p, i) => ({ p, deg: slopes[i]?.slope100mDeg ?? Number.POSITIVE_INFINITY }))
        .filter((x) => x.deg < 10)
        .sort((a, b) => a.deg - b.deg)[0];
      if (flattest) {
        checked++;
        at = flattest.p;
        verdict = await check(at.latDeg, at.lonDeg);
      }
    }
    if (!verdict.passes) return undefined;
    const { result } = verdict.r;
    return {
      ...at,
      sunFractionMin: result.sunFractionMin,
      earthVisiblePct: result.earthVisiblePct,
      slope100mDeg: result.slope100mDeg,
    };
  };
  for (let i = 0; i < candidates.length && found.length < top; i += CHECKS_AT_ONCE) {
    const batch = await Promise.all(candidates.slice(i, i + CHECKS_AT_ONCE).map(confirm));
    for (const site of batch) if (site) found.push(site);
  }
  found.sort(
    (a, b) =>
      b.sunFractionMin - a.sunFractionMin || b.earthVisiblePct - a.earthVisiblePct || a.slope100mDeg - b.slope100mDeg,
  );
  return { sites: found, screened: screen.length, checked };
}

export type PhysicsApi = typeof api;
Comlink.expose(api);
