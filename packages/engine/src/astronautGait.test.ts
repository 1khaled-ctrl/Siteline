import { describe, expect, it } from 'vitest';
import {
  advancePhase,
  easeAmount,
  gaitPose,
  LOPE_FROM_M_PER_S,
  LOPE_STRIDE_M,
  strideFor,
  WALK_STRIDE_M,
} from './astronautGait';

describe('stride', () => {
  it('is a walk’s at walking pace and a lope’s when fast', () => {
    expect(strideFor(1.4)).toBe(WALK_STRIDE_M);
    expect(strideFor(12)).toBe(LOPE_STRIDE_M);
    const mid = strideFor(2 * LOPE_FROM_M_PER_S);
    expect(mid).toBeGreaterThan(WALK_STRIDE_M);
    expect(mid).toBeLessThan(LOPE_STRIDE_M);
  });

  it('turns the phase once per stride, either way, and wraps it', () => {
    expect(advancePhase(0, WALK_STRIDE_M / 4, WALK_STRIDE_M)).toBeCloseTo(Math.PI / 2, 12);
    expect(advancePhase(0, WALK_STRIDE_M, WALK_STRIDE_M)).toBeCloseTo(0, 12);
    expect(advancePhase(0, -WALK_STRIDE_M / 4, WALK_STRIDE_M)).toBeCloseTo((3 * Math.PI) / 2, 12);
    for (const d of [-7.3, 0.2, 55]) {
      const p = advancePhase(1, d, WALK_STRIDE_M);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(2 * Math.PI);
    }
  });

  it('eases toward the target and stays there', () => {
    expect(easeAmount(0, 1, 0)).toBe(0);
    expect(easeAmount(0, 1, 10)).toBeCloseTo(1, 6);
    const half = easeAmount(1, 0, 0.1);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(easeAmount(1, 1, 0.05)).toBe(1);
  });
});

describe('pose', () => {
  it('stands still with no stride, whatever the phase', () => {
    const a = gaitPose(0, 0);
    const b = gaitPose(2.1, 0);
    const flat = (g: typeof a) => [
      ...g.thighRad,
      ...g.kneeRad,
      ...g.ankleRad,
      ...g.upperArmRad,
      ...g.elbowRad,
      g.hipTurnRad,
    ];
    for (const [i, v] of flat(b).entries()) expect(v).toBeCloseTo(flat(a)[i], 12);
    for (const v of [...a.thighRad, ...a.ankleRad, a.hipTurnRad]) expect(Math.abs(v)).toBe(0);
    // Knees stay a little bent and the arms are carried forward and bent, as the suit holds them, the same each side.
    expect(a.kneeRad[0]).toBeGreaterThan(0);
    expect(a.upperArmRad[0]).toBeGreaterThan(0);
    expect(a.upperArmRad[1]).toBe(a.upperArmRad[0]);
    expect(a.elbowRad[0]).toBeGreaterThan(0);
    expect(a.elbowRad[1]).toBe(a.elbowRad[0]);
  });

  it('moves the legs opposite each other, and each arm with the other side’s leg', () => {
    for (const p of [0.3, 1.2, 2.5, 4, 5.5]) {
      const g = gaitPose(p, 1);
      expect(g.thighRad[0]).toBeCloseTo(-g.thighRad[1], 12);
      // Each arm's swing about where it is carried standing.
      const stand = gaitPose(p, 0).upperArmRad[0];
      expect(Math.sign(g.upperArmRad[0] - stand)).toBe(Math.sign(g.thighRad[1]));
      expect(Math.sign(g.upperArmRad[1] - stand)).toBe(Math.sign(g.thighRad[0]));
    }
  });

  it('bends the knee of the leg swinging forward, not the one pushing back', () => {
    // At phase 0 the left leg is under the body moving forward; the right is pushing off behind.
    const g = gaitPose(0, 1);
    expect(g.kneeRad[0]).toBeGreaterThan(g.kneeRad[1]);
  });

  it('keeps every joint within a suit’s reach', () => {
    const limit = (75 * Math.PI) / 180;
    for (let p = 0; p < 2 * Math.PI; p += 0.1) {
      const g = gaitPose(p, 1);
      for (const v of [...g.thighRad, ...g.kneeRad, ...g.ankleRad, ...g.upperArmRad, ...g.elbowRad, g.hipTurnRad]) {
        expect(Math.abs(v)).toBeLessThan(limit);
      }
    }
  });
});
