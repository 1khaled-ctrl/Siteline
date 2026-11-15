import type { Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import { alongPath, EASE_MAX_MS, easeProgress, easeTimes, shouldEase, slerpVec, tooSlow } from './sunEase';

const DAY = 86_400_000;
const still = { playing: false, reducedMotion: false };

describe('shouldEase', () => {
  it('eases a slip or date step of up to 16 days, and jumps otherwise', () => {
    expect(shouldEase(0, DAY, still)).toBe(true);
    expect(shouldEase(0, -15 * DAY, still)).toBe(true);
    expect(shouldEase(0, EASE_MAX_MS + 1, still)).toBe(false);
    expect(shouldEase(0, 0, still)).toBe(false);
    expect(shouldEase(Number.NaN, DAY, still)).toBe(false);
  });

  it('never eases while the time-lapse plays or when the system asks for less motion', () => {
    expect(shouldEase(0, DAY, { playing: true, reducedMotion: false })).toBe(false);
    expect(shouldEase(0, DAY, { playing: false, reducedMotion: true })).toBe(false);
  });

  it('never eases on a device that has shown it cannot keep up', () => {
    expect(shouldEase(0, DAY, { ...still, slow: true })).toBe(false);
  });
});

describe('tooSlow', () => {
  it('drops the ease when its median frame takes longer than 50 ms, under 20 frames a second', () => {
    expect(tooSlow([16, 17, 16, 18, 120])).toBe(false);
    expect(tooSlow([60, 70, 55, 16])).toBe(true);
    expect(tooSlow([50, 50, 50])).toBe(false);
    expect(tooSlow([])).toBe(false);
  });
});

describe('easeTimes', () => {
  it('spaces the samples evenly after the start and ends exactly on the new time', () => {
    expect(easeTimes(0, 12, 4)).toEqual([3, 6, 9, 12]);
    expect(easeTimes(10, 0, 2)).toEqual([5, 0]);
    const t = easeTimes(1_700_000_000_000, 1_700_000_000_000 + 3 * DAY);
    expect(t).toHaveLength(12);
    expect(t.at(-1)).toBe(1_700_000_000_000 + 3 * DAY);
  });
});

describe('easeProgress', () => {
  it('runs from 0 to 1, slow at both ends and half way at the middle', () => {
    expect(easeProgress(-10)).toBe(0);
    expect(easeProgress(0)).toBe(0);
    expect(easeProgress(250, 500)).toBe(0.5);
    expect(easeProgress(500, 500)).toBe(1);
    expect(easeProgress(900, 500)).toBe(1);
    expect(easeProgress(50, 500)).toBeLessThan(0.1);
  });
});

describe('slerpVec and alongPath', () => {
  it('turns along the great circle at constant distance, never through a shortcut', () => {
    const a: Vec3 = [150e6, 0, 0];
    const b: Vec3 = [0, 150e6, 0];
    const mid = slerpVec(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(150e6, 0);
    expect(mid[0]).toBeCloseTo(mid[1], 0);
    expect(slerpVec(a, b, 0)).toEqual(a);
    const end = slerpVec(a, b, 1);
    expect(end[0]).toBeCloseTo(0, 0);
    expect(end[1]).toBeCloseTo(150e6, 0);
  });

  it('changes the distance in a straight line, and copes with two equal directions', () => {
    expect(Math.hypot(...slerpVec([100, 0, 0], [0, 200, 0], 0.5))).toBeCloseTo(150, 9);
    expect(slerpVec([1, 0, 0], [3, 0, 0], 0.5)).toEqual([2, 0, 0]);
  });

  it('follows the real samples in order: at a sample exactly, and between two on their arc', () => {
    const path: Vec3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
    ];
    expect(alongPath(path, 0)).toEqual([1, 0, 0]);
    const half = alongPath(path, 0.5);
    expect(half[0]).toBeCloseTo(0, 12);
    expect(half[1]).toBeCloseTo(1, 12);
    expect(alongPath(path, 1)).toEqual([-1, 0, 0]);
    const quarter = alongPath(path, 0.25);
    expect(quarter[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(quarter[1]).toBeCloseTo(Math.SQRT1_2, 12);
  });
});
