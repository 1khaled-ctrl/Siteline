import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { etSeconds, marsOrientation, marsSubsolarPoint } from './marsSun';
import { recordValidation } from './validationReport';
import type { Vec3 } from './vec';

const goldenPath = fileURLToPath(new URL('../../../tests/reference/mars_sun_golden.json', import.meta.url));
const T0 = Date.UTC(2028, 2, 3, 6);
const DAY_MS = 86_400_000;
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

describe('Mars rotation', () => {
  it('converts UTC to ephemeris time to within the 2 ms TDB−TT term SPICE adds', () => {
    // SPICE str2et for 2028-03-03T06:00:00 UTC, with naif0012.tls loaded.
    expect(etSeconds(T0)).toBeCloseTo(888948069.1854193, 2);
  });

  it('turns Mars 350.892° a day, the IAU rate, with the periodic terms moving it by less than a thousandth of a degree', () => {
    const a = marsOrientation(T0).primeMeridianDeg;
    const b = marsOrientation(T0 + DAY_MS).primeMeridianDeg;
    expect(wrap(b - a - 350.891982443297)).toBeCloseTo(0, 2);
  });

  it('puts the pole where the 2009 IAU report did at J2000, once the periodic terms are added', () => {
    const o = marsOrientation(Date.UTC(2000, 0, 1, 12));
    expect(o.raDeg).toBeCloseTo(317.68143, 2);
    expect(o.decDeg).toBeCloseTo(52.8865, 2);
  });
});

describe('sub-solar point on Mars', () => {
  it('stays inside Mars’s axial tilt of 25.2° and moves west 350.9° a day when the Sun stands still', () => {
    const sun: Vec3 = [1.2e8, 1.5e8, 0.3e7];
    const a = marsSubsolarPoint(sun, T0);
    const b = marsSubsolarPoint(sun, T0 + DAY_MS);
    expect(Math.abs(a.latDeg)).toBeLessThan(25.3);
    expect(wrap(b.lonDeg - a.lonDeg + 350.891982443297)).toBeCloseTo(0, 2);
    expect(b.latDeg).toBeCloseTo(a.latDeg, 1);
  });

  it('is on the opposite side of the planet when the Sun is on the opposite side', () => {
    const a = marsSubsolarPoint([1.2e8, 1.5e8, 0.3e7], T0);
    const b = marsSubsolarPoint([-1.2e8, -1.5e8, -0.3e7], T0);
    expect(a.latDeg).toBeCloseTo(-b.latDeg, 9);
    expect(wrap(a.lonDeg - b.lonDeg - 180)).toBeCloseTo(0, 9);
  });
});

interface Case {
  tUtcMs: number;
  marsFromSunKm: Vec3;
  subsolar: { latDeg: number; lonDeg: number };
}

describe.skipIf(!existsSync(goldenPath))('sub-solar point on Mars against SPICE (run `pnpm ephemeris`)', () => {
  it('matches the Sun overhead in the IAU_MARS frame within 0.001°', () => {
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: Case[] };
    let worstDeg = 0;
    for (const c of golden.cases) {
      const [x, y, z] = c.marsFromSunKm;
      const got = marsSubsolarPoint([-x, -y, -z], c.tUtcMs);
      const dLat = got.latDeg - c.subsolar.latDeg;
      const dLon = wrap(got.lonDeg - c.subsolar.lonDeg) * Math.cos((c.subsolar.latDeg * Math.PI) / 180);
      worstDeg = Math.max(worstDeg, Math.hypot(dLat, dLon));
    }
    recordValidation('marsSun', {
      cases: golden.cases.length,
      worstDeg,
      toleranceDeg: 0.001,
      reference: 'SPICE spkpos SUN from MARS BARYCENTER in IAU_MARS (pck00011.tpc), geometric, 2026 to 2036',
    });
    expect(golden.cases.length).toBe(40);
    expect(worstDeg).toBeLessThan(0.001);
  });
});
