import { KM_PER_AU, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import { BODY_CONSTANTS } from './bodyFacts';
import {
  DAY_S,
  MOON_COAST_DAYS,
  MOON_ORBIT_DAYS,
  marsJourney,
  marsReference,
  moonJourney,
  type Positions,
} from './journey';

const DAY_MS = DAY_S * 1000;
const LAND = Date.parse('2028-04-08T00:00:00Z');
const circle = (radius: number, periodDays: number, phase: number, tMs: number): Vec3 => {
  const a = phase + (2 * Math.PI * (tMs - LAND)) / (periodDays * DAY_MS);
  return [radius * Math.cos(a), radius * Math.sin(a), 0];
};
const ZERO: Vec3 = [0, 0, 0];

/** A made-up ephemeris of circular, coplanar orbits, so the answers can be checked by hand. */
function fakeSky(marsPhase: number) {
  return async (tMs: number): Promise<Positions> =>
    ({
      mercury: ZERO,
      venus: ZERO,
      earth: circle(KM_PER_AU, 365.25, 0, tMs),
      mars: circle(1.524 * KM_PER_AU, 687, marsPhase, tMs),
      jupiter: ZERO,
      saturn: ZERO,
      uranus: ZERO,
      neptune: ZERO,
      moon: circle(384_400, 27.32, 0, tMs),
    }) as Record<SolarBodyKey, Vec3>;
}

describe('moonJourney', () => {
  it('leaves a parking orbit, coasts for the set days and meets the Moon where it will be', async () => {
    const j = await moonJourney(LAND, fakeSky(0));
    expect(j.landUtcMs).toBe(LAND);
    expect(j.arriveUtcMs).toBe(LAND - MOON_ORBIT_DAYS * DAY_MS);
    expect(j.departUtcMs).toBe(j.arriveUtcMs - MOON_COAST_DAYS * DAY_MS);
    const first = j.craft[0];
    const last = j.craft[j.craft.length - 1];
    expect(Math.hypot(...first.xy)).toBeCloseTo(BODY_CONSTANTS.Earth.radiusKm + 185, 0);
    expect(last.tUtcMs).toBeCloseTo(j.arriveUtcMs, -1);
    expect(last.distEarthKm).toBeCloseTo(384_400, -1);
  });

  it('needs the speed and energy of a real trans-lunar injection: about 10.9 km/s, C3 a little below zero', async () => {
    const j = await moonJourney(LAND, fakeSky(0));
    expect(j.speedKmS).toBeGreaterThan(10.7);
    expect(j.speedKmS).toBeLessThan(11.1);
    expect(j.c3Km2S2).toBeLessThan(0);
    expect(j.c3Km2S2).toBeGreaterThan(-3);
  });
});

describe('marsJourney', () => {
  // Mars placed 180° from Earth's position 259 days before landing: the geometry of a Hohmann transfer.
  const hohmannDays = 259;
  const earthAtLaunch = (2 * Math.PI * -hohmannDays) / 365.25;
  const sky = fakeSky(earthAtLaunch + Math.PI);

  it('finds a launch near the Hohmann time and energy for a well-timed landing', async () => {
    const j = await marsJourney(LAND, sky, {}, Number.NEGATIVE_INFINITY);
    expect(Math.abs(j.tofDays - hohmannDays)).toBeLessThan(30);
    // A Hohmann transfer from 1 to 1.524 AU needs about 2.94 km/s past Earth's escape, C3 about 8.7 km²/s².
    expect(j.c3Km2S2).toBeGreaterThan(8);
    expect(j.c3Km2S2).toBeLessThan(12);
    expect(j.departUtcMs).toBe(LAND - j.tofDays * DAY_MS);
    const last = j.craft[j.craft.length - 1];
    expect(Math.hypot(...last.xy) / KM_PER_AU).toBeCloseTo(1.524, 3);
  });

  it('judges launch energy against the Hohmann transfer and the synodic period of the two orbits', () => {
    const ref = marsReference(KM_PER_AU, 1.524 * KM_PER_AU);
    // Textbook values for 1 and 1.524 AU: v∞ about 2.94 km/s, so C3 about 8.7 km²/s²; Earth and Mars line up every 780 days.
    expect(ref.hohmannC3Km2S2).toBeGreaterThan(8.5);
    expect(ref.hohmannC3Km2S2).toBeLessThan(8.9);
    expect(ref.synodicDays).toBeGreaterThan(770);
    expect(ref.synodicDays).toBeLessThan(790);
  });

  it('never launches before the ephemeris starts', async () => {
    const earliest = LAND - 200 * DAY_MS;
    const j = await marsJourney(LAND, sky, {}, earliest);
    expect(j.departUtcMs).toBeGreaterThanOrEqual(earliest);
  });
});
