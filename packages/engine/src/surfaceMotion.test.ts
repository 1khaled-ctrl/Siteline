import { describe, expect, it } from 'vitest';
import {
  clampPitch,
  DEFAULT_DESCENT,
  type DescentPlan,
  descentPose,
  headingVector,
  lookAngles,
  PITCH_LIMIT_RAD,
  smooth,
  walkStep,
} from './surfaceMotion';

const plan: DescentPlan = { ...DEFAULT_DESCENT, headingRad: Math.PI / 3, eyeM: 1.7 };
const hills = (e: number, n: number) => 40 * Math.sin(e / 90) * Math.cos(n / 70) + 0.02 * e;

describe('descent', () => {
  it('starts high and behind the landing point, looking at it', () => {
    const p = descentPose(0, plan, () => 0);
    expect(p.up).toBeCloseTo(plan.startAltM, 6);
    expect(Math.hypot(p.east, p.north)).toBeCloseTo(plan.startBackM, 6);
    // Behind: the heading points from the camera toward the target.
    const [he, hn] = headingVector(plan.headingRad);
    expect(-(p.east * he + p.north * hn)).toBeGreaterThan(0);
    const toTarget = Math.hypot(-p.east, -p.north, -p.up);
    expect(p.look[2]).toBeCloseTo(-p.up / toTarget, 6);
  });

  it('ends exactly at eye height over the landing point, looking at the horizon along the heading', () => {
    const p = descentPose(1, plan, hills);
    expect(p.east).toBeCloseTo(0, 9);
    expect(p.north).toBeCloseTo(0, 9);
    expect(p.up).toBeCloseTo(hills(0, 0) + 1.7, 9);
    expect(p.look[2]).toBeCloseTo(0, 9);
    const { headingRad } = lookAngles(p.look);
    expect(headingRad).toBeCloseTo(plan.headingRad, 9);
  });

  it('never goes into the ground on the way down', () => {
    // A 300 m ridge right across the approach.
    const ridge = (e: number, n: number) => (Math.abs(e * 0.5 + n * 0.866 + 500) < 80 ? 300 : 0);
    for (let i = 0; i <= 400; i++) {
      const k = i / 400;
      const p = descentPose(k, plan, ridge);
      expect(p.up - ridge(p.east, p.north)).toBeGreaterThanOrEqual(1.7 - 1e-9);
      const q = descentPose(k, plan, hills);
      expect(q.up - hills(q.east, q.north)).toBeGreaterThanOrEqual(1.7 - 1e-9);
    }
  });

  it('comes down steadily, at rest at both ends', () => {
    let last = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 100; i++) {
      const p = descentPose(i / 100, plan, () => 0);
      expect(p.up).toBeLessThanOrEqual(last + 1e-9);
      last = p.up;
    }
    const start = descentPose(0.001, plan, () => 0).up - descentPose(0, plan, () => 0).up;
    const middle = descentPose(0.501, plan, () => 0).up - descentPose(0.5, plan, () => 0).up;
    expect(Math.abs(start)).toBeLessThan(Math.abs(middle) / 50);
    expect(smooth(0, 1, 0.5)).toBe(0.5);
  });
});

describe('looking and walking', () => {
  it('reads heading clockwise from north and pitch up positive', () => {
    expect(lookAngles([0, 1, 0]).headingRad).toBeCloseTo(0, 12);
    expect(lookAngles([1, 0, 0]).headingRad).toBeCloseTo(Math.PI / 2, 12);
    expect(lookAngles([0, 1, 1]).pitchRad).toBeCloseTo(Math.PI / 4, 12);
  });

  it('never pitches past straight up or down, and never rolls', () => {
    expect(clampPitch(2)).toBe(PITCH_LIMIT_RAD);
    expect(clampPitch(-2)).toBe(-PITCH_LIMIT_RAD);
    expect(clampPitch(0.3)).toBe(0.3);
  });

  it('steps forward along the heading and right of it, no faster diagonally', () => {
    const [e, n] = walkStep(0, 1, 0, 2);
    expect(e).toBeCloseTo(0, 12);
    expect(n).toBeCloseTo(2, 12);
    const [re, rn] = walkStep(0, 0, 1, 2);
    expect(re).toBeCloseTo(2, 12);
    expect(rn).toBeCloseTo(0, 12);
    const [de, dn] = walkStep(Math.PI / 2, 1, 1, 1);
    expect(Math.hypot(de, dn)).toBeCloseTo(1, 12);
    expect(walkStep(1, 0, 0, 5)).toEqual([0, 0]);
  });
});
