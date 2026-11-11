import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { demFromInt16, horizonFromDem } from './dem';
import { parseEphemeris } from './ephemeris';
import { siteFrame } from './frames';
import { skyAt } from './stay';
import { recordValidation } from './validationReport';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const terrainPath = root('pipeline/raw/landfall/data/terrain.json');
const tablePath = root('pipeline/out/ephemeris/moon_sun_earth.bin');

// Bussey et al. 2010 published sunlight (%), and the concept demo's result on the same LOLA 1.2 km terrain.
const POINTS = [
  { name: 'A, Shackleton ridge', lat: -89.68, lon: -166.0, bussey: 81, demo: 68.8 },
  { name: 'B, peak near the ridge', lat: -89.44, lon: -141.8, bussey: 82, demo: 80.9 },
  { name: 'D, near Shackleton rim', lat: -88.79, lon: 124.5, bussey: 86, demo: 84.5 },
];

describe.skipIf(!existsSync(terrainPath) || !existsSync(tablePath))('sunlight on LOLA 1.2 km terrain', () => {
  const file = existsSync(terrainPath) ? (JSON.parse(readFileSync(terrainPath, 'utf8')) as { b64: string }) : null;
  const ours = () => {
    const bytes = Buffer.from(file?.b64 ?? '', 'base64');
    const dem = demFromInt16(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2), 700, 1200, 0.5);
    const buf = readFileSync(tablePath);
    const eph = parseEphemeris(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return POINTS.map((p) => {
      const hz = horizonFromDem(dem, p.lat, p.lon);
      if (!hz) throw new Error(`${p.name} is off the terrain`);
      const site = siteFrame(p.lat, p.lon, hz.groundHeightM, 2);
      let sum = 0;
      let n = 0;
      for (let t = eph.startUtcMs; t <= eph.endUtcMs; t += 3_600_000, n++) {
        sum += skyAt(eph, 'sun', site, hz.mask, t).fraction;
      }
      return { ...p, ours: (100 * sum) / n };
    });
  };

  it('agrees with the concept demo within 2 points, and with Bussey within 5 points except on the narrow ridge', () => {
    const rows = ours();
    recordValidation('sunlight', {
      terrain: 'LOLA LDEM_75S_240M at 1.2 km per pixel',
      reference: 'Bussey et al. 2010, Icarus 208',
      toleranceBusseyPct: 5,
      rows: rows.map((r) => ({ point: r.name, latDeg: r.lat, lonDeg: r.lon, busseyPct: r.bussey, oursPct: r.ours })),
    });
    for (const r of rows) expect(Math.abs(r.ours - r.demo)).toBeLessThan(2);
    // Point A sits on a ridge narrower than one 1.2 km pixel; finer terrain should close that gap.
    for (const r of rows.slice(1)) expect(Math.abs(r.ours - r.bussey)).toBeLessThan(5);
  });
});
