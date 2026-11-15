import { describe, expect, it } from 'vitest';
import { coordinate, type FoundSite, landingDate, pickRegions, rankFound, searchRegions } from './landingAgent';

const regions = [
  { name: 'Haworth', lat: -86.8, lon: -22.8, sizeKm: 17 },
  { name: 'Nobile Rim 1', lat: -85.4, lon: 37.5, sizeKm: 10 },
  { name: 'Nobile Rim 2', lat: -83.9, lon: 58.6, sizeKm: 10 },
  { name: 'Malapert Massif', lat: -86, lon: -0.2, sizeKm: 12 },
];

describe('pickRegions', () => {
  it('matches names loosely, so one word can pick several regions', () => {
    expect(pickRegions(regions, ['nobile']).map((r) => r.name)).toEqual(['Nobile Rim 1', 'Nobile Rim 2']);
    expect(pickRegions(regions, ['Malapert massif']).map((r) => r.name)).toEqual(['Malapert Massif']);
  });
  it('searches everywhere when no region is named, or none matches', () => {
    expect(pickRegions(regions)).toHaveLength(4);
    expect(pickRegions(regions, ['Shackleton'])).toHaveLength(4);
    expect(pickRegions(regions, [42, ''])).toHaveLength(4);
  });
});

describe('landingDate', () => {
  const first = Date.parse('2026-01-01T00:00:00Z');
  const last = Date.parse('2035-12-31T23:00:00Z');
  it('reads an ISO date, and uses the fallback when there is none', () => {
    expect(landingDate('2028-03-01', 'x', first, last)).toBe('2028-03-01T00:00:00.000Z');
    expect(landingDate(undefined, '2027-01-01T00:00:00.000Z', first, last)).toBe('2027-01-01T00:00:00.000Z');
  });
  it('refuses a date it cannot read or the tables do not cover, saying why', () => {
    expect(() => landingDate('next spring', 'x', first, last)).toThrow(/ISO 8601/);
    expect(() => landingDate('2040-01-01', 'x', first, last)).toThrow(/2026-01-01 to 2035-12-31/);
  });
});

describe('rankFound', () => {
  const site = (region: string, sun: number, earth: number, slope: number, robotFit?: FoundSite['robotFit']) => ({
    region,
    latDeg: -86,
    lonDeg: 0,
    sunFractionMin: sun,
    earthVisiblePct: earth,
    slope100mDeg: slope,
    robotFit,
  });
  it('puts more Sun first, then more Earth, then flatter ground', () => {
    const ranked = rankFound([site('a', 0.8, 90, 3), site('b', 1, 50, 8), site('c', 0.8, 90, 2)]);
    expect(ranked.map((s) => s.region)).toEqual(['b', 'c', 'a']);
  });
  it('puts a site the robot fits ahead of a sunnier one it does not', () => {
    const ranked = rankFound([site('sunny', 1, 100, 1, 'does_not_fit'), site('fits', 0.6, 70, 6, 'fits')]);
    expect(ranked.map((s) => s.region)).toEqual(['fits', 'sunny']);
  });
});

describe('searchRegions', () => {
  const site = { latDeg: -85, lonDeg: 30, sunFractionMin: 1, earthVisiblePct: 100, slope100mDeg: 3 };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('runs a few regions at once and stops starting new ones once it has enough', async () => {
    let running = 0;
    let most = 0;
    const started: string[] = [];
    const out = await searchRegions(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      async (r) => {
        started.push(r);
        running++;
        most = Math.max(most, running);
        await wait(5);
        running--;
        return { sites: r === 'a' || r === 'b' ? [site] : [], checked: 1 };
      },
      { atOnce: 2, enough: 2 },
    );
    expect(most).toBe(2);
    expect(out.results.flatMap((r) => r.sites)).toHaveLength(2);
    expect(out.stoppedEarly).toBe(true);
    expect(started).not.toContain('f');
  });

  it('answers as soon as it has enough, without waiting for slower regions still running', async () => {
    const reported: string[] = [];
    const t = Date.now();
    const out = await searchRegions(
      ['fast', 'slow'],
      async (r) => {
        await wait(r === 'slow' ? 300 : 5);
        return { sites: r === 'fast' ? [site] : [], checked: 1 };
      },
      { atOnce: 2, enough: 1, onResult: (r) => reported.push(r.area) },
    );
    expect(Date.now() - t).toBeLessThan(200);
    expect(out.results.map((r) => r.area)).toEqual(['fast']);
    await wait(350);
    // The slow region finished after the answer and was not reported.
    expect(reported).toEqual(['fast']);
  });

  it('answers a while after the first find, without waiting to have enough', async () => {
    const t = Date.now();
    const out = await searchRegions(
      ['one', 'slow1', 'slow2'],
      async (r) => {
        await wait(r === 'one' ? 5 : 400);
        return { sites: r === 'one' ? [site] : [], checked: 1 };
      },
      { atOnce: 3, enough: 3, graceAfterFirstMs: 50 },
    );
    expect(Date.now() - t).toBeLessThan(300);
    expect(out.results.flatMap((r) => r.sites)).toHaveLength(1);
  });

  it('keeps going past the deadline while nothing has been found', async () => {
    const out = await searchRegions(
      ['a', 'b'],
      async (r) => {
        await wait(60);
        return { sites: r === 'b' ? [site] : [], checked: 1 };
      },
      { atOnce: 1, deadlineMs: 20 },
    );
    expect(out.results.map((r) => r.area)).toEqual(['a', 'b']);
  });

  it('reports each region as it finishes, and keeps going past a failed one', async () => {
    const seen: string[] = [];
    const out = await searchRegions(
      ['x', 'y'],
      async (r) => {
        if (r === 'x') throw new Error('no terrain');
        return { sites: [], checked: 3 };
      },
      { onResult: (r) => seen.push(`${r.area}:${r.checked}`) },
    );
    expect(seen.sort()).toEqual(['x:0', 'y:3']);
    expect(out.stoppedEarly).toBe(false);
  });
});

describe('coordinate', () => {
  it('takes numbers and numeric strings in range, and refuses the rest', () => {
    expect(coordinate(-86.5, 'latDeg', -90, 90)).toBe(-86.5);
    expect(coordinate('12', 'lonDeg', -180, 180)).toBe(12);
    expect(() => coordinate(-95, 'latDeg', -90, 90)).toThrow(/latDeg/);
    expect(() => coordinate('north', 'latDeg', -90, 90)).toThrow(/latDeg/);
  });
});
