import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STAY, type StayQuery } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import { type Dem, type DemHorizon, demFromInt16, horizonFromDem, polarToUnit, unitToLatLon } from './dem';
import { type Ephemeris, parseEphemeris } from './ephemeris';
import { siteFrame } from './frames';
import { HORIZON_BINS } from './horizon';
import { stayBins, stayTest } from './stay';
import { add, DEG, scale, type Vec3 } from './vec';

const DAY_MS = 86_400_000;

const fullSkylines = new Map<string, DemHorizon | undefined>();
/** The whole skyline, walked once a site. */
function fullSkyline(dem: Dem, latDeg: number, lonDeg: number, observerHeightM: number) {
  const key = `${dem.n},${latDeg},${lonDeg},${observerHeightM}`;
  if (!fullSkylines.has(key)) fullSkylines.set(key, horizonFromDem(dem, latDeg, lonDeg, { observerHeightM }));
  return fullSkylines.get(key);
}

/** The parts of a stay result its verdict and the search read, from the whole skyline or only `stayBins`'. */
function verdictOf(q: StayQuery, dem: Dem, eph: Ephemeris, partial: boolean, stepMinutes?: number) {
  const { latDeg, lonDeg } = q.site;
  const full = fullSkyline(dem, latDeg, lonDeg, q.observerHeightM);
  if (!full) throw new Error(`${latDeg}, ${lonDeg} is off the terrain`);
  const site = { ...q.site, heightM: full.groundHeightM };
  const bins = stayBins({ ...q, site }, eph, stepMinutes);
  const mask = partial
    ? horizonFromDem(dem, latDeg, lonDeg, { observerHeightM: q.observerHeightM, bins })?.mask
    : full.mask;
  if (!mask) throw new Error('no partial skyline');
  const r = stayTest(
    { ...q, site },
    { ephemeris: eph, horizon: mask, slope100mDeg: 1, slope2kmPctUnder20: 100, sources: [], stepMinutes },
  );
  return {
    verdict: { pass: r.pass, reasons: r.reasons, sunFractionMin: r.sunFractionMin, earthVisiblePct: r.earthVisiblePct },
    bins,
    mask,
    full: full.mask,
  };
}

// A Sun circling the pole once a synodic month 1.5° up, and an Earth 5° up that swings 10° either way.
const T0 = Date.UTC(2028, 2, 3);
const pole = siteFrame(-90, 0);
const direction = (elevDeg: number, azDeg: number): Vec3 => {
  const el = elevDeg * DEG;
  const az = azDeg * DEG;
  return add(
    scale(pole.u, Math.sin(el)),
    add(scale(pole.n, Math.cos(el) * Math.cos(az)), scale(pole.e, Math.cos(el) * Math.sin(az))),
  );
};
const synthetic: Ephemeris = {
  startUtcMs: T0,
  endUtcMs: T0 + 60 * DAY_MS,
  positionKm: (body, t) =>
    body === 'sun'
      ? add(pole.pKm, scale(direction(1.5, (360 * (t - T0)) / (29.530589 * DAY_MS)), 1.496e8))
      : add(pole.pKm, scale(direction(5, 180 + 10 * Math.sin((2 * Math.PI * (t - T0)) / (27.3 * DAY_MS))), 384_400)),
};

/** Rolling ground with hills up to 1 km high, the same every run. */
function hills(): Dem {
  const n = 241;
  const pixM = 500;
  const heightsM = new Float32Array(n * n);
  let seed = 7;
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const bumps = Array.from({ length: 40 }, () => ({
    c: rand() * n,
    r: rand() * n,
    hM: 100 + rand() * 900,
    w: 3 + rand() * 12,
  }));
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      for (const b of bumps) heightsM[r * n + c] += b.hM * Math.exp(-((r - b.r) ** 2 + (c - b.c) ** 2) / b.w ** 2);
  return { n, pixM, heightsM };
}

describe('stayBins', () => {
  const dem = hills();
  const query = (latDeg: number, lonDeg: number, landingMs: number): StayQuery => ({
    ...DEFAULT_STAY,
    observerHeightM: 2,
    site: { id: 'test', body: 'moon', latDeg, lonDeg },
    landingUtc: new Date(landingMs).toISOString(),
  });
  // Sites within about 15 km of the pole, landing on several days.
  const cases: StayQuery[] = [];
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const { latDeg, lonDeg } = unitToLatLon(polarToUnit((i - 2) * 7_000, (j - 2) * 7_000));
      for (const day of [0, 9, 17, 26]) cases.push(query(latDeg, lonDeg, T0 + day * DAY_MS + 3_600_000 * i));
    }

  it('gives the same verdict, crossing times, sunlight and Earth share from the partial skyline as the full one', () => {
    let passes = 0;
    let sunFails = 0;
    let earthFails = 0;
    let fewest = HORIZON_BINS;
    for (const q of cases) {
      for (const step of [undefined, 60]) {
        const full = verdictOf(q, dem, synthetic, false, step);
        const partial = verdictOf(q, dem, synthetic, true, step);
        expect(partial.verdict).toEqual(full.verdict);
        fewest = Math.min(fewest, partial.bins.length);
        if (full.verdict.pass) passes++;
        if (full.verdict.reasons.some((r) => r.code === 'SUN_BELOW_HORIZON')) sunFails++;
        if (full.verdict.reasons.some((r) => r.code === 'EARTH_BELOW_HORIZON')) earthFails++;
      }
    }
    // The cases cover passes and both kinds of fail, so the sameness is not a trivial one.
    expect(passes).toBeGreaterThan(0);
    expect(sunFails).toBeGreaterThan(0);
    expect(earthFails).toBeGreaterThan(0);
    // And the partial skyline is a real saving: a few days of Sun and a swinging Earth are a fraction of the circle.
    expect(fewest).toBeLessThan(HORIZON_BINS / 4);
  }, 60_000);

  it('walks exactly the listed bins and leaves the rest at −90°', () => {
    const { bins, mask, full } = verdictOf(cases[10], dem, synthetic, true);
    const listed = new Set(bins);
    for (let j = 0; j < HORIZON_BINS; j++) expect(mask[j]).toBe(listed.has(j) ? full[j] : -90);
  });

  it('lists nothing when the ephemeris does not cover the stay', () => {
    expect(stayBins(query(-89.5, 0, T0 + 59 * DAY_MS), synthetic)).toEqual([]);
  });
});

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const terrainPath = root('pipeline/raw/landfall/data/terrain.json');
const tablePath = root('pipeline/out/ephemeris/moon_sun_earth.bin');

describe.skipIf(!existsSync(terrainPath) || !existsSync(tablePath))('stayBins on LOLA terrain and SPICE', () => {
  it('gives the full skyline verdict at sites across the Artemis regions on dates across the table', () => {
    const file = JSON.parse(readFileSync(terrainPath, 'utf8')) as { b64: string };
    const bytes = Buffer.from(file.b64, 'base64');
    const dem = demFromInt16(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2), 700, 1200, 0.5);
    const buf = readFileSync(tablePath);
    const eph = parseEphemeris(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const sites = [
      [-84.35, 32.78],
      [-85.39, 32.15],
      [-84.01, 56.66],
      [-89.45, -137.31],
      [-85.6, -42.0],
      [-87.0, 120.0],
    ];
    // Every 11 days for a year from the table's start, so the stays fall on every part of the month.
    let passes = 0;
    let fails = 0;
    for (const [latDeg, lonDeg] of sites)
      for (let k = 0; k < 33; k++) {
        const q: StayQuery = {
          ...DEFAULT_STAY,
          site: { id: 'test', body: 'moon', latDeg, lonDeg },
          landingUtc: new Date(eph.startUtcMs + DAY_MS + k * 11 * DAY_MS).toISOString(),
        };
        const full = verdictOf(q, dem, eph, false);
        expect(verdictOf(q, dem, eph, true).verdict).toEqual(full.verdict);
        if (full.verdict.pass) passes++;
        else fails++;
      }
    expect(passes).toBeGreaterThan(0);
    expect(fails).toBeGreaterThan(0);
  }, 120_000);
});
