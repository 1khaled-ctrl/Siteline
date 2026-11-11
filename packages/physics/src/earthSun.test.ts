import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { gmstDeg, subsolarPoint } from './earthSun';
import { recordValidation } from './validationReport';
import type { Vec3 } from './vec';

const goldenPath = fileURLToPath(new URL('../../../tests/reference/earth_sun_golden.json', import.meta.url));
const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12);

describe('Earth rotation', () => {
  it('gives the sidereal time of the worked example in Meeus, Astronomical Algorithms, example 12.a', () => {
    // 1987 April 10, 0h UT: 13h 10m 46.3668s.
    const want = (13 + 10 / 60 + 46.3668 / 3600) * 15;
    expect(gmstDeg(Date.UTC(1987, 3, 10))).toBeCloseTo(want, 4);
  });

  it('wraps into 0 to 360 degrees', () => {
    for (const t of [Date.UTC(1969, 6, 20), 0, J2000_UTC_MS, Date.UTC(2031, 11, 31, 23, 59)]) {
      const g = gmstDeg(t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(360);
    }
  });
});

describe('sub-solar point', () => {
  it('is on the equator at the equinox direction, at longitude minus the sidereal time', () => {
    const p = subsolarPoint([1, 0, 0], J2000_UTC_MS);
    expect(p.latDeg).toBeCloseTo(0, 6);
    // GMST at J2000 is 280.46°, so the vernal equinox is over 79.54°E.
    expect(p.lonDeg).toBeCloseTo(360 - 280.46061837, 4);
  });

  it('reaches the obliquity of the ecliptic at the solstice and is on the opposite side for the other sign', () => {
    const june = subsolarPoint([0, 1, 0], J2000_UTC_MS);
    const december = subsolarPoint([0, -1, 0], J2000_UTC_MS);
    expect(june.latDeg).toBeCloseTo(23.4393, 3);
    expect(december.latDeg).toBeCloseTo(-23.4393, 3);
  });

  it('is on the opposite meridian when the Sun is on the opposite side', () => {
    const a = subsolarPoint([1, 0, 0], Date.UTC(2028, 2, 3));
    const b = subsolarPoint([-1, 0, 0], Date.UTC(2028, 2, 3));
    expect((((a.lonDeg - b.lonDeg) % 360) + 360) % 360).toBeCloseTo(180, 9);
    expect(a.latDeg).toBeCloseTo(-b.latDeg, 9);
  });
});

interface Case {
  tUtcMs: number;
  earthFromSunKm: Vec3;
  subsolar: { latDeg: number; lonDeg: number };
}

describe.skipIf(!existsSync(goldenPath))('sub-solar point against SPICE (run `pnpm ephemeris`)', () => {
  it('matches the Sun overhead in the Earth-fixed frame ITRF93 within 0.03°', () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: Case[] };
    let worstDeg = 0;
    for (const c of golden.cases) {
      const [x, y, z] = c.earthFromSunKm;
      const got = subsolarPoint([-x, -y, -z], c.tUtcMs);
      const dLat = got.latDeg - c.subsolar.latDeg;
      const dLon =
        (((got.lonDeg - c.subsolar.lonDeg + 540) % 360) - 180) * Math.cos((c.subsolar.latDeg * Math.PI) / 180);
      worstDeg = Math.max(worstDeg, Math.hypot(dLat, dLon));
    }
    recordValidation('earthSun', {
      cases: golden.cases.length,
      worstDeg,
      toleranceDeg: 0.03,
      reference: 'SPICE spkpos SUN from EARTH in ITRF93, geometric; precession and obliquity of date, no nutation',
    });
    expect(golden.cases.length).toBe(40);
    expect(worstDeg).toBeLessThan(0.03);
  });
});
