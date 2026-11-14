import { describe, expect, it } from 'vitest';
import {
  clampPitch,
  DEFAULT_DESCENT,
  type DescentPlan,
  descentPose,
  edgePointer,
  headingDegOf,
  headingVector,
  lookAngles,
  PITCH_LIMIT_RAD,
  relativeDeg,
  smooth,
  walkStep,
  wrapDeg,
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

describe('compass headings', () => {
  it('wraps degrees to 0 up to 360', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(360)).toBe(0);
    expect(wrapDeg(-90)).toBe(270);
    expect(wrapDeg(725)).toBe(5);
    expect(wrapDeg(-1e-15)).toBeLessThan(360);
  });

  it('says where a bearing lies from the heading, the short way round, clockwise positive', () => {
    expect(relativeDeg(30, 10)).toBe(20);
    expect(relativeDeg(10, 30)).toBe(-20);
    expect(relativeDeg(5, 355)).toBe(10);
    expect(relativeDeg(355, 5)).toBe(-10);
    expect(relativeDeg(190, 10)).toBe(180);
    expect(relativeDeg(191, 10)).toBe(-179);
  });

  it('reads headings clockwise from north', () => {
    expect(headingDegOf(0, 1)).toBe(0);
    expect(headingDegOf(1, 0)).toBeCloseTo(90, 12);
    expect(headingDegOf(0, -1)).toBeCloseTo(180, 12);
    expect(headingDegOf(-1, 0)).toBeCloseTo(270, 12);
    expect(headingDegOf(-1, 1)).toBeCloseTo(315, 12);
  });
});

describe('pointers toward what is out of view', () => {
  // A 1000 × 800 screen with a 70° vertical field of view; pointers keep 40 px from the sides, between 256 and 496 px.
  const tanHalfY = Math.tan((35 * Math.PI) / 180);
  const view = { width: 1000, height: 800, tanHalfX: tanHalfY * 1.25, tanHalfY };
  const band = { sidePx: 40, topPx: 256, bottomPx: 496 };

  it('has none for what is on screen', () => {
    expect(edgePointer([0, 0, -1], view, band)).toBeNull();
    expect(edgePointer([0.9 * view.tanHalfX, 0.9 * tanHalfY, -1], view, band)).toBeNull();
  });

  it('points from the side the direction left by, at its height', () => {
    const right = edgePointer([1.3 * view.tanHalfX, 0, -1], view, band);
    expect(right).toEqual({ x: 960, y: 400, angleRad: 0 });
    const left = edgePointer([-2 * view.tanHalfX, 0.1 * tanHalfY, -1], view, band);
    expect(left?.x).toBe(40);
    // Along the line from the centre: 0.1 of the half-height up for every 2 half-widths out.
    expect(left?.y).toBeCloseTo(400 - 0.05 * 400 * (460 / 500), 9);
    // Leftward and a little up: just short of −180° on a screen whose y runs down.
    expect(left?.angleRad).toBeCloseTo(-(Math.PI - Math.atan2(0.05 * 400, 500)), 9);
  });

  it('points up from the top of the band at what is above the view', () => {
    const up = edgePointer([0, 1, -0.1], view, band);
    expect(up?.x).toBeCloseTo(500, 9);
    expect(up?.y).toBeCloseTo(256, 9);
    expect(up?.angleRad).toBeCloseTo(-Math.PI / 2, 9);
    // Up and to the right: wherever the line leaves the band first, and never outside it.
    const corner = edgePointer([3 * view.tanHalfX, 3 * tanHalfY, -1], view, band);
    expect(corner).not.toBeNull();
    if (!corner) return;
    expect(corner.x).toBeLessThanOrEqual(960 + 1e-9);
    expect(corner.y).toBeGreaterThanOrEqual(256 - 1e-9);
    expect(corner.x === 960 || Math.abs(corner.y - 256) < 1e-9).toBe(true);
    expect(corner.angleRad).toBeCloseTo(Math.atan2(-3 * 400, 3 * 500), 9);
  });

  it('points to the side to turn toward for what is behind', () => {
    expect(edgePointer([0.5, 0.1, 0.8], view, band)).toEqual({ x: 960, y: 400, angleRad: 0 });
    expect(edgePointer([-0.3, -0.2, 0.9], view, band)).toEqual({ x: 40, y: 400, angleRad: Math.PI });
    expect(edgePointer([0, 0, 1], view, band)?.x).toBe(40);
    // Square to the right, at the edge of being behind.
    expect(edgePointer([1, 0, 0], view, band)?.x).toBe(960);
  });
});
