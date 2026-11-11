import { describe, expect, it } from 'vitest';
import { discFraction } from './disc';
import { EPHEMERIS_FORMAT, parseEphemeris } from './ephemeris';
import { elevAz, siteFrame } from './frames';
import { HORIZON_BINS, horizonAt, horizonFromInt16 } from './horizon';
import { hornSlopeDeg, planeFitSlopeDeg, polarScaleFactor } from './slope';
import { add, DEG, scale, type Vec3 } from './vec';

describe('discFraction', () => {
  it('gives 0, one half and 1 at x = -1, 0 and 1', () => {
    expect(discFraction(-0.27, 0, 0.27)).toBe(0);
    expect(discFraction(0, 0, 0.27)).toBeCloseTo(0.5, 12);
    expect(discFraction(0.27, 0, 0.27)).toBe(1);
  });
  it('clamps outside the disc and is symmetric about the horizon', () => {
    expect(discFraction(-5, 0, 0.27)).toBe(0);
    expect(discFraction(5, 0, 0.27)).toBe(1);
    expect(discFraction(1.1, 1, 0.27) + discFraction(0.9, 1, 0.27)).toBeCloseTo(1, 12);
  });
});

describe('site frame and elevation/azimuth', () => {
  const site = siteFrame(-85, 30);
  const along = (v: Vec3) => add(site.pKm, scale(v, 1000));

  it('puts the zenith at 90° and the cardinal directions at 0, 90, 180 and 270°', () => {
    expect(elevAz(along(site.u), site).elevDeg).toBeCloseTo(90, 9);
    expect(elevAz(along(site.n), site)).toMatchObject({ elevDeg: expect.closeTo(0, 9), azDeg: expect.closeTo(0, 9) });
    expect(elevAz(along(site.e), site).azDeg).toBeCloseTo(90, 9);
    expect(elevAz(along(scale(site.n, -1)), site).azDeg).toBeCloseTo(180, 9);
    expect(elevAz(along(scale(site.e, -1)), site).azDeg).toBeCloseTo(270, 9);
  });

  it('measures azimuth from the 0° meridian at the pole, whatever longitude is given', () => {
    const pole = siteFrame(-90, 123);
    expect(pole.n[0]).toBeCloseTo(1, 12);
    expect(pole.n[1]).toBeCloseTo(0, 12);
  });

  it('gives a Sun elevation of minus the sub-solar latitude at the south pole', () => {
    const subSolarLatDeg = 1.2;
    const d = 1.496e8;
    const sun: Vec3 = [d * Math.cos(subSolarLatDeg * DEG), 0, d * Math.sin(subSolarLatDeg * DEG)];
    // Within the 0.0007° parallax of the Sun across the Moon's radius.
    expect(elevAz(sun, siteFrame(-90, 0)).elevDeg).toBeCloseTo(-subSolarLatDeg, 2);
  });
});

describe('horizon mask', () => {
  it('interpolates between bins and wraps at 0° and 360°', () => {
    const raw = new Int16Array(HORIZON_BINS);
    raw[1] = 400;
    raw[HORIZON_BINS - 1] = 200;
    const mask = horizonFromInt16(raw);
    expect(horizonAt(mask, 0.25)).toBeCloseTo(2, 6);
    expect(horizonAt(mask, 359.75)).toBeCloseTo(1, 6);
    expect(horizonAt(mask, -0.25)).toBeCloseTo(1, 6);
    expect(horizonAt(mask, 720.5)).toBeCloseTo(4, 6);
  });
});

describe('slope', () => {
  it('is 0 for flat ground and 45° for a 1:1 plane at the pole', () => {
    expect(hornSlopeDeg([5, 5, 5, 5, 5, 5, 5, 5, 5], 20, -90)).toBe(0);
    expect(hornSlopeDeg([-20, 0, 20, -20, 0, 20, -20, 0, 20], 20, -90)).toBeCloseTo(45, 9);
  });
  it('corrects the grid spacing for the polar stereographic scale factor', () => {
    expect(polarScaleFactor(-90)).toBe(1);
    expect(polarScaleFactor(-80)).toBeCloseTo(1.0077, 4);
  });
  it('fits a plane over a baseline', () => {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let x = -50; x <= 50; x += 10) {
      for (let y = -50; y <= 50; y += 10) {
        xs.push(x);
        ys.push(y);
        zs.push(0.1 * x + 0.05 * y + 7);
      }
    }
    expect(planeFitSlopeDeg(xs, ys, zs)).toBeCloseTo(Math.atan(Math.hypot(0.1, 0.05)) / DEG, 9);
  });
});

describe('ephemeris table', () => {
  function table(samples: number[][]) {
    const header = {
      format: EPHEMERIS_FORMAT,
      frame: 'TEST',
      centre: 'MOON',
      abcorr: 'NONE',
      bodies: ['SUN', 'EARTH'],
      units: 'km',
      startUtc: '2026-01-01T00:00:00Z',
      startUtcMs: Date.UTC(2026, 0, 1),
      stepMs: 3_600_000,
      count: samples.length,
      kernels: [],
      dataSha256: '',
    };
    const json = new TextEncoder().encode(JSON.stringify(header));
    const offset = Math.ceil((4 + json.length) / 4) * 4;
    const buf = new ArrayBuffer(offset + samples.length * 24);
    new DataView(buf).setUint32(0, json.length, true);
    new Uint8Array(buf, 4).set(json);
    new Float32Array(buf, offset).set(samples.flat());
    return parseEphemeris(buf);
  }

  it('reads the header and interpolates between hourly samples', () => {
    const t = table([
      [0, 0, 0, 10, 0, 0],
      [100, 0, 0, 20, 0, 0],
      [200, 0, 0, 30, 0, 0],
    ]);
    const t0 = Date.UTC(2026, 0, 1);
    expect(t.endUtcMs - t.startUtcMs).toBe(7_200_000);
    expect(t.positionKm('sun', t0 + 5_400_000)[0]).toBeCloseTo(150, 6);
    expect(t.positionKm('earth', t0 + 7_200_000)[0]).toBeCloseTo(30, 6);
    expect(() => t.positionKm('sun', t0 - 1)).toThrow(RangeError);
  });
});
