import { add, KM_PER_AU, norm, type SolarBodyKey, sub, type Vec3 } from '@siteline/physics';
import bodiesJson from '../../../data/bodies.json';

export const FACT_BODIES = [
  'Mercury',
  'Venus',
  'Earth',
  'Moon',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
] as const;
export type FactBody = (typeof FACT_BODIES)[number];

/** Where each body sits in the planets table. */
export const TABLE_KEY: Readonly<Record<FactBody, SolarBodyKey>> = {
  Mercury: 'mercury',
  Venus: 'venus',
  Earth: 'earth',
  Moon: 'moon',
  Mars: 'mars',
  Jupiter: 'jupiter',
  Saturn: 'saturn',
  Uranus: 'uranus',
  Neptune: 'neptune',
};

/** Exact: the metre is defined as the distance light travels in 1/299 792 458 of a second. */
export const SPEED_OF_LIGHT_KM_S = 299_792.458;

export interface Temperatures {
  meanK?: number;
  /** Coldest to hottest through one day, where the source measured it. */
  rangeK?: readonly [number, number];
  /** The coldest place the source names. */
  coldestK?: number;
  /** For a body with no solid surface, the only temperature it has: the one at the pressure level `levelBar` names. */
  atLevelK?: number;
}

export interface BodyConstants {
  /** The page in `sources` to link for this body. */
  factSheet: string;
  /** Volumetric mean radius. */
  radiusKm: number;
  /** For a body with no solid surface: the equatorial radius at `levelBar`, the one NASA's escape velocity uses. */
  equatorialRadiusKm?: number;
  gmKm3PerS2: number;
  /** One turn against the stars, as NASA prints it: negative for a retrograde spin. */
  rotationH: number;
  /** Sunrise to sunrise. Always positive. */
  solarDayH: number;
  /** The spin axis's tilt to the orbit, 0° to 180°; past 90° the body spins backwards. */
  obliquityDeg: number;
  /** Null where there is no solid surface, or where the source gives only a trace exosphere. */
  surfacePressureMbar: number | null;
  /** 'none' for a giant planet: its numbers are given at a pressure level (`levelBar`), never on a surface. */
  surface?: 'none';
  /** For a body with no solid surface: the pressure level, in bar, its temperature and equatorial radius are given at. */
  levelBar?: number;
  temperatureK: Temperatures;
  /** For each number above, the ids in `sources` it was read from. */
  sources: Readonly<Record<string, readonly string[]>>;
}

export interface BodiesFile {
  sources: Readonly<Record<string, readonly [label: string, url: string]>>;
  solarConstant: { wM2: number; source: string };
  bodies: Readonly<Record<FactBody, BodyConstants>>;
}

// A declaration, not an arrow function: only a declared `never` lets the checker see that the lines after a `bad` call
// are reached only when its test passed.
function bad(what: string): never {
  throw new Error(`data/bodies.json: ${what}`);
}

const record = (v: unknown, label: string): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : bad(`${label} is missing`);

const positive = (v: unknown, label: string): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : bad(`${label} is not a positive number`);

const nonZero = (v: unknown, label: string): number =>
  typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : bad(`${label} is not a non-zero number`);

const angle = (v: unknown, label: string): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 180
    ? v
    : bad(`${label} is not an angle from 0° to 180°`);

const text = (v: unknown, label: string): string => (typeof v === 'string' && v ? v : bad(`${label} is missing`));

/** Refuses a key `known` does not hold: a misspelt or unread field would otherwise slip past every check. */
function onlyKnown(v: Record<string, unknown>, known: ReadonlySet<string>, label: string) {
  for (const k of Object.keys(v)) if (!known.has(k)) bad(`${label}${k} is not a field this file knows`);
}

const FILE_KEYS = new Set(['note', 'sources', 'solarConstant', 'bodies']);
const TEMPERATURE_KEYS = new Set(['meanK', 'rangeK', 'coldestK', 'atLevelK']);
/** A body's fields that hold numbers: each one it has must name its source. */
const NUMBER_FIELDS = [
  'radiusKm',
  'equatorialRadiusKm',
  'gmKm3PerS2',
  'rotationH',
  'solarDayH',
  'obliquityDeg',
  'surfacePressureMbar',
  'levelBar',
  'temperatureK',
] as const;
const BODY_KEYS = new Set<string>([...NUMBER_FIELDS, 'factSheet', 'surface', 'sources']);

function temperatures(v: unknown, label: string): Temperatures {
  const t = record(v, label);
  onlyKnown(t, TEMPERATURE_KEYS, `${label}.`);
  const out: Temperatures = {};
  if (t.meanK !== undefined) out.meanK = positive(t.meanK, `${label}.meanK`);
  if (t.coldestK !== undefined) out.coldestK = positive(t.coldestK, `${label}.coldestK`);
  if (t.atLevelK !== undefined) out.atLevelK = positive(t.atLevelK, `${label}.atLevelK`);
  if (t.rangeK !== undefined) {
    const r = t.rangeK;
    if (!Array.isArray(r) || r.length !== 2) bad(`${label}.rangeK is not a pair`);
    const [low, high] = [positive(r[0], `${label}.rangeK[0]`), positive(r[1], `${label}.rangeK[1]`)];
    if (low >= high) bad(`${label}.rangeK does not run from cold to hot`);
    out.rangeK = [low, high];
  }
  if (Object.keys(out).length === 0) bad(`${label} holds no temperature`);
  return out;
}

/**
 * Reads `data/bodies.json`, and refuses a number that names no source, a source that is not listed, and a field, body
 * or part of the file it does not know.
 */
export function parseBodies(file: unknown): BodiesFile {
  const f = record(file, 'the file');
  onlyKnown(f, FILE_KEYS, '');
  const sources = Object.fromEntries(
    Object.entries(record(f.sources, 'sources')).map(([id, v]) => {
      const pair = Array.isArray(v) ? v : [];
      return [id, [text(pair[0], `sources.${id} label`), text(pair[1], `sources.${id} link`)] as const];
    }),
  );
  const cited = (ids: unknown, label: string): string[] => {
    if (!Array.isArray(ids) || ids.length === 0) bad(`${label} names no source`);
    return (ids as unknown[]).map((id) => (typeof id === 'string' && sources[id] ? id : bad(`${label} cites ${id}`)));
  };

  const sun = record(f.solarConstant, 'solarConstant');
  const solarConstant = {
    wM2: positive(sun.wM2, 'solarConstant.wM2'),
    source: cited([sun.source], 'solarConstant')[0],
  };

  const all = record(f.bodies, 'bodies');
  onlyKnown(all, new Set<string>(FACT_BODIES), 'bodies.');
  const bodies = Object.fromEntries(
    FACT_BODIES.map((name) => {
      const b = record(all[name], name);
      onlyKnown(b, BODY_KEYS, `${name}.`);
      const own = record(b.sources, `${name}.sources`);
      onlyKnown(own, new Set<string>(NUMBER_FIELDS), `${name}.sources.`);
      const pressure = b.surfacePressureMbar;
      const out: BodyConstants = {
        factSheet: cited([b.factSheet], `${name}.factSheet`)[0],
        radiusKm: positive(b.radiusKm, `${name}.radiusKm`),
        gmKm3PerS2: positive(b.gmKm3PerS2, `${name}.gmKm3PerS2`),
        // NASA prints a retrograde spin as a negative period, and so do we; a length of day is never negative.
        rotationH: nonZero(b.rotationH, `${name}.rotationH`),
        solarDayH: positive(b.solarDayH, `${name}.solarDayH`),
        obliquityDeg: angle(b.obliquityDeg, `${name}.obliquityDeg`),
        surfacePressureMbar: pressure === null ? null : positive(pressure, `${name}.surfacePressureMbar`),
        temperatureK: temperatures(b.temperatureK, `${name}.temperatureK`),
        sources: Object.fromEntries(Object.entries(own).map(([k, ids]) => [k, cited(ids, `${name}.sources.${k}`)])),
      };
      if (b.surface !== undefined) {
        // A giant planet: no solid surface, so nothing may be given as if it had one.
        if (b.surface !== 'none') bad(`${name}.surface can only be "none"`);
        out.surface = 'none';
        out.levelBar = positive(b.levelBar, `${name}.levelBar`);
        out.equatorialRadiusKm = positive(b.equatorialRadiusKm, `${name}.equatorialRadiusKm`);
        if (out.surfacePressureMbar !== null) bad(`${name} has no surface, so it has no surface pressure`);
        const { atLevelK, ...onSurface } = out.temperatureK;
        if (atLevelK === undefined) bad(`${name} has no surface, so its temperature is the one at its levelBar`);
        if (Object.keys(onSurface).length > 0) bad(`${name} has no surface, so it has no surface temperatures`);
      } else {
        for (const k of ['levelBar', 'equatorialRadiusKm'] as const) {
          if (b[k] !== undefined) bad(`${name}.${k} is only for a body with no surface`);
        }
        if (out.temperatureK.atLevelK !== undefined) {
          bad(`${name}.temperatureK.atLevelK is only for a body with no surface`);
        }
      }
      for (const k of NUMBER_FIELDS) {
        if (b[k] !== undefined && b[k] !== null && !out.sources[k]) bad(`${name}.${k} names no source`);
      }
      return [name, out];
    }),
  ) as Record<FactBody, BodyConstants>;

  return { sources, solarConstant, bodies };
}

const file = parseBodies(bodiesJson);
export const BODY_CONSTANTS: Readonly<Record<FactBody, BodyConstants>> = file.bodies;
export const SOLAR_CONSTANT_W_M2 = file.solarConstant.wM2;
export const FACT_SOURCES = file.sources;

/** Gravity at the surface of a sphere, in m/s²: GM over R squared, with GM in km³/s² and R in km. */
export const surfaceGravityMS2 = (gmKm3PerS2: number, radiusKm: number): number => (gmKm3PerS2 / radiusKm ** 2) * 1000;

/** The speed that leaves the surface for good, in km/s, ignoring any air: the square root of 2 GM over R. */
export const escapeSpeedKmS = (gmKm3PerS2: number, radiusKm: number): number => Math.sqrt((2 * gmKm3PerS2) / radiusKm);

/**
 * A body's escape speed as its NASA sheet works it out: from the mean radius, or for a giant planet from its equatorial
 * radius at the 1 bar level (Jupiter: 59.5 km/s, where its mean radius would give 60.2). For Mercury this gives 4.25
 * km/s, where its sheet prints 4.3.
 */
export const bodyEscapeSpeedKmS = (c: BodyConstants): number =>
  escapeSpeedKmS(c.gmKm3PerS2, c.equatorialRadiusKm ?? c.radiusKm);

/** Sunlight on a surface facing the Sun, in W/m²: the solar constant spread over the square of the Sun distance. */
export const sunlightWM2 = (solarConstantWM2: number, sunDistAu: number): number => solarConstantWM2 / sunDistAu ** 2;

export const lightTimeS = (distKm: number): number => distKm / SPEED_OF_LIGHT_KM_S;

export const kelvinToCelsius = (kelvin: number): number => kelvin - 273.15;

export interface Distances {
  /** Zero for the Sun itself. */
  sunDistAu: number;
  /** Null for the Earth itself. */
  earthDistKm: number | null;
}

/** How far the Sun, a planet or the Moon is from the Sun and from the Earth, from the planets table's positions in km. */
export function distancesOf(body: SolarBodyKey | 'sun', positionsKm: Readonly<Record<SolarBodyKey, Vec3>>): Distances {
  const { earth, moon } = positionsKm;
  // The table is centred on the Sun, so the Earth's own position is the Sun's distance from it.
  if (body === 'sun') return { sunDistAu: 0, earthDistKm: norm(earth) };
  if (body === 'earth') return { sunDistAu: norm(earth) / KM_PER_AU, earthDistKm: null };
  // The table holds the Moon as seen from the Earth, so the Sun sees it at the Earth's place plus that.
  if (body === 'moon') return { sunDistAu: norm(add(earth, moon)) / KM_PER_AU, earthDistKm: norm(moon) };
  const from = positionsKm[body];
  return { sunDistAu: norm(from) / KM_PER_AU, earthDistKm: norm(sub(from, earth)) };
}

export interface Measure<U extends string> {
  n: number;
  unit: U;
  /** Decimal places that read well for this size. */
  digits: number;
}

/**
 * A turn or a day as hours below three days and as days beyond. A retrograde turn (a negative `rotationH`) reads as its
 * length; the card says "retrograde" beside it.
 */
export function dayLength(hours: number): Measure<'h' | 'd'> {
  const h = Math.abs(hours);
  return h < 72 ? { n: h, unit: 'h', digits: 1 } : { n: h / 24, unit: 'd', digits: 1 };
}

/** A signal's trip as seconds, minutes or hours, whichever reads best. */
export function signalDelay(seconds: number): Measure<'s' | 'min' | 'h'> {
  if (seconds < 120) return { n: seconds, unit: 's', digits: seconds < 10 ? 2 : 0 };
  if (seconds < 7200) return { n: seconds / 60, unit: 'min', digits: 1 };
  return { n: seconds / 3600, unit: 'h', digits: 1 };
}
