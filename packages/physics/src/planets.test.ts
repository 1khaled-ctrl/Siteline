import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KM_PER_AU, PLANET_NAMES, PLANETS_FORMAT, parsePlanets, type SolarBodyKey } from './planets';
import { recordValidation } from './validationReport';
import { norm, sub, type Vec3 } from './vec';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const tablePath = root('pipeline/out/ephemeris/planets.bin');
const goldenPath = root('tests/reference/planets_golden.json');

function pack(count: number, orbitPoints: number, fill: (k: number, j: number) => number[]) {
  const header = {
    format: PLANETS_FORMAT,
    frame: 'ECLIPJ2000',
    bodies: [],
    units: 'km',
    startUtcMs: Date.UTC(2026, 0, 1),
    stepMs: 43_200_000,
    count,
    orbitPoints,
    orbitPeriodsDays: [],
    kernels: [],
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const offset = Math.ceil((4 + json.length) / 4) * 4;
  const samples = Array.from({ length: count }, (_, k) =>
    Array.from({ length: 9 }, (_, j) => fill(k, j)).flat(),
  ).flat();
  const orbits = Array.from({ length: 8 * orbitPoints * 3 }, (_, i) => i);
  const buf = new ArrayBuffer(offset + (samples.length + orbits.length) * 4);
  new DataView(buf).setUint32(0, json.length, true);
  new Uint8Array(buf, 4).set(json);
  new Float32Array(buf, offset).set([...samples, ...orbits]);
  return buf;
}

describe('planet table', () => {
  it('interpolates between 12-hour samples, per body', () => {
    const table = parsePlanets(pack(3, 4, (k, j) => [k * 100 + j, 0, -j]));
    const t0 = table.startUtcMs;
    expect(table.positionKm('mercury', t0 + 21_600_000)).toEqual([50, 0, 0]);
    expect(table.positionKm('neptune', t0 + 43_200_000)[0]).toBe(107);
    expect(table.positionKm('moon', t0 + 86_400_000)).toEqual([208, 0, -8]);
    expect(() => table.positionKm('earth', t0 - 1)).toThrow(RangeError);
    expect(Object.keys(table.snapshot(t0))).toHaveLength(9);
  });

  it('returns one orbit per planet as xyz triples', () => {
    const table = parsePlanets(pack(2, 4, () => [0, 0, 0]));
    expect(table.orbitKm('mercury')).toHaveLength(12);
    expect(Array.from(table.orbitKm('venus').subarray(0, 3))).toEqual([12, 13, 14]);
  });

  it('rejects a table whose sizes do not match its header', () => {
    expect(() => parsePlanets(pack(2, 4, () => [0, 0, 0]).slice(0, 200))).toThrow();
  });
});

interface Case {
  tUtcMs: number;
  positionsKm: Record<SolarBodyKey, Vec3>;
}

describe.skipIf(!existsSync(tablePath) || !existsSync(goldenPath))(
  'planet table against SPICE (run `pnpm ephemeris`)',
  () => {
    // Straight-line interpolation between 12-hour samples shortens a position by (angle moved)²/8. That is up to
    // 0.03% for Mercury near perihelion, its fastest, and 0.2% for the Moon, which crosses 6.5° in 12 hours.
    const RELATIVE_TOLERANCE = { planet: 3e-4, moon: 2.5e-3 };

    it('matches spkpos within 0.01° of direction, and within the interpolation limit of distance', () => {
      const file = readFileSync(tablePath);
      const table = parsePlanets(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: Case[] };
      let worstDeg = 0;
      let worstPlanetRel = 0;
      let worstMoonRel = 0;
      for (const c of golden.cases) {
        for (const k of [...PLANET_NAMES, 'moon'] as SolarBodyKey[]) {
          const got = table.positionKm(k, c.tUtcMs);
          const want = c.positionsKm[k];
          const rel = norm(sub(got, want)) / norm(want);
          if (k === 'moon') worstMoonRel = Math.max(worstMoonRel, rel);
          else worstPlanetRel = Math.max(worstPlanetRel, rel);
          const cos = (got[0] * want[0] + got[1] * want[1] + got[2] * want[2]) / (norm(got) * norm(want));
          worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, cos)) * 180) / Math.PI);
        }
      }
      recordValidation('planets', {
        cases: golden.cases.length,
        bodies: 9,
        worstDeg,
        worstPlanetRelativeError: worstPlanetRel,
        worstMoonRelativeError: worstMoonRel,
        toleranceDeg: 0.01,
        reference: 'SPICE spkpos, ECLIPJ2000, geometric; Mars and the outer planets are system barycentres',
      });
      expect(golden.cases.length).toBe(40);
      expect(worstDeg).toBeLessThan(0.01);
      expect(worstPlanetRel).toBeLessThan(RELATIVE_TOLERANCE.planet);
      expect(worstMoonRel).toBeLessThan(RELATIVE_TOLERANCE.moon);
    });

    it('puts the planets at their known distances from the Sun on 3 March 2028', () => {
      const file = readFileSync(tablePath);
      const table = parsePlanets(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      const au = (k: SolarBodyKey) => norm(table.positionKm(k, Date.UTC(2028, 2, 3))) / KM_PER_AU;
      // Within the orbits' perihelion-to-aphelion range, a check the table is Sun-centred and in kilometres.
      expect(au('mercury')).toBeGreaterThan(0.307);
      expect(au('mercury')).toBeLessThan(0.467);
      expect(au('earth')).toBeGreaterThan(0.983);
      expect(au('earth')).toBeLessThan(1.017);
      expect(au('neptune')).toBeGreaterThan(29.8);
      expect(au('neptune')).toBeLessThan(30.4);
      // The Moon is relative to the Earth: about 0.0026 AU away.
      expect(au('moon')).toBeGreaterThan(0.0023);
      expect(au('moon')).toBeLessThan(0.0028);
    });
  },
);
