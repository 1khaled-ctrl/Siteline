import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KM_PER_AU, parsePlanets, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import bodiesJson from '../../../data/bodies.json';
import {
  BODY_CONSTANTS,
  bodyEscapeSpeedKmS,
  dayLength,
  distancesOf,
  earthDistance,
  escapeSpeedKmS,
  FACT_BODIES,
  FACT_BODY_OF,
  type FactBody,
  kelvinToCelsius,
  lightTimeS,
  parseBodies,
  SOLAR_CONSTANT_W_M2,
  signalDelay,
  sunlightVsEarth,
  sunlightWM2,
  surfaceGravityMS2,
  TABLE_KEY,
} from './bodyFacts';

const tablePath = fileURLToPath(new URL('../../../pipeline/out/ephemeris/planets.bin', import.meta.url));
const gmPath = fileURLToPath(new URL('../../../pipeline/raw/spice/gm_de440.tpc', import.meta.url));

const GIANTS = ['Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;

/** A figure as a fact sheet prints it, and the decimals it is printed to. */
type Printed = readonly [value: number, decimals: number];

/**
 * The figures NASA's fact sheets print (the Moon, Earth and Mars read 2026-11-11, the rest 2026-11-15), to the
 * decimals they print: GM in 10⁶ km³/s², mean gravity (at 1 bar for the giants) and escape velocity. Mercury's escape
 * velocity is not here: its own test below says why.
 */
const NASA: Readonly<Record<FactBody, { gm: Printed; gravity: Printed; escapeKmS?: Printed }>> = {
  Mercury: { gm: [0.022032, 6], gravity: [3.7, 2] },
  Venus: { gm: [0.32486, 5], gravity: [8.87, 2], escapeKmS: [10.36, 2] },
  Earth: { gm: [0.3986, 5], gravity: [9.82, 2], escapeKmS: [11.186, 3] },
  Moon: { gm: [0.0049, 5], gravity: [1.62, 2], escapeKmS: [2.38, 2] },
  Mars: { gm: [0.042828, 6], gravity: [3.73, 2], escapeKmS: [5.03, 2] },
  Jupiter: { gm: [126.687, 3], gravity: [25.92, 2], escapeKmS: [59.5, 1] },
  Saturn: { gm: [37.931, 3], gravity: [11.19, 2], escapeKmS: [35.5, 1] },
  Uranus: { gm: [5.794, 4], gravity: [9.01, 2], escapeKmS: [21.3, 1] },
  Neptune: { gm: [6.8351, 4], gravity: [11.27, 2], escapeKmS: [23.5, 1] },
};

/** Each body's own NAIF id: its GM is `BODY<id>_GM`, never a system barycentre's such as `BODY5_GM`. */
const NAIF_ID: Readonly<Record<FactBody, number>> = {
  Mercury: 199,
  Venus: 299,
  Earth: 399,
  Moon: 301,
  Mars: 499,
  Jupiter: 599,
  Saturn: 699,
  Uranus: 799,
  Neptune: 899,
};

/** The file as plain objects, to break one part of it at a time. */
type Editable = Record<string, unknown> & {
  bodies: Record<string, Record<string, unknown> & { sources: Record<string, unknown> }>;
};
const copy = (): Editable => structuredClone(bodiesJson) as never;

describe('data/bodies.json', () => {
  it('has every number for the Moon and the eight planets, each citing its own fact sheet, or NAIF for GM', () => {
    const file = parseBodies(bodiesJson);
    expect(Object.keys(file.bodies)).toEqual([...FACT_BODIES]);
    for (const name of FACT_BODIES) {
      const b = file.bodies[name];
      const [label, link] = file.sources[b.factSheet] ?? [];
      expect(link, name).toMatch(/^https:\/\/nssdc\.gsfc\.nasa\.gov\/planetary\/factsheet\/[a-z]+fact\.html$/);
      // Each sheet is listed with the update date it carried when it was read.
      expect(label, name).toMatch(/ Fact Sheet, updated \d{1,2} [A-Z][a-z]{2} \d{4}$/);
      const fields = [
        'radiusKm',
        'gmKm3PerS2',
        'rotationH',
        'solarDayH',
        'obliquityDeg',
        'temperatureK',
        ...(b.surfacePressureMbar === null ? [] : ['surfacePressureMbar']),
        ...(b.surface === 'none' ? ['equatorialRadiusKm', 'levelBar'] : []),
      ];
      expect(Object.keys(b.sources).sort(), name).toEqual(fields.sort());
      for (const k of fields) {
        expect(b.sources[k], `${name}.${k}`).toContain(k === 'gmKm3PerS2' ? 'spiceGm' : b.factSheet);
      }
    }
  });

  it('gives the four giants at the 1 bar level, with no surface pressure and no surface temperature', () => {
    for (const name of GIANTS) {
      const b = BODY_CONSTANTS[name];
      expect(b, name).toMatchObject({ surface: 'none', levelBar: 1, surfacePressureMbar: null });
      expect(Object.keys(b.temperatureK), name).toEqual(['atLevelK']);
      expect(b.equatorialRadiusKm, name).toBeGreaterThan(b.radiusKm);
    }
    for (const name of FACT_BODIES.filter((n) => !(GIANTS as readonly string[]).includes(n))) {
      expect(BODY_CONSTANTS[name].surface, name).toBeUndefined();
    }
  });

  it("keeps NASA's minus sign for a retrograde spin, and every length of day positive", () => {
    expect(BODY_CONSTANTS.Venus.rotationH).toBe(-5832.6);
    expect(BODY_CONSTANTS.Uranus.rotationH).toBe(-17.24);
    for (const name of FACT_BODIES) {
      expect(BODY_CONSTANTS[name].solarDayH, name).toBeGreaterThan(0);
      // Spinning backwards shows in the tilt too: past 90° exactly where the period is negative.
      expect(BODY_CONSTANTS[name].obliquityDeg > 90, name).toBe(BODY_CONSTANTS[name].rotationH < 0);
    }
  });

  it('refuses a number that names no source, a source that is not listed, and a value out of its range', () => {
    const noSource = copy();
    Reflect.deleteProperty(noSource.bodies.Mars.sources, 'gmKm3PerS2');
    expect(() => parseBodies(noSource)).toThrow(/Mars.gmKm3PerS2 names no source/);
    const noObliquitySource = copy();
    Reflect.deleteProperty(noObliquitySource.bodies.Neptune.sources, 'obliquityDeg');
    expect(() => parseBodies(noObliquitySource)).toThrow(/Neptune.obliquityDeg names no source/);
    const unlisted = copy();
    unlisted.bodies.Mars.sources.rotationH = ['nasaPluto'];
    expect(() => parseBodies(unlisted)).toThrow(/cites nasaPluto/);
    const negative = copy();
    negative.bodies.Mars.radiusKm = -3389.5;
    expect(() => parseBodies(negative)).toThrow(/Mars.radiusKm is not a positive number/);
    const backwards = copy();
    backwards.bodies.Mars.temperatureK = { rangeK: [242, 184] };
    expect(() => parseBodies(backwards)).toThrow(/does not run from cold to hot/);
    const stopped = copy();
    stopped.bodies.Venus.rotationH = 0;
    expect(() => parseBodies(stopped)).toThrow(/Venus.rotationH is not a non-zero number/);
    const negativeDay = copy();
    negativeDay.bodies.Venus.solarDayH = -2802;
    expect(() => parseBodies(negativeDay)).toThrow(/Venus.solarDayH is not a positive number/);
    const tipped = copy();
    tipped.bodies.Uranus.obliquityDeg = 262.23;
    expect(() => parseBodies(tipped)).toThrow(/Uranus.obliquityDeg is not an angle from 0° to 180°/);
  });

  it('refuses a surface value for a giant planet, and a 1 bar value for a body with a surface', () => {
    const pressure = copy();
    pressure.bodies.Jupiter.surfacePressureMbar = 1_000_000;
    pressure.bodies.Jupiter.sources.surfacePressureMbar = ['nasaJupiter'];
    expect(() => parseBodies(pressure)).toThrow(/Jupiter has no surface, so it has no surface pressure/);
    const mean = copy();
    mean.bodies.Saturn.temperatureK = { atLevelK: 134, meanK: 134 };
    expect(() => parseBodies(mean)).toThrow(/Saturn has no surface, so it has no surface temperatures/);
    const noLevel = copy();
    Reflect.deleteProperty(noLevel.bodies.Uranus, 'levelBar');
    expect(() => parseBodies(noLevel)).toThrow(/Uranus.levelBar is not a positive number/);
    const onSolid = copy();
    onSolid.bodies.Mars.temperatureK = { atLevelK: 214 };
    expect(() => parseBodies(onSolid)).toThrow(/Mars.temperatureK.atLevelK is only for a body with no surface/);
    const equatorial = copy();
    equatorial.bodies.Earth.equatorialRadiusKm = 6378.1;
    expect(() => parseBodies(equatorial)).toThrow(/Earth.equatorialRadiusKm is only for a body with no surface/);
  });

  it('refuses a field, a body or a part of the file it does not know, so no number slips past unread', () => {
    const field = copy();
    field.bodies.Mars.massKg = 6.4171e23;
    expect(() => parseBodies(field)).toThrow(/Mars.massKg is not a field this file knows/);
    const temperature = copy();
    temperature.bodies.Venus.temperatureK = { meanK: 737, surfaceK: 737 };
    expect(() => parseBodies(temperature)).toThrow(/Venus.temperatureK.surfaceK is not a field this file knows/);
    const body = copy();
    body.bodies.Pluto = structuredClone(body.bodies.Neptune);
    expect(() => parseBodies(body)).toThrow(/bodies.Pluto is not a field this file knows/);
    // The concept demo's translated text held temperatures with no source; no block like it can come back.
    const part = copy();
    part.text = { ar: {} };
    expect(() => parseBodies(part)).toThrow(/^data\/bodies.json: text is not a field this file knows$/);
  });
});

describe('surface gravity and escape speed', () => {
  it.each(FACT_BODIES)('match the GM and gravity NASA prints for %s', (name) => {
    const { gmKm3PerS2, radiusKm } = BODY_CONSTANTS[name];
    const { gm, gravity } = NASA[name];
    // Printed to a few decimals, so half a unit in the last place is the most they can differ by.
    expect(gmKm3PerS2 / 1e6).toBeCloseTo(gm[0], gm[1]);
    expect(surfaceGravityMS2(gmKm3PerS2, radiusKm)).toBeCloseTo(gravity[0], gravity[1]);
  });

  it.each(FACT_BODIES.filter((name) => NASA[name].escapeKmS))(
    'match the escape velocity NASA prints for %s',
    (name) => {
      const [kmS, decimals] = NASA[name].escapeKmS ?? [Number.NaN, 0];
      expect(bodyEscapeSpeedKmS(BODY_CONSTANTS[name])).toBeCloseTo(kmS, decimals);
    },
  );

  it("use a giant's equatorial radius at 1 bar, as NASA does: Jupiter's mean radius would give 60.2 km/s, not 59.5", () => {
    const { Jupiter, Earth } = BODY_CONSTANTS;
    expect(escapeSpeedKmS(Jupiter.gmKm3PerS2, Jupiter.radiusKm)).toBeCloseTo(60.2, 1);
    expect(bodyEscapeSpeedKmS(Jupiter)).toBeCloseTo(59.5, 1);
    // A body with a surface keeps its mean radius.
    expect(bodyEscapeSpeedKmS(Earth)).toBe(escapeSpeedKmS(Earth.gmKm3PerS2, Earth.radiusKm));
  });

  it('give Mercury 4.25 km/s from its own GM and radius, where its sheet prints 4.3', () => {
    const kmS = bodyEscapeSpeedKmS(BODY_CONSTANTS.Mercury);
    expect(kmS).toBeCloseTo(4.25, 2);
    // More than half a unit in the printed figure's last place: the sheet's 4.3 is not what its own numbers give.
    expect(Math.abs(kmS - 4.3)).toBeGreaterThan(0.05);
  });

  it('turn km³/s² and km into m/s² and km/s with the right powers', () => {
    // GM = 1 km³/s² on a 1 km sphere: 1 km/s² is 1000 m/s², and sqrt(2) km/s to leave.
    expect(surfaceGravityMS2(1, 1)).toBe(1000);
    expect(escapeSpeedKmS(1, 1)).toBeCloseTo(Math.SQRT2, 12);
  });
});

// NAIF's kernel is fetched by `corepack pnpm ephemeris` into pipeline/raw/spice; CI does not fetch it.
describe.skipIf(!existsSync(gmPath))("against NAIF's gm_de440.tpc", () => {
  it("holds each body's own GM, to the six decimals the file stores", () => {
    // Read here, not in the suite's body: Vitest runs that even when the suite is skipped.
    const kernel = readFileSync(gmPath, 'utf8');
    for (const name of FACT_BODIES) {
      const found = new RegExp(`\\bBODY${NAIF_ID[name]}_GM\\s*=\\s*\\(\\s*(\\S+)\\s*\\)`).exec(kernel);
      expect(found, name).not.toBeNull();
      // SPICE text kernels may write the exponent with a D, as Fortran does.
      const gm = Number((found?.[1] ?? '').replace(/D/i, 'E'));
      expect(BODY_CONSTANTS[name].gmKm3PerS2, name).toBeCloseTo(gm, 6);
    }
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

  it('reads a retrograde turn as its length: Uranus in 17.24 hours, Venus in 243.025 days', () => {
    expect(dayLength(BODY_CONSTANTS.Uranus.rotationH)).toEqual({ n: 17.24, unit: 'h', digits: 1 });
    expect(dayLength(BODY_CONSTANTS.Venus.rotationH)).toMatchObject({ unit: 'd' });
    expect(dayLength(BODY_CONSTANTS.Venus.rotationH).n).toBeCloseTo(243.025, 10);
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
    expect(round(BODY_CONSTANTS.Mercury.temperatureK.meanK)).toBe(167);
    expect(round(BODY_CONSTANTS.Venus.temperatureK.meanK)).toBe(464);
    // The giants' temperatures at 1 bar, which their sheets print as -108, -139, -197 and -201 °C.
    expect(GIANTS.map((name) => round(BODY_CONSTANTS[name].temperatureK.atLevelK))).toEqual([-108, -139, -197, -201]);
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
    it('puts Mars, the Moon and the Earth where JPL Horizons does', () => {
      // Read here, not in the suite's body: Vitest runs that even when the suite is skipped.
      const file = readFileSync(tablePath);
      const table = parsePlanets(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      const p = table.snapshot(Date.UTC(2026, 10, 22, 12));
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

describe('the planet cards', () => {
  it("finds each body's card from its key in the planets table, and back", () => {
    for (const name of FACT_BODIES) expect(FACT_BODY_OF[TABLE_KEY[name]]).toBe(name);
    expect(Object.keys(FACT_BODY_OF)).toHaveLength(FACT_BODIES.length);
  });

  it("gives sunlight as a share of Earth's: one over the distance in AU squared", () => {
    expect(sunlightVsEarth(1)).toBe(1);
    expect(sunlightVsEarth(2)).toBe(0.25);
    // Mercury's sheet: 9082.7 W/m² against Earth's 1361.0, a ratio of 6.674, at its mean distance of 57.909 million km.
    expect(sunlightVsEarth(57.909e6 / 149.598e6)).toBeCloseTo(6.674, 2);
    // And it agrees with the sunlight in watts.
    expect(sunlightWM2(SOLAR_CONSTANT_W_M2, 5.2) / SOLAR_CONSTANT_W_M2).toBeCloseTo(sunlightVsEarth(5.2), 12);
  });

  it('words a distance from Earth in kilometres up to ten million, and in millions of kilometres beyond', () => {
    expect(earthDistance(384_400)).toEqual({ n: 384_400, unit: 'km', digits: 0 });
    expect(earthDistance(9_999_999).unit).toBe('km');
    expect(earthDistance(628.7e6)).toEqual({ n: 628.7, unit: 'mkm', digits: 1 });
  });
});
