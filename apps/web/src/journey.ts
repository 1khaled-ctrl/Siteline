import {
  cross,
  dot,
  lambert,
  norm,
  type OrbitState,
  propagate,
  type SolarBodyKey,
  sub,
  type Vec3,
} from '@siteline/physics';
import { BODY_CONSTANTS } from './bodyFacts';

/**
 * The "Simulate the journey" trajectory: a real two-body orbit between real positions, simplified on purpose. The
 * Earth-to-Moon leg ignores the Moon's pull and course corrections; the Earth-to-Mars leg ignores the planets' pulls
 * near departure and arrival. Good for seeing the geometry, not for steering a spacecraft.
 */

export const DAY_S = 86_400;
const DAY_MS = DAY_S * 1000;
const HOUR_MS = 3_600_000;

/**
 * Timing modelled on Apollo 11 (NASA's mission timeline): trans-lunar injection 16 July 1969 16:22 UTC, into lunar
 * orbit 19 July 17:21 (about 3 days of coast), landing 20 July 20:17 (about a day in lunar orbit).
 */
export const MOON_COAST_DAYS = 3;
export const MOON_ORBIT_DAYS = 1;
/** Apollo's parking orbit before trans-lunar injection was about 185 km up. */
export const PARKING_ALTITUDE_KM = 185;
/** Trans-lunar injection starts a little short of opposite the Moon's arrival point, where a transfer is cheapest. */
const TLI_LEAD_DEG = 170;
/** The Sun's GM, BODY10_GM in gm_de440.tpc (dataset spice-gm-de440). */
export const SUN_GM_KM3_S2 = 1.3271244004127942e11;
/** Earth-to-Mars times of flight searched for the cheapest launch, in days. */
export const MARS_TOF_DAYS = { min: 120, max: 400, step: 2 } as const;

export type Positions = Readonly<Record<SolarBodyKey, Vec3>>;
/** Where everything is at a moment: the planets from the Sun, the Moon from the Earth (km), as `planetsAt` returns. */
export type PositionsAt = (tUtcMs: number) => Promise<Positions>;

export type XY = readonly [number, number];

export interface CraftSample {
  tUtcMs: number;
  xy: XY;
  speedKmS: number;
  distEarthKm: number;
}

export interface Journey {
  body: 'Moon' | 'Mars';
  departUtcMs: number;
  /** Reaches the Moon (then a day in orbit) or Mars (straight into landing). */
  arriveUtcMs: number;
  landUtcMs: number;
  craft: CraftSample[];
  /** Body tracks over the journey, in the drawing plane, km. The Earth is at the origin in the Moon journey. */
  tracks: Partial<Record<'earth' | 'moon' | 'mars', { tUtcMs: number; xy: XY }[]>>;
  /** Whole orbits for the Mars journey's map. */
  rings: Partial<Record<'earth' | 'mars', XY[]>>;
  /** Unit direction to the Sun, in the drawing plane, for the Moon journey. */
  sunDir?: XY;
  /** Launch energy, km²/s²: v² − 2μ/r after leaving Earth orbit (Moon), or v∞² leaving Earth (Mars). */
  c3Km2S2: number;
  /** Speed relative to Earth just after leaving its orbit (Moon), or relative to Mars on arrival (Mars), km/s. */
  speedKmS: number;
  tofDays: number;
  /** Mars only: yardsticks from the two orbits themselves, to judge the launch energy by. */
  reference?: MarsReference;
}

export interface MarsReference {
  /** C3 of the ideal (Hohmann) transfer between circles of the two orbits' mean radii, km²/s². */
  hohmannC3Km2S2: number;
  /** How often Earth and Mars line up again, so how often launch windows come round, in days. */
  synodicDays: number;
}

/** Hohmann launch energy and synodic period for circular orbits of radii r1 (Earth) and r2 (Mars), in km. */
export function marsReference(r1Km: number, r2Km: number, mu = SUN_GM_KM3_S2): MarsReference {
  const vCircle = Math.sqrt(mu / r1Km);
  const vTransfer = Math.sqrt((2 * mu * r2Km) / (r1Km * (r1Km + r2Km)));
  const period = (r: number) => (2 * Math.PI * Math.sqrt(r ** 3 / mu)) / DAY_S;
  return {
    hohmannC3Km2S2: (vTransfer - vCircle) ** 2,
    synodicDays: 1 / Math.abs(1 / period(r1Km) - 1 / period(r2Km)),
  };
}

/** A launch counts as in a window when it needs no more than this many times the Hohmann energy. */
export const WINDOW_C3_FACTOR = 2.5;

/** A plane to draw in: e1 and e2 span it, n is its normal, so that motion is anticlockwise seen from +n. */
export interface Plane {
  e1: Vec3;
  e2: Vec3;
  n: Vec3;
}

const unit = (v: Vec3): Vec3 => {
  const k = norm(v);
  return [v[0] / k, v[1] / k, v[2] / k];
};

/** The plane of motion of something at `r` moving with `v`, with e1 along `r`. */
export function planeOf(r: Vec3, v: Vec3): Plane {
  const n = unit(cross(r, v));
  const e1 = unit(r);
  return { e1, e2: cross(n, e1), n };
}

export const toPlane = (p: Plane, v: Vec3): Vec3 => [dot(v, p.e1), dot(v, p.e2), dot(v, p.n)];
const xy = (v: Vec3): XY => [v[0], v[1]];

/** Samples a two-body orbit from `start` over `durationS`, in the plane's coordinates. */
function sampleOrbit(
  start: OrbitState,
  durationS: number,
  mu: number,
  t0Ms: number,
  steps: number,
  earthAt: (tMs: number) => Vec3,
): CraftSample[] {
  const out: CraftSample[] = [];
  for (let k = 0; k <= steps; k++) {
    const dt = (durationS * k) / steps;
    const s = k === 0 ? start : propagate(start.rKm, start.vKmS, dt, mu);
    const tUtcMs = t0Ms + dt * 1000;
    out.push({ tUtcMs, xy: xy(s.rKm), speedKmS: norm(s.vKmS), distEarthKm: norm(sub(s.rKm, earthAt(tUtcMs))) });
  }
  return out;
}

/** Linear interpolation along a track by time, for a body between its samples. */
export function trackAt(track: readonly { tUtcMs: number; xy: XY }[], tUtcMs: number): XY {
  if (tUtcMs <= track[0].tUtcMs) return track[0].xy;
  const last = track[track.length - 1];
  if (tUtcMs >= last.tUtcMs) return last.xy;
  let i = 1;
  while (track[i].tUtcMs < tUtcMs) i++;
  const a = track[i - 1];
  const b = track[i];
  const k = (tUtcMs - a.tUtcMs) / (b.tUtcMs - a.tUtcMs);
  return [a.xy[0] + (b.xy[0] - a.xy[0]) * k, a.xy[1] + (b.xy[1] - a.xy[1]) * k];
}

const times = (fromMs: number, toMs: number, stepMs: number) => {
  const out: number[] = [];
  for (let t = fromMs; t < toMs; t += stepMs) out.push(t);
  out.push(toMs);
  return out;
};

/**
 * Earth to the Moon, landing at `landUtcMs`: three days' coast on the two-body orbit (Lambert's problem around the
 * Earth) from a parking orbit to where the Moon will be, then a day in lunar orbit.
 */
export async function moonJourney(landUtcMs: number, at: PositionsAt): Promise<Journey> {
  const arriveUtcMs = landUtcMs - MOON_ORBIT_DAYS * DAY_MS;
  const departUtcMs = arriveUtcMs - MOON_COAST_DAYS * DAY_MS;
  const mu = BODY_CONSTANTS.Earth.gmKm3PerS2;
  const [before, arrive, land] = await Promise.all([at(arriveUtcMs - HOUR_MS), at(arriveUtcMs), at(landUtcMs)]);
  const plane = planeOf(arrive.moon, sub(arrive.moon, before.moon));
  const r2 = toPlane(plane, arrive.moon);
  const rp = BODY_CONSTANTS.Earth.radiusKm + PARKING_ALTITUDE_KM;
  const a = (Math.atan2(r2[1], r2[0]) * 180) / Math.PI - TLI_LEAD_DEG;
  const r1: Vec3 = [rp * Math.cos((a * Math.PI) / 180), rp * Math.sin((a * Math.PI) / 180), 0];
  const tofS = MOON_COAST_DAYS * DAY_S;
  const sol = lambert(r1, r2, tofS, mu);
  if (!sol) throw new Error('no transfer orbit found');

  const moonTimes = times(departUtcMs, landUtcMs, HOUR_MS);
  const moon = await Promise.all(
    moonTimes.map(async (t) => ({ tUtcMs: t, xy: xy(toPlane(plane, (await at(t)).moon)) })),
  );
  const sun = toPlane(plane, [-land.earth[0], -land.earth[1], -land.earth[2]]);
  const sunLen = Math.hypot(sun[0], sun[1]) || 1;
  return {
    body: 'Moon',
    departUtcMs,
    arriveUtcMs,
    landUtcMs,
    craft: sampleOrbit({ rKm: r1, vKmS: sol.v1KmS }, tofS, mu, departUtcMs, 240, () => [0, 0, 0]),
    tracks: { moon, earth: [{ tUtcMs: departUtcMs, xy: [0, 0] }] },
    rings: {},
    sunDir: [sun[0] / sunLen, sun[1] / sunLen],
    c3Km2S2: norm(sol.v1KmS) ** 2 - (2 * mu) / rp,
    speedKmS: norm(sol.v1KmS),
    tofDays: MOON_COAST_DAYS + MOON_ORBIT_DAYS,
  };
}

/** Velocity by a central difference of positions half a day either side, km/s. */
async function velocity(at: PositionsAt, key: 'earth' | 'mars', tMs: number): Promise<Vec3> {
  const [a, b] = await Promise.all([at(tMs - DAY_MS / 2), at(tMs + DAY_MS / 2)]);
  const d = sub(b[key], a[key]);
  return [d[0] / DAY_S, d[1] / DAY_S, d[2] / DAY_S];
}

/** The cheapest launch, by launch energy C3, for each time of flight in the search; arrival is the landing. */
export async function marsJourney(
  landUtcMs: number,
  at: PositionsAt,
  orbits: Partial<Record<'earth' | 'mars', Float32Array>>,
  earliestUtcMs: number,
): Promise<Journey> {
  const [arrive, vMars] = await Promise.all([at(landUtcMs), velocity(at, 'mars', landUtcMs)]);
  const start = await at(landUtcMs - MARS_TOF_DAYS.min * DAY_MS);
  const plane = planeOf(start.earth, await velocity(at, 'earth', landUtcMs - MARS_TOF_DAYS.min * DAY_MS));
  const rMars = toPlane(plane, arrive.mars);
  let best: { tofDays: number; rE: Vec3; vE: Vec3; v1: Vec3; v2: Vec3; c3: number } | undefined;
  for (let tof = MARS_TOF_DAYS.min; tof <= MARS_TOF_DAYS.max; tof += MARS_TOF_DAYS.step) {
    const departMs = landUtcMs - tof * DAY_MS;
    if (departMs - DAY_MS / 2 < earliestUtcMs) break;
    const [dep, vEarth] = await Promise.all([at(departMs), velocity(at, 'earth', departMs)]);
    const rE = toPlane(plane, dep.earth);
    const vE = toPlane(plane, vEarth);
    const sol = lambert(rE, rMars, tof * DAY_S, SUN_GM_KM3_S2);
    if (!sol) continue;
    const c3 = norm(sub(sol.v1KmS, vE)) ** 2;
    if (!best || c3 < best.c3) best = { tofDays: tof, rE, vE, v1: sol.v1KmS, v2: sol.v2KmS, c3 };
  }
  if (!best) throw new Error('no transfer orbit found within the dates the planets table covers');

  const departUtcMs = landUtcMs - best.tofDays * DAY_MS;
  const dayTimes = times(departUtcMs, landUtcMs, DAY_MS);
  const days = await Promise.all(dayTimes.map(at));
  const track = (key: 'earth' | 'mars') =>
    days.map((p, i) => ({ tUtcMs: dayTimes[i], xy: xy(toPlane(plane, p[key])) }));
  const earth = track('earth');
  const earth3 = days.map((p) => toPlane(plane, p.earth));
  const earthAt = (tMs: number): Vec3 => {
    const i = Math.min(earth3.length - 1, Math.max(0, Math.round((tMs - departUtcMs) / DAY_MS)));
    return earth3[i];
  };
  const ring = (flat: Float32Array | undefined): XY[] => {
    const out: XY[] = [];
    if (!flat) return out;
    for (let i = 0; i + 2 < flat.length; i += 3) out.push(xy(toPlane(plane, [flat[i], flat[i + 1], flat[i + 2]])));
    return out;
  };
  const rings = { earth: ring(orbits.earth), mars: ring(orbits.mars) };
  // Mean radii from the whole orbits where we have them, else from the journey's own stretch of them.
  const meanRadius = (path: readonly XY[]) => path.reduce((sum, p) => sum + Math.hypot(p[0], p[1]), 0) / path.length;
  const radius = (key: 'earth' | 'mars') =>
    meanRadius(rings[key].length ? rings[key] : (key === 'earth' ? earth : track('mars')).map((p) => p.xy));
  return {
    body: 'Mars',
    departUtcMs,
    arriveUtcMs: landUtcMs,
    landUtcMs,
    craft: sampleOrbit({ rKm: best.rE, vKmS: best.v1 }, best.tofDays * DAY_S, SUN_GM_KM3_S2, departUtcMs, 300, earthAt),
    tracks: { earth, mars: track('mars') },
    rings,
    c3Km2S2: best.c3,
    speedKmS: norm(sub(best.v2, toPlane(plane, vMars))),
    tofDays: best.tofDays,
    reference: marsReference(radius('earth'), radius('mars')),
  };
}
