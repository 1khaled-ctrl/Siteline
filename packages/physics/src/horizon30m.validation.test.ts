import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type HeightPatch, heightsFromPatches, horizonFromHeights } from './dem';
import { parseEphemeris } from './ephemeris';
import { siteFrame } from './frames';
import { skyAt } from './stay';
import { recordValidation } from './validationReport';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const slicePath = root('tests/reference/terrain30m.json');
// NASA's own long-term sunlight at the same points (PGDA product 69, 60 m), written by tests/reference/pgda69_points.py.
const nasaPath = root('tests/reference/pgda69_points.json');
const tablePath = root('pipeline/out/ephemeris/moon_sun_earth.bin');

/**
 * Sunlight at Bussey et al. 2010's three points, from LOLA's real 30 m terrain, beside the 1.2 km grid's answer for
 * the same points. The slices come from `tests/e2e/.dev-cut-terrain.mts`, so this needs no network.
 *
 * The two terrains disagree widely, and this test does not pretend otherwise: it records both and only asserts what
 * is actually known, which is that the finer terrain finds more skyline, never less. The app judges sites on the
 * 1.2 km grid until the difference is explained (see CREDITS.md, `lola-ldem-75s-30m`).
 */
const POINTS = [
  { name: 'A, Shackleton ridge', lat: -89.68, lon: -166.0, bussey: 81, coarse: 68.0 },
  { name: 'B, peak near the ridge', lat: -89.44, lon: -141.8, bussey: 82, coarse: 80.6 },
  { name: 'D, near Shackleton rim', lat: -88.79, lon: 124.5, bussey: 86, coarse: 83.9 },
];

interface Slice {
  cornerX: number;
  cornerY: number;
  pixM: number;
  width: number;
  height: number;
  heightsB64: string;
}

const patchOf = (s: Slice): HeightPatch => {
  const bytes = Buffer.from(s.heightsB64, 'base64');
  const raw = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
  // −32768 marks a cell the product has no height for; the walk must read it as missing, not as −32768 m.
  const heightsM = Float32Array.from(raw, (h) => (h === -32768 ? Number.NaN : h));
  return { cornerX: s.cornerX, cornerY: s.cornerY, pixM: s.pixM, width: s.width, height: s.height, heightsM };
};

describe.skipIf(!existsSync(slicePath) || !existsSync(tablePath) || !existsSync(nasaPath))(
  'sunlight on LOLA 30 m terrain',
  () => {
    it("agrees with NASA's own sunlight maps, and records every answer", () => {
      const nasa = JSON.parse(readFileSync(nasaPath, 'utf8')) as { rows: { point: string; cellPct: number }[] };
      const file = JSON.parse(readFileSync(slicePath, 'utf8')) as {
        source: string;
        points: Record<string, { near: Slice; far: Slice }>;
      };
      const buf = readFileSync(tablePath);
      const eph = parseEphemeris(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const rows = POINTS.map((p) => {
        const cut = file.points[p.name];
        if (!cut) throw new Error(`no terrain slice for ${p.name}`);
        const heights = heightsFromPatches([patchOf(cut.near), patchOf(cut.far)]);
        const hz = horizonFromHeights(heights, p.lat, p.lon, { stepM: cut.near.pixM, maxDistM: 300_000 });
        if (!hz) throw new Error(`${p.name} is off the terrain slice`);
        const site = siteFrame(p.lat, p.lon, hz.groundHeightM, 2);
        let sum = 0;
        let n = 0;
        for (let t = eph.startUtcMs; t <= eph.endUtcMs; t += 3_600_000, n++)
          sum += skyAt(eph, 'sun', site, hz.mask, t).fraction;
        return { ...p, ours: (100 * sum) / n, groundHeightM: hz.groundHeightM };
      });

      recordValidation('sunlight30m', {
        terrain: 'LOLA LDEM_75S_30MPP_ADJ at 30 m per pixel near the site, about 1 km beyond it',
        reference: 'Bussey et al. 2010, Icarus 208 (Kaguya topography), and our own 1.2 km LOLA result',
        nasa: "NASA's long-term sunlight maps, PGDA product 69 (Mazarico et al. 2011), 60 m",
        rows: rows.map((r) => ({
          nasaPct: nasa.rows.find((n) => n.point === r.name)?.cellPct ?? Number.NaN,
          point: r.name,
          latDeg: r.lat,
          lonDeg: r.lon,
          busseyPct: r.bussey,
          coarsePct: r.coarse,
          finePct: r.ours,
        })),
      });

      for (const r of rows) {
        // Two independent computations on two LOLA products: NASA's 60 m maps and our 30 m horizon. They need not match
        // exactly (a 60 m cell, and averaging periods the maps do not state), but within a few points.
        const theirs = nasa.rows.find((n) => n.point === r.name)?.cellPct;
        expect(theirs, r.name).toBeDefined();
        expect(Math.abs(r.ours - (theirs ?? Number.NaN)), r.name).toBeLessThan(3);
        // Every value is a share of the time the Sun is up: a percentage, and never negative.
        expect(r.ours).toBeGreaterThanOrEqual(0);
        expect(r.ours).toBeLessThanOrEqual(100);
        // Finer terrain resolves skyline the coarse grid steps over, so it can only shade a site further.
        expect(r.ours).toBeLessThanOrEqual(r.coarse + 0.5);
        // The ground heights are real metres on the 1737.4 km sphere, not nodata read as a height.
        expect(r.groundHeightM).toBeGreaterThan(-2000);
        expect(r.groundHeightM).toBeLessThan(5000);
      }
    });
  },
);
