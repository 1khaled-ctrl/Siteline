import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KM_PER_AU, parsePlanets, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import bodiesJson from '../../../data/bodies.json';
import {
  BODY_CONSTANTS,
  dayLength,
  distancesOf,
  escapeSpeedKmS,
  FACT_BODIES,
  kelvinToCelsius,
  lightTimeS,
  parseBodies,
  SOLAR_CONSTANT_W_M2,
  signalDelay,
  sunlightWM2,
  surfaceGravityMS2,
} from './bodyFacts';

const tablePath = fileURLToPath(new URL('../../../pipeline/out/ephemeris/planets.bin', import.meta.url));

/** The published figures on NASA's Moon, Earth and Mars fact sheets (read 2026-11-11), to the digits they print. */
const NASA = {
  Moon: { gravity: 1.62, escapeKmS: 2.38 },
  Earth: { gravity: 9.82, escapeKmS: 11.186 },
  Mars: { gravity: 3.73, escapeKmS: 5.03 },
} as const;

describe('data/bodies.json', () => {
  it('has every number for the Moon, Earth and Mars, each with a source that is listed', () => {
    const file = parseBodies(bodiesJson);
    for (const name of FACT_BODIES) {
      expect(file.bodies[name].radiusKm).toBeGreaterThan(1000);
      expect(file.sources[file.bodies[name].factSheet]?.[1]).toMatch(/^https:\/\/nssdc\.gsfc\.nasa\.gov\//);
    }
  });

  it('refuses a number that names no source, a source that is not listed, and a value that is not positive', () => {
    const copy = (): { bodies: { Mars: Record<string, unknown> } } => structuredClone(bodiesJson) as never;
    const noSource = copy();
    Reflect.deleteProperty(noSource.bodies.Mars.sources as object, 'gmKm3PerS2');
    expect(() => parseBodies(noSource)).toThrow(/Mars.gmKm3PerS2 names no source/);
    const unlisted = copy();
    (unlisted.bodies.Mars.sources as Record<string, unknown>).rotationH = ['nasaVenus'];
    expect(() => parseBodies(unlisted)).toThrow(/cites nasaVenus/);
    const negative = copy();
    negative.bodies.Mars.radiusKm = -3389.5;
    expect(() => parseBodies(negative)).toThrow(/Mars.radiusKm is not a positive number/);
    const backwards = copy();
    backwards.bodies.Mars.temperatureK = { rangeK: [242, 184] };
    expect(() => parseBodies(backwards)).toThrow(/does not run from cold to hot/);
  });
});

describe('surface gravity and escape speed', () => {
  it.each(FACT_BODIES)('match the figures NASA prints for the %s', (name) => {
    const { gmKm3PerS2, radiusKm } = BODY_CONSTANTS[name];
    // Printed to two or three decimals, so half a unit in the last place is the most they can differ by.
    expect(surfaceGravityMS2(gmKm3PerS2, radiusKm)).toBeCloseTo(NASA[name].gravity, 2);
    expect(escapeSpeedKmS(gmKm3PerS2, radiusKm)).toBeCloseTo(NASA[name].escapeKmS, 2);
  });

  it('turn km³/s² and km into m/s² and km/s with the right powers', () => {
    // GM = 1 km³/s² on a 1 km sphere: 1 km/s² is 1000 m/s², and sqrt(2) km/s to leave.
    expect(surfaceGravityMS2(1, 1)).toBe(1000);
    expect(escapeSpeedKmS(1, 1)).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('sunlight and signal delay', () => {
  it("give NASA's mean sunlight on Mars, 586.2 W/m², at its mean distance of 1.52368 AU", () => {
    expect(sunlightWM2(SOLAR_CONSTANT_W_M2, 1)).toBe(1361);
    expect(sunlightWM2(SOLAR_CONSTANT_W_M2, 1.52368)).toBeCloseTo(586.2, 0);
  });

  it("take light 499.005 s to cross an astronomical unit and 1.28 s to cross the Moon's mean distance", () => {
    expect(lightTimeS(KM_PER_AU)).toBeCloseTo(499.0048, 3);
    expect(lightTimeS(384_400)).toBeCloseTo(1.28, 2);
  });

  it("reads Mars at NASA's closest and farthest from Earth as about 3 and 22 minutes", () => {
    const near = signalDelay(lightTimeS(54.6e6));
    const far = signalDelay(lightTimeS(401.4e6));
    expect([near.unit, far.unit]).toEqual(['min', 'min']);
    expect(near.n).toBeCloseTo(3.0, 1);
    expect(far.n).toBeCloseTo(22.3, 1);
  });

  it('picks seconds, minutes or hours, and hours or days, at the size where each reads best', () => {
    expect(signalDelay(1.28)).toMatchObject({ unit: 's', digits: 2 });
    expect(signalDelay(45)).toMatchObject({ unit: 's', digits: 0 });
    expect(signalDelay(624.5)).toMatchObject({ unit: 'min' });
    expect(signalDelay(7200)).toMatchObject({ unit: 'h', n: 2 });
    expect(dayLength(24.6229)).toMatchObject({ unit: 'h' });
    // The Moon's turn and sunrise-to-sunrise: NASA's 27.3217 and 29.53 days.
    expect(dayLength(BODY_CONSTANTS.Moon.rotationH).n).toBeCloseTo(27.3217, 3);
    expect(dayLength(BODY_CONSTANTS.Moon.solarDayH).unit).toBe('d');
    expect(dayLength(BODY_CONSTANTS.Moon.solarDayH).n).toBeCloseTo(29.53, 10);
  });
});

describe('temperatures', () => {
  it('convert to the Celsius figures NASA prints beside its kelvin ones', () => {
    const round = (k: number | undefined) => Math.round(kelvinToCelsius(k ?? Number.NaN));
    expect(round(BODY_CONSTANTS.Earth.temperatureK.meanK)).toBe(15);
    expect(round(BODY_CONSTANTS.Mars.temperatureK.meanK)).toBe(-59);
    expect(BODY_CONSTANTS.Mars.temperatureK.rangeK?.map(round)).toEqual([-89, -31]);
    // The Moon's sheet prints 95 K to 390 K with only Fahrenheit beside it: about -290 F to +240 F.
    const tens = (k: number) => Math.round(((kelvinToCelsius(k) * 9) / 5 + 32) / 10) * 10;
    expect(BODY_CONSTANTS.Moon.temperatureK.rangeK?.map(tens)).toEqual([-290, 240]);
  });
});

describe('distancesOf', () => {
  const at = (o: Partial<Record<SolarBodyKey, Vec3>>): Record<SolarBodyKey, Vec3> => ({
    mercury: [0, 0, 0],
    venus: [0, 0, 0],
    earth: [KM_PER_AU, 0, 0],
    mars: [0, 1.5 * KM_PER_AU, 0],
    jupiter: [0, 0, 0],
    saturn: [0, 0, 0],
    uranus: [0, 0, 0],
    neptune: [0, 0, 0],
    moon: [0, 384_400, 0],
    ...o,
  });

  it('measures the Earth from the Sun, the Moon from the Earth (as the Sun sees it) and Mars from both', () => {
    const p = at({});
    expect(distancesOf('sun', p)).toEqual({ sunDistAu: 0, earthDistKm: KM_PER_AU });
    expect(distancesOf('earth', p)).toEqual({ sunDistAu: 1, earthDistKm: null });
    const moon = distancesOf('moon', p);
    expect(moon.earthDistKm).toBe(384_400);
    // The Moon sits beside the Earth, so it is only a hair further out than 1 AU.
    expect(moon.sunDistAu).toBeCloseTo(Math.hypot(1, 384_400 / KM_PER_AU), 12);
    const mars = distancesOf('mars', p);
    expect(mars.sunDistAu).toBe(1.5);
    expect(mars.earthDistKm).toBeCloseTo(Math.hypot(1, 1.5) * KM_PER_AU, 3);
  });

  // JPL Horizons for 2026-11-22 12:00 UT: Mars 1.616031 AU from the Sun and 1.251436 AU (10.4079 light-minutes) from the
  // Earth; the Moon 0.00246683 AU (1.2310 light-seconds) from the Earth; the Earth 0.987698 AU from the Sun.
  describe.skipIf(!existsSync(tablePath))('against the real planets table', () => {
    const file = readFileSync(tablePath);
    const table = parsePlanets(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const p = table.snapshot(Date.UTC(2026, 10, 22, 12));

    it('puts Mars, the Moon and the Earth where JPL Horizons does', () => {
      const mars = distancesOf('mars', p);
      expect(mars.sunDistAu).toBeCloseTo(1.616031, 3);
      expect((mars.earthDistKm ?? 0) / KM_PER_AU).toBeCloseTo(1.251436, 3);
      expect(lightTimeS(mars.earthDistKm ?? 0) / 60).toBeCloseTo(10.40788, 1);
      const moon = distancesOf('moon', p);
      expect((moon.earthDistKm ?? 0) / KM_PER_AU).toBeCloseTo(0.00246683, 6);
      expect(lightTimeS(moon.earthDistKm ?? 0)).toBeCloseTo(1.231, 2);
      expect(distancesOf('earth', p).sunDistAu).toBeCloseTo(0.987698, 4);
      // The Sun seen from the Earth: Horizons gives 8.21443 light-minutes.
      expect(lightTimeS(distancesOf('sun', p).earthDistKm ?? 0) / 60).toBeCloseTo(8.2144, 2);
      // The Moon's own distance from the Sun (Horizons "r"), which adds its offset from the Earth.
      expect(moon.sunDistAu).toBeCloseTo(0.989846, 4);
    });
  });
});
