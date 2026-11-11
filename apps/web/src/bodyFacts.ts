import { add, KM_PER_AU, norm, type SolarBodyKey, sub, type Vec3 } from '@siteline/physics';
import bodiesJson from '../../../data/bodies.json';

export const FACT_BODIES = ['Moon', 'Earth', 'Mars'] as const;
export type FactBody = (typeof FACT_BODIES)[number];

/** Where each body sits in the planets table. */
export const TABLE_KEY: Readonly<Record<FactBody, SolarBodyKey>> = { Moon: 'moon', Earth: 'earth', Mars: 'mars' };

/** Exact: the metre is defined as the distance light travels in 1/299 792 458 of a second. */
export const SPEED_OF_LIGHT_KM_S = 299_792.458;

export interface Temperatures {
  meanK?: number;
  /** Coldest to hottest through one day, where the source measured it. */
  rangeK?: readonly [number, number];
  /** The coldest place the source names. */
  coldestK?: number;
}

export interface BodyConstants {
  /** The page in `sources` to link for this body. */
  factSheet: string;
  radiusKm: number;
  gmKm3PerS2: number;
  /** One turn against the stars. */
  rotationH: number;
  /** Sunrise to sunrise. */
  solarDayH: number;
  surfacePressureMbar: number | null;
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

const text = (v: unknown, label: string): string => (typeof v === 'string' && v ? v : bad(`${label} is missing`));

function temperatures(v: unknown, label: string): Temperatures {
  const t = record(v, label);
  const out: Temperatures = {};
  if (t.meanK !== undefined) out.meanK = positive(t.meanK, `${label}.meanK`);
  if (t.coldestK !== undefined) out.coldestK = positive(t.coldestK, `${label}.coldestK`);
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

/** Reads `data/bodies.json`, and refuses a number that names no source or a source that is not listed. */
export function parseBodies(file: unknown): BodiesFile {
  const f = record(file, 'the file');
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
  const bodies = Object.fromEntries(
    FACT_BODIES.map((name) => {
      const b = record(all[name], name);
      const own = record(b.sources, `${name}.sources`);
      const pressure = b.surfacePressureMbar;
      const out: BodyConstants = {
        factSheet: cited([b.factSheet], `${name}.factSheet`)[0],
        radiusKm: positive(b.radiusKm, `${name}.radiusKm`),
        gmKm3PerS2: positive(b.gmKm3PerS2, `${name}.gmKm3PerS2`),
        rotationH: positive(b.rotationH, `${name}.rotationH`),
        solarDayH: positive(b.solarDayH, `${name}.solarDayH`),
        surfacePressureMbar: pressure === null ? null : positive(pressure, `${name}.surfacePressureMbar`),
        temperatureK: temperatures(b.temperatureK, `${name}.temperatureK`),
        sources: Object.fromEntries(Object.entries(own).map(([k, ids]) => [k, cited(ids, `${name}.sources.${k}`)])),
      };
      for (const k of ['radiusKm', 'gmKm3PerS2', 'rotationH', 'solarDayH', 'temperatureK'] as const) {
        if (!out.sources[k]) bad(`${name}.${k} names no source`);
      }
      if (out.surfacePressureMbar !== null && !out.sources.surfacePressureMbar) {
        bad(`${name}.surfacePressureMbar names no source`);
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

/** A turn or a day as hours below three days and as days beyond. */
export function dayLength(hours: number): Measure<'h' | 'd'> {
  return hours < 72 ? { n: hours, unit: 'h', digits: 1 } : { n: hours / 24, unit: 'd', digits: 1 };
}

/** A signal's trip as seconds, minutes or hours, whichever reads best. */
export function signalDelay(seconds: number): Measure<'s' | 'min' | 'h'> {
  if (seconds < 120) return { n: seconds, unit: 's', digits: seconds < 10 ? 2 : 0 };
  if (seconds < 7200) return { n: seconds / 60, unit: 'min', digits: 1 };
  return { n: seconds / 3600, unit: 'h', digits: 1 };
}
