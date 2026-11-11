import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEphemeris } from './ephemeris';
import { elevAz, siteFrame } from './frames';
import { recordValidation } from './validationReport';
import { DEG } from './vec';

const tablePath = fileURLToPath(new URL('../../../pipeline/out/ephemeris/moon_sun_earth.bin', import.meta.url));
const goldenPath = fileURLToPath(new URL('../../../tests/reference/sun_earth_golden.json', import.meta.url));

interface GoldenCase {
  latDeg: number;
  lonDeg: number;
  heightM: number;
  tUtcMs: number;
  sun: { elevDeg: number; azDeg: number };
  earth: { elevDeg: number; azDeg: number };
}

function separationDeg(a: { elevDeg: number; azDeg: number }, b: { elevDeg: number; azDeg: number }): number {
  const cos =
    Math.sin(a.elevDeg * DEG) * Math.sin(b.elevDeg * DEG) +
    Math.cos(a.elevDeg * DEG) * Math.cos(b.elevDeg * DEG) * Math.cos((a.azDeg - b.azDeg) * DEG);
  return Math.acos(Math.min(1, cos)) / DEG;
}

describe.skipIf(!existsSync(tablePath))('ephemeris table against SPICE (run `pnpm ephemeris` first)', () => {
  it('matches spkcpo from the site within 0.001° for the Sun and Earth', () => {
    const file = readFileSync(tablePath);
    const table = parseEphemeris(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: GoldenCase[] };
    let worst = 0;
    for (const c of golden.cases) {
      const site = siteFrame(c.latDeg, c.lonDeg, c.heightM);
      for (const body of ['sun', 'earth'] as const) {
        const got = elevAz(table.positionKm(body, c.tUtcMs), site);
        worst = Math.max(worst, separationDeg(got, c[body]), Math.abs(got.elevDeg - c[body].elevDeg));
      }
    }
    recordValidation('spice', {
      cases: golden.cases.length,
      worstDeg: worst,
      toleranceDeg: 0.001,
      reference: 'SPICE spkcpo, MOON_ME, LT+S, from the site',
    });
    expect(golden.cases.length).toBe(1000);
    expect(worst).toBeLessThan(0.001);
  });
});
