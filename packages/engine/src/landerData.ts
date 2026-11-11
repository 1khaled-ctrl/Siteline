/**
 * NASA landers on the Moon and Mars: the mission list, what each status means, and where the two Mars rovers and the
 * helicopter are on a given day. Positions are planetocentric, east-positive, in degrees.
 */
import { greatCircleKm } from './earthData';
import { MARS_RADIUS_KM } from './marsData';

export type LanderBody = 'Moon' | 'Mars';

/** crew: crewed landing. tipped: landed but on its side. onway: launched, not yet landed. */
export const MISSION_STATUSES = [
  'crew',
  'landed',
  'tipped',
  'active',
  'lost',
  'crashed',
  'failed',
  'impact',
  'next',
  'planned',
  'onway',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

const LANDED: readonly MissionStatus[] = ['crew', 'landed', 'tipped', 'active'];
const LOST: readonly MissionStatus[] = ['lost', 'crashed', 'failed', 'impact'];
const FUTURE: readonly MissionStatus[] = ['next', 'planned', 'onway'];

export const MISSION_FILTERS = ['all', 'landed', 'active', 'future', 'lost'] as const;
export type MissionFilter = (typeof MISSION_FILTERS)[number];

/** A pair of the same text, English then Arabic, as `data/missions.json` stores it. */
export type Bilingual = readonly [en: string, ar: string];

/** One row of `data/missions.json`, with the file's short keys. */
export interface MissionRow {
  id: string;
  b: LanderBody;
  n: string;
  by: string;
  st: MissionStatus;
  d: string;
  dl?: Bilingual;
  lat: number | null;
  lon: number | null;
  ap?: boolean;
  site: Bilingual;
  patch?: string;
  track?: string;
  model?: string;
  src?: string[];
  note: Bilingual;
  pole?: boolean;
}

/** A page that backs a mission's facts: its title and address. */
export type SourceLink = readonly [label: string, url: string];

export interface MissionsJson {
  note: string;
  sources: Record<string, SourceLink>;
  missions: MissionRow[];
}

export interface Mission {
  id: string;
  body: LanderBody;
  name: string;
  operator: string;
  status: MissionStatus;
  /** Landing date as written: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; for a planned mission, the best public target. */
  date: string;
  /** For a mission that has not landed: how its date is worded, such as "Late 2027". */
  dateLabel?: Bilingual;
  /** Landing date in UTC milliseconds; a bare month counts as its 15th and a bare year as 1 July. */
  tUtcMs: number;
  /** Where it is or was; missing when it has no landing place yet. */
  latDeg?: number;
  lonDeg?: number;
  /** The coordinates are an approximate target or estimate, not a measured position. */
  approximate: boolean;
  site: Bilingual;
  /** Close-up terrain key; the file is `<body>_<patch>.png`. */
  patch?: string;
  /** Which rover or helicopter route in `tracks.json` this mission moves along. */
  track?: 'm20' | 'msl' | 'heli';
  /** Which 3D model shows in its card. */
  model?: string;
  sourceIds: string[];
  note: Bilingual;
  /** Aimed at the south pole, where the landing-site check applies. */
  pole: boolean;
}

const TRACKS: readonly string[] = ['m20', 'msl', 'heli'];

function parseDateMs(d: string): number {
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d)) throw new Error(`Unreadable mission date "${d}"`);
  const full = d.length === 4 ? `${d}-07-01` : d.length === 7 ? `${d}-15` : d;
  const t = Date.parse(full);
  if (!Number.isFinite(t)) throw new Error(`Unreadable mission date "${d}"`);
  return t;
}

/** Check and rename the rows of `data/missions.json`; throws on a status, body or date the app does not know. */
export function parseMissions(json: MissionsJson): Mission[] {
  const seen = new Set<string>();
  return json.missions.map((r) => {
    if (seen.has(r.id)) throw new Error(`Mission "${r.id}" is listed twice`);
    seen.add(r.id);
    if (!MISSION_STATUSES.includes(r.st)) throw new Error(`Mission "${r.id}" has unknown status "${r.st}"`);
    if (r.b !== 'Moon' && r.b !== 'Mars') throw new Error(`Mission "${r.id}" is on unknown body "${r.b}"`);
    if ((r.lat === null) !== (r.lon === null)) throw new Error(`Mission "${r.id}" has only one coordinate`);
    if (r.track !== undefined && !TRACKS.includes(r.track)) throw new Error(`Mission "${r.id}" has unknown track`);
    const track = r.track as Mission['track'];
    return {
      id: r.id,
      body: r.b,
      name: r.n,
      operator: r.by,
      status: r.st,
      date: r.d,
      dateLabel: r.dl,
      tUtcMs: parseDateMs(r.d),
      latDeg: r.lat ?? undefined,
      lonDeg: r.lon ?? undefined,
      approximate: r.ap === true,
      site: r.site,
      patch: r.patch,
      track,
      model: r.model,
      sourceIds: r.src ?? [],
      note: r.note,
      pole: r.pole === true,
    };
  });
}

export const hasPlace = (m: Mission): boolean => m.latDeg !== undefined && m.lonDeg !== undefined;

/** A mission counts as not yet landed when its status says so, or when the date shown is before its date. */
export const isFuture = (m: Mission, atUtcMs: number): boolean => FUTURE.includes(m.status) || m.tUtcMs > atUtcMs;
export const isLost = (m: Mission): boolean => LOST.includes(m.status);
export const hasLanded = (m: Mission, atUtcMs: number): boolean => LANDED.includes(m.status) && !isFuture(m, atUtcMs);

/** How a pin is drawn: every mission that has not landed on the date shown shares one dashed style. */
export type PinStyle = 'future' | MissionStatus;
export const pinStyleOf = (m: Mission, atUtcMs: number): PinStyle => (isFuture(m, atUtcMs) ? 'future' : m.status);

/** Colour of the status chip in the card. */
export const toneOf = (m: Mission): 'good' | 'warn' | 'bad' | 'plain' =>
  m.status === 'active' ? 'good' : m.status === 'crew' ? 'warn' : isLost(m) ? 'bad' : 'plain';

export function passesFilter(m: Mission, filter: MissionFilter, atUtcMs: number): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'landed':
      return ['crew', 'landed', 'tipped'].includes(m.status) && !isFuture(m, atUtcMs);
    case 'active':
      return m.status === 'active' && !isFuture(m, atUtcMs);
    case 'future':
      return isFuture(m, atUtcMs);
    case 'lost':
      return isLost(m);
  }
}

/** The missions of one body in date order, narrowed by a filter. */
export function missionsFor(
  missions: readonly Mission[],
  body: LanderBody,
  filter: MissionFilter,
  atUtcMs: number,
): Mission[] {
  return missions
    .filter((m) => m.body === body && passesFilter(m, filter, atUtcMs))
    .sort((a, b) => a.tUtcMs - b.tUtcMs);
}

/** The earliest mission on that body that has not landed yet. */
export function nextMission(missions: readonly Mission[], body: LanderBody): Mission | undefined {
  return missions.filter((m) => m.body === body && FUTURE.includes(m.status)).sort((a, b) => a.tUtcMs - b.tUtcMs)[0];
}

/** The south polar region the pole view covers; sites outside it have no landing-site check. */
export const POLE_SITE_LIMIT_DEG = -83.6;
export const canPlanAtPole = (m: Mission): boolean =>
  m.body === 'Moon' && m.pole && m.latDeg !== undefined && m.latDeg < POLE_SITE_LIMIT_DEG;

export const findMission = (missions: readonly Mission[], id: string): Mission | undefined =>
  missions.find((m) => m.id === id);

/** A Mars solar day in milliseconds. */
export const SOL_MS = 88_775_244;
export const solAt = (m: Mission, atUtcMs: number): number => Math.floor((atUtcMs - m.tUtcMs) / SOL_MS);

// --- Rover and helicopter routes (`tracks.json`) ---

export type RoutePoint = readonly [lonDeg: number, latDeg: number, sol: number];
export type FlightPoint = readonly [flight: number, sol: number, lonDeg: number, latDeg: number];

export interface RoverRoute {
  /** The last position NASA/JPL published when the file was read. */
  now: { sol: number; lonDeg: number; latDeg: number; km: number };
  points: readonly RoutePoint[];
}

export interface Tracks {
  /** Date the file was read from NASA/JPL, `YYYY-MM-DD`. */
  fetched: string;
  m20: RoverRoute;
  msl: RoverRoute;
  heli: readonly FlightPoint[];
}

interface RouteJson {
  now: { sol: number; lon: number; lat: number; km: number };
  pts: [number, number, number][];
}
export interface TracksJson {
  fetched: string;
  m20: RouteJson;
  msl: RouteJson;
  heli: [number, number, number, number][];
}

const route = (r: RouteJson): RoverRoute => {
  if (!r.pts.length) throw new Error('A rover route has no points');
  return { now: { sol: r.now.sol, lonDeg: r.now.lon, latDeg: r.now.lat, km: r.now.km }, points: r.pts };
};

export function parseTracks(json: TracksJson): Tracks {
  return { fetched: json.fetched, m20: route(json.m20), msl: route(json.msl), heli: json.heli };
}

/** Length of a route in kilometres on Mars, up to and including the points at or before `sol`. */
function routeKm(points: readonly RoutePoint[], sol = Number.POSITIVE_INFINITY): number {
  let km = 0;
  for (let i = 1; i < points.length && points[i][2] <= sol; i++)
    km += greatCircleKm(points[i - 1][1], points[i - 1][0], points[i][1], points[i][0], MARS_RADIUS_KM);
  return km;
}

/** Perseverance's sol on the date shown, never past the last sol the route covers. */
const roverSol = (missions: readonly Mission[], atUtcMs: number): number => {
  const m = findMission(missions, 'perseverance');
  return m ? solAt(m, atUtcMs) : 0;
};

/**
 * Where a mission is on the date shown. Perseverance and Ingenuity follow their published routes by sol; Curiosity is
 * at the last position NASA/JPL published (its file has no sol for each point). Anything else is where it landed.
 */
export function missionPlace(
  missions: readonly Mission[],
  m: Mission,
  tracks: Tracks | undefined,
  atUtcMs: number,
): { latDeg: number; lonDeg: number } | undefined {
  if (tracks && m.track === 'm20') {
    const sol = roverSol(missions, atUtcMs);
    let p = tracks.m20.points[0];
    for (const q of tracks.m20.points) {
      if (q[2] <= sol) p = q;
      else break;
    }
    return { latDeg: p[1], lonDeg: p[0] };
  }
  if (tracks && m.track === 'msl' && atUtcMs >= m.tUtcMs)
    return { latDeg: tracks.msl.now.latDeg, lonDeg: tracks.msl.now.lonDeg };
  if (tracks && m.track === 'heli') {
    const sol = roverSol(missions, atUtcMs);
    let last: FlightPoint | undefined;
    for (const f of tracks.heli) if (f[1] <= sol) last = f;
    if (last) return { latDeg: last[3], lonDeg: last[2] };
  }
  return m.latDeg === undefined || m.lonDeg === undefined ? undefined : { latDeg: m.latDeg, lonDeg: m.lonDeg };
}

/**
 * How far a rover has driven and which sol that is. NASA/JPL gives only the total driven when the file was read, so
 * for Perseverance on an earlier date the total is shared out along the route by length.
 */
export function roverProgress(
  missions: readonly Mission[],
  tracks: Tracks,
  id: 'perseverance' | 'curiosity',
  atUtcMs: number,
): { km: number; sol: number } {
  if (id === 'curiosity') return { km: tracks.msl.now.km, sol: tracks.msl.now.sol };
  const sol = Math.min(Math.max(0, roverSol(missions, atUtcMs)), tracks.m20.now.sol);
  const total = routeKm(tracks.m20.points);
  return { km: total > 0 ? tracks.m20.now.km * (routeKm(tracks.m20.points, sol) / total) : 0, sol };
}

/** A line or a set of dots drawn on the ground, as `[latDeg, lonDeg]` pairs. */
export interface SurfaceLine {
  points: readonly (readonly [latDeg: number, lonDeg: number])[];
  colourHex: number;
  /** Draw each point as a dot instead of joining them. */
  dots?: boolean;
}

export const ROUTE_COLOURS = { m20: 0xff9f43, msl: 0x7fd1ff, heli: 0xe3a2ff } as const;

/** The Mars routes to draw on the date shown: what Perseverance has driven by then, Curiosity's, and Ingenuity's flights. */
export function marsRoutes(missions: readonly Mission[], tracks: Tracks, atUtcMs: number): SurfaceLine[] {
  const sol = roverSol(missions, atUtcMs);
  const lines: SurfaceLine[] = [
    {
      points: tracks.m20.points.filter((p) => p[2] <= sol).map((p) => [p[1], p[0]] as const),
      colourHex: ROUTE_COLOURS.m20,
    },
  ];
  const curiosity = findMission(missions, 'curiosity');
  if (curiosity && atUtcMs >= curiosity.tUtcMs)
    lines.push({ points: tracks.msl.points.map((p) => [p[1], p[0]] as const), colourHex: ROUTE_COLOURS.msl });
  const flights = tracks.heli.filter((f) => f[1] <= sol).map((f) => [f[3], f[2]] as const);
  if (flights.length) lines.push({ points: flights, colourHex: ROUTE_COLOURS.heli, dots: true });
  return lines.filter((l) => l.points.length > 0);
}

// --- Sunlight at a place ---

const DEG = Math.PI / 180;

/** Height of the Sun above flat ground at a place, in degrees, given the point on the planet it is straight above. */
export function sunHeightDeg(latDeg: number, lonDeg: number, subsolarLatDeg: number, subsolarLonDeg: number): number {
  const s =
    Math.sin(latDeg * DEG) * Math.sin(subsolarLatDeg * DEG) +
    Math.cos(latDeg * DEG) * Math.cos(subsolarLatDeg * DEG) * Math.cos((lonDeg - subsolarLonDeg) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}

/** Compass bearing of the Sun from a place, in degrees from north through east, given its subsolar point. */
export function sunAzimuthDeg(latDeg: number, lonDeg: number, subsolarLatDeg: number, subsolarLonDeg: number): number {
  const dLon = (subsolarLonDeg - lonDeg) * DEG;
  const lat = latDeg * DEG;
  const sub = subsolarLatDeg * DEG;
  const east = Math.sin(dLon) * Math.cos(sub);
  const north = Math.cos(lat) * Math.sin(sub) - Math.sin(lat) * Math.cos(sub) * Math.cos(dLon);
  return (((Math.atan2(east, north) / DEG) % 360) + 360) % 360;
}

/** Local mean solar time as hours from 0 to 24: 12 when the Sun is over the place's meridian. */
export function localSolarHours(lonDeg: number, subsolarLonDeg: number): number {
  return (((12 + (lonDeg - subsolarLonDeg) / 15) % 24) + 24) % 24;
}

/** Latitude and longitude of the point a body-fixed vector points at (the subsolar point, for the Sun's vector). */
export function directionToLatLon(v: readonly [number, number, number]): { latDeg: number; lonDeg: number } {
  return { latDeg: Math.asin(v[2] / Math.hypot(...v)) / DEG, lonDeg: Math.atan2(v[1], v[0]) / DEG };
}
