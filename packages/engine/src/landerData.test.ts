import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canPlanAtPole,
  directionToLatLon,
  findMission,
  isFuture,
  localSolarHours,
  type Mission,
  type MissionsJson,
  marsRoutes,
  missionPlace,
  missionsFor,
  nextMission,
  parseMissions,
  parseTracks,
  passesFilter,
  pinStyleOf,
  ROUTE_COLOURS,
  roverProgress,
  SOL_MS,
  solAt,
  sunAzimuthDeg,
  sunHeightDeg,
  type TracksJson,
  toneOf,
} from './landerData';

const read = (url: string) => readFileSync(fileURLToPath(new URL(url, import.meta.url)), 'utf8');
const missionsJson = JSON.parse(read('../../../data/missions.json')) as MissionsJson;
const missions = parseMissions(missionsJson);
const get = (id: string): Mission => {
  const m = findMission(missions, id);
  if (!m) throw new Error(`no mission ${id}`);
  return m;
};
const day = (iso: string) => Date.parse(iso);

describe('the mission list', () => {
  it('reads all 46 rows, each once, with a place exactly when it has coordinates', () => {
    expect(missions).toHaveLength(46);
    expect(new Set(missions.map((m) => m.id)).size).toBe(46);
    expect(missions.filter((m) => m.body === 'Moon')).toHaveLength(33);
    expect(missions.filter((m) => m.body === 'Mars')).toHaveLength(13);
    for (const m of missions) expect(m.latDeg === undefined).toBe(m.lonDeg === undefined);
  });

  it('keeps every position on its planet', () => {
    for (const m of missions) {
      if (m.latDeg === undefined || m.lonDeg === undefined) continue;
      expect(Math.abs(m.latDeg)).toBeLessThanOrEqual(90);
      expect(Math.abs(m.lonDeg)).toBeLessThanOrEqual(180);
    }
  });

  it('cites a source that exists for every source it names', () => {
    for (const m of missions) for (const id of m.sourceIds) expect(missionsJson.sources[id]).toBeDefined();
  });

  it('dates a bare month as its 15th and a bare year as 1 July', () => {
    expect(get('griffin1').tUtcMs).toBe(day('2026-11-15'));
    expect(
      parseMissions({ ...missionsJson, missions: [{ ...missionsJson.missions[0], id: 'x', d: '2031' }] })[0].tUtcMs,
    ).toBe(day('2031-07-01'));
  });

  it('refuses a row the app cannot show', () => {
    const row = missionsJson.missions[0];
    expect(() => parseMissions({ ...missionsJson, missions: [row, row] })).toThrow('twice');
    expect(() => parseMissions({ ...missionsJson, missions: [{ ...row, st: 'flying' as never }] })).toThrow('status');
    expect(() => parseMissions({ ...missionsJson, missions: [{ ...row, lon: null }] })).toThrow('coordinate');
    expect(() => parseMissions({ ...missionsJson, missions: [{ ...row, d: 'soon' }] })).toThrow('date');
  });
});

describe('what has landed on the date shown', () => {
  const nov2026 = day('2026-11-11');

  it('counts planned and expected missions as future whatever the date', () => {
    expect(isFuture(get('griffin1'), day('2030-01-01'))).toBe(true);
    expect(isFuture(get('viper'), day('2035-01-01'))).toBe(true);
    expect(isFuture(get('apollo11'), nov2026)).toBe(false);
  });

  it('counts a landed mission as future on a date before its landing', () => {
    expect(isFuture(get('apollo11'), day('1960-01-01'))).toBe(true);
    expect(pinStyleOf(get('apollo11'), day('1960-01-01'))).toBe('future');
    expect(pinStyleOf(get('apollo11'), nov2026)).toBe('crew');
    expect(pinStyleOf(get('im1'), nov2026)).toBe('tipped');
  });

  it('sorts each filter the way the list shows it', () => {
    const ids = (body: 'Moon' | 'Mars', f: Parameters<typeof missionsFor>[2]) =>
      missionsFor(missions, body, f, nov2026).map((m) => m.id);
    expect(ids('Mars', 'active')).toEqual(['curiosity', 'perseverance']);
    expect(ids('Mars', 'future')).toEqual(['mmx', 'rosalind']);
    expect(ids('Mars', 'lost')).toEqual(['mpl']);
    expect(ids('Moon', 'landed')).toContain('apollo11');
    expect(ids('Moon', 'landed')).not.toContain('griffin1');
    expect(ids('Moon', 'lost')).toEqual(expect.arrayContaining(['ranger7', 'lcross', 'surveyor2', 'peregrine']));
    expect(ids('Moon', 'all')).toHaveLength(33);
    // Date order within a list.
    const all = missionsFor(missions, 'Mars', 'all', nov2026).map((m) => m.tUtcMs);
    expect(all).toEqual([...all].sort((a, b) => a - b));
  });

  it('leaves a lost mission out of "landed" and a future one out of "active"', () => {
    expect(passesFilter(get('surveyor4'), 'landed', nov2026)).toBe(false);
    expect(passesFilter(get('surveyor4'), 'lost', nov2026)).toBe(true);
    expect(passesFilter(get('perseverance'), 'active', day('2010-01-01'))).toBe(false);
    expect(passesFilter(get('perseverance'), 'future', day('2010-01-01'))).toBe(true);
  });

  it('names the next mission on each body', () => {
    expect(nextMission(missions, 'Moon')?.id).toBe('griffin1');
    expect(nextMission(missions, 'Mars')?.id).toBe('mmx');
  });

  it('colours the chips: crewed amber, working green, lost red', () => {
    expect([get('apollo11'), get('curiosity'), get('mpl'), get('surveyor1')].map(toneOf)).toEqual([
      'warn',
      'good',
      'bad',
      'plain',
    ]);
  });

  it('offers the landing-site check only to south-polar missions inside the pole view', () => {
    expect(canPlanAtPole(get('im2'))).toBe(true);
    expect(canPlanAtPole(get('viper'))).toBe(true);
    expect(canPlanAtPole(get('im1'))).toBe(false); // 80.13°S is outside the pole view
    expect(canPlanAtPole(get('apollo11'))).toBe(false);
    expect(canPlanAtPole(get('bg2'))).toBe(false); // no landing place yet
  });
});

describe('rovers on Mars', () => {
  // Three route points one sol apart, and two helicopter flights.
  const json: TracksJson = {
    fetched: '2026-11-04',
    m20: {
      now: { sol: 12, lon: 77.4, lat: 18.4, km: 1.2 },
      pts: [
        [77.0, 18.0, 0],
        [77.1, 18.0, 5],
        [77.2, 18.0, 12],
      ],
    },
    msl: { now: { sol: 5000, lon: 137.4, lat: -4.8, km: 38 }, pts: [[137.0, -4.5, 0]] },
    heli: [
      [1, 6, 77.05, 18.01],
      [2, 20, 77.3, 18.02],
    ],
  };
  const tracks = parseTracks(json);
  const per = get('perseverance');
  const at = (sol: number) => per.tUtcMs + sol * SOL_MS + 1000;

  it('counts sols from the landing day', () => {
    expect(solAt(per, per.tUtcMs)).toBe(0);
    expect(solAt(per, per.tUtcMs + 3 * SOL_MS)).toBe(3);
    expect(solAt(per, per.tUtcMs - 1)).toBe(-1);
  });

  it('puts Perseverance at the last route point on or before the sol, and the first before the route starts', () => {
    const lonAt = (sol: number) => missionPlace(missions, per, tracks, at(sol))?.lonDeg;
    expect(lonAt(-3)).toBe(77.0);
    expect(lonAt(4)).toBe(77.0);
    expect(lonAt(5)).toBe(77.1);
    expect(lonAt(900)).toBe(77.2);
  });

  it('puts Ingenuity at its airfield until the first flight, then at the last flight to date', () => {
    const heli = get('ingenuity');
    expect(missionPlace(missions, heli, tracks, at(2))).toEqual({ latDeg: heli.latDeg, lonDeg: heli.lonDeg });
    expect(missionPlace(missions, heli, tracks, at(6))).toEqual({ latDeg: 18.01, lonDeg: 77.05 });
    expect(missionPlace(missions, heli, tracks, at(30))).toEqual({ latDeg: 18.02, lonDeg: 77.3 });
  });

  it('keeps Curiosity at the position NASA published, and every other mission where it landed', () => {
    expect(missionPlace(missions, get('curiosity'), tracks, day('2026-06-01'))).toEqual({
      latDeg: -4.8,
      lonDeg: 137.4,
    });
    expect(missionPlace(missions, get('viking1'), tracks, day('2026-06-01'))).toEqual({
      latDeg: 22.27,
      lonDeg: -47.95,
    });
    expect(missionPlace(missions, get('mmx'), tracks, day('2026-06-01'))).toBeUndefined();
  });

  it('shares the total distance along the route and stops at the last sol NASA published', () => {
    const none = roverProgress(missions, tracks, 'perseverance', at(-5));
    const half = roverProgress(missions, tracks, 'perseverance', at(5));
    const all = roverProgress(missions, tracks, 'perseverance', at(400));
    expect(none).toEqual({ km: 0, sol: 0 });
    expect(half.sol).toBe(5);
    expect(half.km).toBeCloseTo(0.6, 1); // the first leg is as long as the second: half the 1.2 km
    expect(all).toEqual({ km: 1.2, sol: 12 });
    expect(roverProgress(missions, tracks, 'curiosity', at(0))).toEqual({ km: 38, sol: 5000 });
  });

  it('draws only what has happened by the date shown', () => {
    const lines = (ms: number) => marsRoutes(missions, tracks, ms);
    // Curiosity landed years before Perseverance, so its route is always there; Perseverance's and Ingenuity's grow.
    expect(lines(at(-1)).map((l) => l.colourHex)).toEqual([ROUTE_COLOURS.msl]);
    expect(lines(at(6)).map((l) => l.points.length)).toEqual([2, 1, 1]);
    expect(lines(at(30)).map((l) => l.points.length)).toEqual([3, 1, 2]);
    expect(lines(at(30))[2].dots).toBe(true);
    expect(marsRoutes(missions, tracks, day('2005-01-01'))).toHaveLength(0);
  });

  const haveTracks = existsSync(
    fileURLToPath(new URL('../../../pipeline/raw/landfall/data/tracks.json', import.meta.url)),
  );
  it.skipIf(!haveTracks)('puts the real Perseverance at NASA’s published position on the day the file was read', () => {
    const real = parseTracks(JSON.parse(read('../../../pipeline/raw/landfall/data/tracks.json')) as TracksJson);
    const place = missionPlace(missions, per, real, day(real.fetched));
    expect(place?.latDeg).toBeCloseTo(real.m20.now.latDeg, 1);
    expect(place?.lonDeg).toBeCloseTo(real.m20.now.lonDeg, 1);
    const progress = roverProgress(missions, real, 'perseverance', day('2030-01-01'));
    expect(progress).toEqual({ km: real.m20.now.km, sol: real.m20.now.sol });
    // The route is the one NASA draws: 45 km driven means a route of a few tens of kilometres in length.
    const lines = marsRoutes(missions, real, day('2030-01-01'));
    expect(lines.map((l) => l.colourHex)).toHaveLength(3);
  });
});

describe('sunlight at a place', () => {
  it('puts the Sun at 90° under the subsolar point, 0° a quarter turn away and below the horizon beyond', () => {
    expect(sunHeightDeg(10, 20, 10, 20)).toBeCloseTo(90, 4); // asin is blunt next to 1
    expect(sunHeightDeg(0, 90, 0, 0)).toBeCloseTo(0, 9);
    expect(sunHeightDeg(0, 180, 0, 0)).toBeCloseTo(-90, 9);
    expect(sunHeightDeg(60, 0, 0, 0)).toBeCloseTo(30, 9);
  });

  it('gives the Sun’s compass bearing: north 0, east 90, south 180, west 270', () => {
    expect(sunAzimuthDeg(0, 0, 45, 0)).toBeCloseTo(0, 9);
    expect(sunAzimuthDeg(0, 0, 0, 40)).toBeCloseTo(90, 9);
    expect(sunAzimuthDeg(0, 0, -45, 0)).toBeCloseTo(180, 9);
    expect(sunAzimuthDeg(0, 0, 0, -40)).toBeCloseTo(270, 9);
    // From 60°N the Sun over the equator on the same meridian is due south.
    expect(sunAzimuthDeg(60, 10, 0, 10)).toBeCloseTo(180, 9);
  });

  it('tells local solar time from the longitude east of the subsolar point', () => {
    expect(localSolarHours(30, 30)).toBe(12);
    expect(localSolarHours(120, 30)).toBeCloseTo(18, 9);
    expect(localSolarHours(-60, 30)).toBeCloseTo(6, 9);
    expect(localSolarHours(-170, 170)).toBeCloseTo(13.3333, 3); // 20° east, wrapping through 180°
  });

  it('reads the point a body-fixed vector points at', () => {
    expect(directionToLatLon([1, 0, 0])).toEqual({ latDeg: 0, lonDeg: 0 });
    const p = directionToLatLon([0, 2, 0]);
    expect(p.latDeg).toBe(0);
    expect(p.lonDeg).toBeCloseTo(90, 9);
    expect(directionToLatLon([0, 0, -3]).latDeg).toBeCloseTo(-90, 9);
  });
});
