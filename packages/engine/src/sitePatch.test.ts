import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type MissionsJson, parseMissions } from './landerData';
import { decodeHeights, heightAtM } from './marsData';
import {
  decodePatch,
  parseSites,
  patchHeightM,
  patchKey,
  patchSlopes,
  type SitePatch,
  type SitePatchMeta,
  type SitesJson,
} from './sitePatch';
import { readPngRgb } from './testPng';

const META: SitePatchMeta = { minM: 0, maxM: 100, latDeg: 10, lonDeg: 20, halfDeg: 1, lonHalfDeg: 1 };
const MOON_RADIUS_M = 1_737_400;

/** A 3 × 3 patch whose rows run from the north edge: heights 0–8 m. */
const patch: SitePatch = {
  meta: META,
  width: 3,
  height: 3,
  metres: Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
};

describe('a close-up patch', () => {
  it('reads heights from red and green with 32768 as zero', () => {
    const rgba = [128, 0, 0, 255, 128, 100, 0, 255, 127, 255, 0, 255, 0, 0, 0, 255];
    expect(Array.from(decodePatch(META, rgba, 2, 2).metres)).toEqual([0, 100, -1, -32768]);
  });

  it('interpolates between pixels, with the north edge on the first row', () => {
    expect(patchHeightM(patch, 11, 19)).toBe(0); // north-west corner
    expect(patchHeightM(patch, 11, 21)).toBe(2); // north-east corner
    expect(patchHeightM(patch, 9, 19)).toBe(6); // south-west corner
    expect(patchHeightM(patch, 10, 20)).toBe(4);
    expect(patchHeightM(patch, 10.5, 20)).toBeCloseTo(2.5, 9); // halfway from the middle (4) to the top row (1)
    expect(patchHeightM(patch, 10, 20.5)).toBeCloseTo(4.5, 9);
  });

  it('knows nothing outside its square', () => {
    expect(patchHeightM(patch, 11.01, 20)).toBeUndefined();
    expect(patchHeightM(patch, 10, 18.99)).toBeUndefined();
  });

  it('reads the keys of sites.json and names a mission’s patch', () => {
    const sites = parseSites({ moon_apollo11: { min: -2367, max: -1305, lat: 0.6741, lon: 23.473, half: 1 } });
    expect(sites.moon_apollo11).toEqual({
      minM: -2367,
      maxM: -1305,
      latDeg: 0.6741,
      lonDeg: 23.473,
      halfDeg: 1,
      lonHalfDeg: 1,
      pixM: undefined,
      source: undefined,
    });
    const [apollo11] = parseMissions({
      note: '',
      sources: {},
      missions: [
        {
          id: 'apollo11',
          b: 'Moon',
          n: 'Apollo 11',
          by: 'NASA',
          st: 'crew',
          d: '1969-07-20',
          lat: 0.6741,
          lon: 23.473,
          site: ['Tranquility', ''],
          patch: 'apollo11',
          note: ['', ''],
        },
      ],
    });
    expect(patchKey(apollo11)).toBe('moon_apollo11');
  });
});

describe('the slope map of a patch', () => {
  const size = 7;
  const ramp = (heightAt: (col: number, row: number) => number): SitePatch => ({
    meta: { ...META, latDeg: 0 },
    width: size,
    height: size,
    metres: Float32Array.from({ length: size * size }, (_, i) => heightAt(i % size, Math.floor(i / size))),
  });
  /** What the globe shader does with a red or green byte. */
  const tilt = (byte: number) => {
    const s = (byte / 255) * 2 - 1;
    return Math.sign(s) * s * s;
  };
  // One pixel is 2/7 of a degree: about 8.7 km on the Moon. A rise of 870 m a pixel is a gradient of 0.1.
  const pixelM = ((2 / size) * Math.PI * MOON_RADIUS_M) / 180;

  it('is flat for flat ground', () => {
    const px = patchSlopes(
      ramp(() => 500),
      MOON_RADIUS_M,
    );
    expect(Array.from(px.slice(0, 4))).toEqual([128, 128, 128, 255]);
  });

  it('tilts the normal west when the ground rises to the east, and east when it falls', () => {
    const middle = (size * 3 + 3) * 4;
    const rising = patchSlopes(
      ramp((col) => col * 0.1 * pixelM),
      MOON_RADIUS_M,
    );
    expect(tilt(rising[middle])).toBeCloseTo(-0.0995, 2);
    expect(tilt(rising[middle + 1])).toBeCloseTo(0, 2);
    const falling = patchSlopes(
      ramp((col) => -col * 0.1 * pixelM),
      MOON_RADIUS_M,
    );
    expect(tilt(falling[middle])).toBeCloseTo(0.0995, 2);
  });

  it('tilts the normal south when the ground rises to the north (up the image)', () => {
    const middle = (size * 3 + 3) * 4;
    const north = patchSlopes(
      ramp((_, row) => (size - row) * 0.2 * pixelM),
      MOON_RADIUS_M,
    );
    expect(tilt(north[middle + 1])).toBeCloseTo(-0.196, 2);
    expect(tilt(north[middle])).toBeCloseTo(0, 2);
  });
});

const rawDir = fileURLToPath(new URL('../../../pipeline/raw/landfall/', import.meta.url));
const have = ['data/sites.json', 'img/moon_height.png', 'img/mars_height.png'].every((f) => existsSync(rawDir + f));

describe.skipIf(!have)('the Landfall close-up patches', () => {
  const missions = parseMissions(
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../data/missions.json', import.meta.url)), 'utf8'),
    ) as MissionsJson,
  );
  // Vitest runs a skipped suite's body to collect its tests, so nothing here may read a file that isn't there.
  const sites = have ? parseSites(JSON.parse(readFileSync(`${rawDir}data/sites.json`, 'utf8')) as SitesJson) : {};
  const world = (body: 'moon' | 'mars') => {
    const png = readPngRgb(`${rawDir}img/${body}_height.png`);
    return decodeHeights(png.rgba, png.width, png.height);
  };
  const globes = have ? { moon: world('moon'), mars: world('mars') } : undefined;
  const withPatch = missions.filter((m) => m.patch);

  it('has a file and a header for every mission that offers a close-up', () => {
    // Surveyor 3 shares Apollo 12's patch and Ingenuity shares Perseverance's.
    expect(withPatch).toHaveLength(28);
    expect(new Set(withPatch.map(patchKey))).toHaveLength(26);
    for (const m of withPatch) {
      const key = patchKey(m) ?? '';
      expect(sites[key], key).toBeDefined();
      expect(existsSync(`${rawDir}img/sites/${key}.png`), key).toBe(true);
    }
  });

  it('stores heights that match the range in its header', () => {
    for (const m of withPatch) {
      const key = patchKey(m) ?? '';
      const png = readPngRgb(`${rawDir}img/sites/${key}.png`);
      const p = decodePatch(sites[key], png.rgba, png.width, png.height);
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const m of p.metres) {
        lo = Math.min(lo, m);
        hi = Math.max(hi, m);
      }
      expect(lo, key).toBeCloseTo(sites[key].minM, -1);
      expect(hi, key).toBeCloseTo(sites[key].maxM, -1);
    }
  });

  it('puts every landing on the terrain its close-up shows', () => {
    // The listed coordinates are checked against the globe height map, which is a separate file: a longitude of the
    // wrong sign lands on terrain that is hundreds or thousands of metres off the patch's range.
    for (const m of withPatch) {
      if (m.latDeg === undefined || m.lonDeg === undefined || !globes) continue;
      const meta = sites[patchKey(m) ?? ''];
      expect(Math.abs(m.latDeg - meta.latDeg), m.id).toBeLessThanOrEqual(meta.halfDeg);
      expect(Math.abs(m.lonDeg - meta.lonDeg), m.id).toBeLessThanOrEqual(meta.lonHalfDeg);
      const globeM = heightAtM(m.body === 'Moon' ? globes.moon : globes.mars, m.latDeg, m.lonDeg);
      expect(globeM, m.id).toBeGreaterThanOrEqual(meta.minM - 100);
      expect(globeM, m.id).toBeLessThanOrEqual(meta.maxM + 100);
    }
  });
});

describe('the key a close-up is filed under', () => {
  it('is the named patch, else the mission itself', () => {
    const base = { body: 'Moon' as const, id: 'viper' };
    expect(patchKey({ ...base, patch: 'apollo12' } as Parameters<typeof patchKey>[0])).toBe('moon_apollo12');
    expect(patchKey(base as Parameters<typeof patchKey>[0])).toBe('moon_viper');
    expect(patchKey({ body: 'Mars', id: 'viking1' } as Parameters<typeof patchKey>[0])).toBe('mars_viking1');
  });
});

// The close-ups `pipeline/siteline_pipeline/site_patches.py` cuts from NASA's south-pole terrain, once it has run here.
const outDir = fileURLToPath(new URL('../../../pipeline/out/sites/', import.meta.url));
const haveOut = existsSync(`${outDir}sites.json`) && existsSync(`${outDir}sites.manifest.json`) && have;
/** The finest cell each source has, in metres: a patch must not claim finer. */
const SOURCE_CELL_M: Record<string, number> = { 'a3clr-sfs-5m': 5, 'lola-spole-10m': 10 };

describe.skipIf(!haveOut)("the pipeline's south-pole close-ups", () => {
  const missions = parseMissions(
    JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../data/missions.json', import.meta.url)), 'utf8'),
    ) as MissionsJson,
  );
  const sites = haveOut ? parseSites(JSON.parse(readFileSync(`${outDir}sites.json`, 'utf8')) as SitesJson) : {};
  const demo = haveOut ? parseSites(JSON.parse(readFileSync(`${rawDir}data/sites.json`, 'utf8')) as SitesJson) : {};
  const manifest = haveOut
    ? (JSON.parse(readFileSync(`${outDir}sites.manifest.json`, 'utf8')) as {
        made: { mission: string; key: string; centreM: number; lola10mCentreM: number }[];
      })
    : { made: [] };
  const cut = Object.entries(sites).filter(([, meta]) => meta.source !== undefined);

  it('cuts a close-up for some sites and keeps every one of the demo', () => {
    expect(cut.length).toBeGreaterThan(0);
    // The app reads this file in place of the demo's, so a demo close-up it dropped would disappear from the app.
    for (const key of Object.keys(demo)) expect(sites[key], key).toBeDefined();
  });

  it('is square on the ground, not in degrees', () => {
    for (const [key, meta] of cut) {
      const eastM = meta.lonHalfDeg * Math.cos((meta.latDeg * Math.PI) / 180);
      expect(eastM / meta.halfDeg, key).toBeCloseTo(1, 2);
    }
  });

  it('claims no finer cells than its source has', () => {
    for (const [key, meta] of cut) {
      expect(SOURCE_CELL_M[meta.source ?? ''], key).toBeDefined();
      expect(meta.pixM ?? 0, key).toBeGreaterThanOrEqual(SOURCE_CELL_M[meta.source ?? '']);
    }
  });

  // Nine 2048 × 2048 images to decode: more than the default five seconds.
  it('stores heights that match the range in its header', { timeout: 60_000 }, () => {
    for (const [key, meta] of cut) {
      const png = readPngRgb(`${outDir}${key}.png`);
      const p = decodePatch(meta, png.rgba, png.width, png.height);
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const v of p.metres) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(lo, key).toBeCloseTo(meta.minM, -1);
      expect(hi, key).toBeCloseTo(meta.maxM, -1);
    }
  });

  it('holds the landing it was cut for, south of 83°', () => {
    for (const { mission, key } of manifest.made) {
      const m = missions.find((x) => x.id === mission);
      const meta = sites[key];
      if (!m || m.latDeg === undefined || m.lonDeg === undefined) throw new Error(`${mission}: no place`);
      expect(m.latDeg, mission).toBeLessThan(-83);
      expect(patchKey(m), mission).toBe(key);
      expect(Math.abs(m.latDeg - meta.latDeg), mission).toBeLessThanOrEqual(meta.halfDeg);
      expect(Math.abs(m.lonDeg - meta.lonDeg), mission).toBeLessThanOrEqual(meta.lonHalfDeg);
    }
  });

  it("agrees with NASA's 10 m terrain at the site", () => {
    // The Artemis models are a separate shape-from-shading solution, so the 10 m map is an independent reference for
    // them (on the first build they agreed within 0.3 m); a patch cut from the 10 m map must match it to resampling.
    for (const { mission, key, centreM, lola10mCentreM } of manifest.made) {
      const tolerance = sites[key].source === 'lola-spole-10m' ? 2 : 5;
      expect(Math.abs(centreM - lola10mCentreM), mission).toBeLessThan(tolerance);
    }
  });
});
