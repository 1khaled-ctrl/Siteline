import { describe, expect, it } from 'vitest';
import { MOON_RADIUS_M } from './dem';
import {
  bouncedIrradiance,
  EARTH_GEOMETRIC_ALBEDO,
  earthshineIrradiance,
  type Horizon,
  lambertPhase,
} from './indirect';
import { type LocalGrid, sweepHorizon } from './surface';

const out = { size: 3, spacingM: 10, halfM: 10 };
/** The same skyline from every point: `elevDeg` high, `distM` away, in each of `n` azimuths. */
const ring = (n: number, elevDeg: number, distM: number): Horizon[] =>
  Array.from({ length: n }, (_, k) => ({
    azDeg: (360 * k) / n,
    elevRad: new Float32Array(9).fill((elevDeg * Math.PI) / 180),
    distM: new Float32Array(9).fill(distM),
  }));

describe('light scattered off the terrain', () => {
  it('is the albedo under a sky that is all sunlit terrain, and less as the terrain sinks', () => {
    // Walls rising to the zenith all round, all in full sunlight: the point sees nothing but lit ground.
    expect(bouncedIrradiance(out, ring(8, 90, 100), () => 1, 0.11)[4]).toBeCloseTo(0.11, 6);
    // Walls 30° high: sin² 30° of that.
    expect(bouncedIrradiance(out, ring(8, 30, 100), () => 1, 0.11)[4]).toBeCloseTo(0.11 * 0.25, 6);
    // Half as much sunlight on the walls, half as much scattered.
    expect(bouncedIrradiance(out, ring(8, 30, 100), () => 0.5, 0.11)[4]).toBeCloseTo(0.11 * 0.125, 6);
  });

  it('gets nothing from terrain below the point, dark terrain, or no terrain', () => {
    expect(bouncedIrradiance(out, ring(8, -2, 100), () => 1)[4]).toBe(0);
    expect(bouncedIrradiance(out, ring(8, 30, 100), () => 0)[4]).toBe(0);
    expect(bouncedIrradiance(out, ring(8, 30, 0), () => 1)[4]).toBe(0);
    expect(bouncedIrradiance(out, ring(8, 30, 100), () => Number.NaN)[4]).toBe(0);
    expect(bouncedIrradiance(out, [], () => 1)[4]).toBe(0);
  });

  it('lets a slope see the terrain below the level that it faces', () => {
    // Skylines 5° below the level all round: level ground sees none of that terrain.
    expect(bouncedIrradiance(out, ring(4, -5, 100), () => 1, 1)[4]).toBe(0);
    // Ground tilted 20° down toward the east (its normal leans east) sees 15° of terrain that way.
    const tilt = (20 * Math.PI) / 180;
    const normals = new Float32Array(27);
    for (let i = 0; i < 9; i++) normals.set([Math.sin(tilt), Math.cos(tilt), 0], 3 * i);
    const e = bouncedIrradiance(out, ring(4, -5, 100), () => 1, 1, normals);
    expect(e[4]).toBeCloseTo(Math.sin((15 * Math.PI) / 180) ** 2 / 4, 6);
  });

  it('reads the light from the slope between the point and its skyline, on the right side', () => {
    // Only the terrain east of the point is lit: of 4 sectors, the one facing east sees it.
    const lit = (east: number) => (east > 20 ? 1 : 0);
    const e = bouncedIrradiance(out, ring(4, 90, 100), lit, 1);
    expect(e[4]).toBeCloseTo(1 / 4, 6);
  });
});

describe('skylines toward one azimuth', () => {
  it('finds a wall’s height and how far off it is', () => {
    const size = 201;
    const up = new Float32Array(size * size);
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) {
        const e = -1000 + c * 10;
        const n = 1000 - r * 10;
        // Level ground (on the curved Moon) with a 100 m wall from 500 m east.
        up[r * size + c] = Math.sqrt(MOON_RADIUS_M ** 2 - e * e - n * n) - MOON_RADIUS_M + (e >= 500 ? 100 : 0);
      }
    const g: LocalGrid = { size, spacingM: 10, halfM: 1000, up };
    const h = sweepHorizon([g], g, 90);
    const i = 100 * size + 100; // the origin
    expect((h.elevRad[i] * 180) / Math.PI).toBeCloseTo(11.3, 0); // atan(100 / 500)
    expect(h.distM[i]).toBeCloseTo(500, -1);
    // Looking west, nothing rises: the skyline is the curve falling away.
    const w = sweepHorizon([g], g, 270);
    expect(w.elevRad[i]).toBeLessThan(0);
  });
});

describe('earthshine', () => {
  it('follows a Lambert sphere’s phase', () => {
    expect(lambertPhase(0)).toBeCloseTo(1, 12);
    expect(lambertPhase(Math.PI)).toBeCloseTo(0, 12);
    expect(lambertPhase(Math.PI / 2)).toBeCloseTo(1 / Math.PI, 12);
  });

  it('is about a ten-thousandth of sunlight at full Earth, and none at new Earth', () => {
    const full = earthshineIrradiance(0, 384_400);
    expect(full).toBeCloseTo(EARTH_GEOMETRIC_ALBEDO * (6371 / 384_400) ** 2, 12);
    expect(full).toBeGreaterThan(1e-4);
    expect(full).toBeLessThan(1.5e-4);
    expect(earthshineIrradiance(Math.PI, 384_400)).toBeCloseTo(0, 12);
    // Nearer the Earth, brighter by the square of the distance.
    expect(earthshineIrradiance(0, 192_200) / full).toBeCloseTo(4, 9);
  });
});
