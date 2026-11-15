import type { SolarBodyKey, Vec3 } from '@siteline/physics';
import {
  BODY_CONSTANTS,
  bodyEscapeSpeedKmS,
  distancesOf,
  FACT_BODY_OF,
  kelvinToCelsius,
  lightTimeS,
  surfaceGravityMS2,
} from './bodyFacts';
import { DAY_S, MOON_COAST_DAYS, marsReference, SUN_GM_KM3_S2 } from './journey';

/**
 * General questions about the solar system, answered from SiteLine's own data: where every planet and the Moon are on
 * the date shown (DE440 positions), how long a signal takes, how long the cheapest trip would take, and NASA's fact
 * sheet numbers for the Moon and every planet, worked out as the facts card works them out. Nothing here is typed in by hand.
 */

export const SPACE_BODIES = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
] as const;
export type SpaceBody = (typeof SPACE_BODIES)[number];
export const isSpaceBody = (v: unknown): v is SpaceBody =>
  typeof v === 'string' && (SPACE_BODIES as readonly string[]).includes(v);

/**
 * Time of flight of the ideal (Hohmann) transfer between circular orbits of radii r1 and r2 around the Sun: half the
 * period of the ellipse that touches both. A textbook lower bound on energy, not a mission plan.
 */
export function hohmannTransferDays(r1Km: number, r2Km: number, mu = SUN_GM_KM3_S2): number {
  const a = (r1Km + r2Km) / 2;
  return (Math.PI * Math.sqrt(a ** 3 / mu)) / DAY_S;
}

const norm = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
/** Three significant figures: the precision a distance that changes by the hour is worth saying. */
const sig3 = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(3)));
const one = (v: number) => Math.round(v * 10) / 10;

export interface SpaceFacts {
  body: SpaceBody;
  atUtc: string;
  distanceFromEarthKm: number | null;
  distanceFromSunAu: number | null;
  /** How long light or a radio signal takes from Earth, one way. */
  signalFromEarth: { seconds: number; minutes: number } | null;
  travel:
    | { kind: 'moon'; coastDays: number; basis: string }
    | {
        kind: 'transfer';
        idealTransferDays: number;
        /** The same, in years, when it is long enough that years are what a person would say. */
        idealTransferYears: number | null;
        launchWindowsEveryDays: number;
        basis: string;
      }
    | null;
  physical: {
    radiusKm: number;
    /** False for the giant planets: their gravity and temperature are given at a pressure level, not on a surface. */
    solidSurface: boolean;
    /** At the surface, or for a giant at the volumetric mean radius, as the facts card shows it. */
    gravityMS2: number;
    escapeSpeedKmS: number;
    solarDayHours: number;
    axialTiltDeg: number;
    meanTemperatureC: number | null;
    temperatureRangeC: [number, number] | null;
    /** For a giant: the temperature at the pressure level NASA gives it at. */
    temperatureAtLevel: { celsius: number; bar: number } | null;
    surfacePressureMbar: number | null;
  } | null;
  sources: string[];
}

/** What SiteLine can say about a body on a date, from the planets table's positions (km) at that time. */
export function spaceFacts(
  body: SpaceBody,
  positionsKm: Readonly<Record<SolarBodyKey, Vec3>>,
  atUtc: string,
): SpaceFacts {
  const d = distancesOf(body, positionsKm);
  const sources = ['spice-de440s'];
  const earthR = norm(positionsKm.earth);

  let travel: SpaceFacts['travel'] = null;
  if (body === 'moon') {
    travel = {
      kind: 'moon',
      coastDays: MOON_COAST_DAYS,
      basis: "Apollo 11's coast from leaving Earth orbit to entering lunar orbit (NASA mission timeline)",
    };
  } else if (body !== 'sun' && body !== 'earth') {
    const r2 = norm(positionsKm[body]);
    const days = hohmannTransferDays(earthR, r2);
    travel = {
      kind: 'transfer',
      idealTransferDays: Math.round(days),
      idealTransferYears: days >= 365.25 ? Math.round((days / 365.25) * 10) / 10 : null,
      launchWindowsEveryDays: Math.round(marsReference(earthR, r2).synodicDays),
      basis:
        "ideal minimum-energy (Hohmann) transfer between circular orbits at today's distances from the Sun; real missions differ, and outer planets usually use gravity assists",
    };
    sources.push('spice-gm-de440');
  }

  let physical: SpaceFacts['physical'] = null;
  if (body !== 'sun') {
    const c = BODY_CONSTANTS[FACT_BODY_OF[body]];
    const escapeKmS = bodyEscapeSpeedKmS(c);
    const t = c.temperatureK;
    physical = {
      radiusKm: c.radiusKm,
      solidSurface: c.surface !== 'none',
      gravityMS2: Math.round(surfaceGravityMS2(c.gmKm3PerS2, c.radiusKm) * 100) / 100,
      // Three significant figures, as NASA prints them and the facts card shows them.
      escapeSpeedKmS: escapeKmS >= 10 ? one(escapeKmS) : Math.round(escapeKmS * 100) / 100,
      solarDayHours: one(c.solarDayH),
      axialTiltDeg: one(c.obliquityDeg),
      temperatureAtLevel:
        t.atLevelK === undefined ? null : { celsius: Math.round(kelvinToCelsius(t.atLevelK)), bar: c.levelBar ?? 1 },
      meanTemperatureC: c.temperatureK.meanK === undefined ? null : Math.round(kelvinToCelsius(c.temperatureK.meanK)),
      temperatureRangeC: c.temperatureK.rangeK
        ? [Math.round(kelvinToCelsius(c.temperatureK.rangeK[0])), Math.round(kelvinToCelsius(c.temperatureK.rangeK[1]))]
        : null,
      surfacePressureMbar: c.surfacePressureMbar,
    };
    sources.push('body-facts');
  }

  const km = d.earthDistKm;
  return {
    body,
    atUtc,
    distanceFromEarthKm: km === null ? null : body === 'moon' ? Math.round(km) : sig3(km),
    distanceFromSunAu: body === 'sun' ? null : Math.round(d.sunDistAu * 100) / 100,
    signalFromEarth: km === null ? null : { seconds: one(lightTimeS(km)), minutes: one(lightTimeS(km) / 60) },
    travel,
    physical,
    sources,
  };
}
