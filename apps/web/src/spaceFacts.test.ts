import { KM_PER_AU, type SolarBodyKey, type Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import { hohmannTransferDays, isSpaceBody, spaceFacts } from './spaceFacts';

describe('hohmannTransferDays', () => {
  it('gives the textbook Earth to Mars time, about 259 days, for orbits of 1 and 1.524 AU', () => {
    expect(hohmannTransferDays(KM_PER_AU, 1.524 * KM_PER_AU)).toBeCloseTo(259, 0);
  });
  it('gives about 6 years to Saturn at 9.54 AU', () => {
    expect(hohmannTransferDays(KM_PER_AU, 9.54 * KM_PER_AU) / 365.25).toBeCloseTo(6.05, 1);
  });
});

/** A simple line-up: every planet on the x axis at a round distance; the Moon 384,400 km from Earth. */
const positions = (): Record<SolarBodyKey, Vec3> => {
  const at = (au: number): Vec3 => [au * KM_PER_AU, 0, 0];
  return {
    mercury: at(0.39),
    venus: at(0.72),
    earth: at(1),
    mars: at(1.52),
    jupiter: at(5.2),
    saturn: at(9.5),
    uranus: at(19.2),
    neptune: at(30.1),
    moon: [384_400, 0, 0],
  };
};

describe('spaceFacts', () => {
  it('works out distance, signal delay and an ideal transfer for a planet with no fact sheet', () => {
    const f = spaceFacts('saturn', positions(), '2028-03-01T00:00:00.000Z');
    // 8.5 AU from Earth: about 1.27 billion km, and light takes about 70.7 minutes.
    expect(f.distanceFromEarthKm).toBe(1.27e9);
    expect(f.distanceFromSunAu).toBe(9.5);
    expect(f.signalFromEarth?.minutes).toBeCloseTo(70.7, 1);
    // 1 AU to 9.5 AU: about 6 years, said in years rather than days.
    expect(f.travel).toMatchObject({ kind: 'transfer', idealTransferYears: 6 });
    expect(f.physical).toBeNull();
    expect(f.sources).toEqual(['spice-de440s', 'spice-gm-de440']);
  });

  it("gives the Moon Apollo's coast and NASA's fact sheet numbers", () => {
    const f = spaceFacts('moon', positions(), '2028-03-01T00:00:00.000Z');
    expect(f.distanceFromEarthKm).toBe(384_400);
    expect(f.signalFromEarth?.seconds).toBeCloseTo(1.3, 1);
    expect(f.travel).toMatchObject({ kind: 'moon', coastDays: 3 });
    // NASA's Moon fact sheet prints 1.62 m/s² and 2.38 km/s.
    expect(f.physical?.surfaceGravityMS2).toBeCloseTo(1.62, 2);
    expect(f.physical?.escapeSpeedKmS).toBeCloseTo(2.38, 2);
    expect(f.sources).toContain('body-facts');
  });

  it('has no travel or Earth distance for Earth itself, and no Sun distance for the Sun', () => {
    expect(spaceFacts('earth', positions(), '').distanceFromEarthKm).toBeNull();
    expect(spaceFacts('earth', positions(), '').travel).toBeNull();
    expect(spaceFacts('sun', positions(), '').distanceFromSunAu).toBeNull();
  });

  it('knows which names are bodies', () => {
    expect(isSpaceBody('saturn')).toBe(true);
    expect(isSpaceBody('pluto')).toBe(false);
  });
});
