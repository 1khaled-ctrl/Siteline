import { describe, expect, it } from 'vitest';
import { lambert, propagate } from './lambert';
import { cross, norm, sub, type Vec3 } from './vec';

const MU_EARTH = 398_600;

describe('lambert', () => {
  it("matches Curtis's Example 5.2: from r1 to r2 around the Earth in one hour", () => {
    const sol = lambert([5000, 10_000, 2100], [-14_600, 2500, 7000], 3600, MU_EARTH);
    expect(sol).not.toBeNull();
    const [a, b, c] = sol?.v1KmS ?? [0, 0, 0];
    expect(a).toBeCloseTo(-5.9925, 3);
    expect(b).toBeCloseTo(1.9254, 3);
    expect(c).toBeCloseTo(3.2456, 3);
    const [d, e, f] = sol?.v2KmS ?? [0, 0, 0];
    expect(d).toBeCloseTo(-3.3125, 3);
    expect(e).toBeCloseTo(-4.1966, 3);
    expect(f).toBeCloseTo(-0.38529, 3);
  });

  it('gives an orbit that really reaches r2 at the time asked, for a quarter turn and a long arc', () => {
    for (const [r1, r2, tof] of [
      [[7000, 0, 0], [0, 9000, 500], 2400],
      [[42_000, 0, 0], [-30_000, -20_000, 1000], 86_400],
    ] as [Vec3, Vec3, number][]) {
      const sol = lambert(r1, r2, tof, MU_EARTH);
      expect(sol).not.toBeNull();
      const end = propagate(r1, sol?.v1KmS ?? [0, 0, 0], tof, MU_EARTH);
      expect(norm(sub(end.rKm, r2))).toBeLessThan(1e-3);
      expect(norm(sub(end.vKmS, sol?.v2KmS ?? [0, 0, 0]))).toBeLessThan(1e-6);
    }
  });

  it('refuses points in line with the centre, where the plane of the orbit is undefined', () => {
    expect(lambert([7000, 0, 0], [-9000, 0, 0], 3000, MU_EARTH)).toBeNull();
  });
});

describe('propagate', () => {
  it('carries a circular orbit a quarter of the way round in a quarter of its period', () => {
    const r = 7000;
    const v = Math.sqrt(MU_EARTH / r);
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / MU_EARTH);
    const end = propagate([r, 0, 0], [0, v, 0], period / 4, MU_EARTH);
    expect(end.rKm[0]).toBeCloseTo(0, 6);
    expect(end.rKm[1]).toBeCloseTo(r, 6);
    expect(end.vKmS[0]).toBeCloseTo(-v, 9);
  });

  it('keeps energy and angular momentum on a hyperbolic escape, and comes back when run backwards', () => {
    const r0: Vec3 = [6563, 0, 0];
    const v0: Vec3 = [0, 11.5, 0.4];
    const energy = (s: { rKm: Vec3; vKmS: Vec3 }) => norm(s.vKmS) ** 2 / 2 - MU_EARTH / norm(s.rKm);
    const out = propagate(r0, v0, 3 * 86_400, MU_EARTH);
    expect(energy(out)).toBeCloseTo(energy({ rKm: r0, vKmS: v0 }), 8);
    expect(norm(sub(cross(out.rKm, out.vKmS), cross(r0, v0)))).toBeLessThan(1e-4);
    const back = propagate(out.rKm, out.vKmS, -3 * 86_400, MU_EARTH);
    expect(norm(sub(back.rKm, r0))).toBeLessThan(1e-4);
  });
});
