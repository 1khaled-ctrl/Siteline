import { cross, dot, norm, type Vec3 } from './vec';

/** Stumpff functions C(z) and S(z) of the universal-variable formulation. */
function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / -z;
  return 1 / 2;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / s ** 3;
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / s ** 3;
  }
  return 1 / 6;
}

export interface LambertSolution {
  v1KmS: Vec3;
  v2KmS: Vec3;
}

/**
 * Lambert's problem by universal variables (Curtis, Orbital Mechanics for Engineering Students, section 5.3): the
 * velocities at r1 and at r2 of the orbit around a central mass that goes from one to the other in `tofS` seconds,
 * prograde (anticlockwise seen from +z), without a full revolution. Positions in km, `mu` in km³/s². Null when the
 * two points are in line with the centre, where the orbit's plane is undefined, or when no such orbit is found.
 */
export function lambert(r1Km: Vec3, r2Km: Vec3, tofS: number, muKm3S2: number): LambertSolution | null {
  const R1 = norm(r1Km);
  const R2 = norm(r2Km);
  let dTheta = Math.acos(Math.max(-1, Math.min(1, dot(r1Km, r2Km) / (R1 * R2))));
  if (cross(r1Km, r2Km)[2] < 0) dTheta = 2 * Math.PI - dTheta;
  const A = Math.sin(dTheta) * Math.sqrt((R1 * R2) / (1 - Math.cos(dTheta)));
  if (!Number.isFinite(A) || Math.abs(A) < 1e-9) return null;

  const y = (z: number) => R1 + R2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));
  // F rises with z; its root gives the orbit with the wanted time of flight.
  const F = (z: number) => {
    const yz = y(z);
    if (yz < 0) return Number.NaN;
    return (yz / stumpffC(z)) ** 1.5 * stumpffS(z) + A * Math.sqrt(yz) - Math.sqrt(muKm3S2) * tofS;
  };
  let lo = -4 * Math.PI ** 2;
  let hi = 4 * Math.PI ** 2 - 1e-6;
  let fLo = F(lo);
  for (let i = 0; i < 400 && !(fLo < 0); i++) {
    lo += 0.1;
    fLo = F(lo);
  }
  if (!(fLo < 0 && F(hi) > 0)) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = F(mid);
    if (Number.isNaN(f) || f < 0) lo = mid;
    else hi = mid;
  }
  const yz = y((lo + hi) / 2);
  const f = 1 - yz / R1;
  const g = A * Math.sqrt(yz / muKm3S2);
  const gDot = 1 - yz / R2;
  return {
    v1KmS: [(r2Km[0] - f * r1Km[0]) / g, (r2Km[1] - f * r1Km[1]) / g, (r2Km[2] - f * r1Km[2]) / g],
    v2KmS: [(gDot * r2Km[0] - r1Km[0]) / g, (gDot * r2Km[1] - r1Km[1]) / g, (gDot * r2Km[2] - r1Km[2]) / g],
  };
}

export interface OrbitState {
  rKm: Vec3;
  vKmS: Vec3;
}

/**
 * Where a body on a two-body orbit is `dtS` seconds later: Kepler's equation in universal variables solved by Newton's
 * method, then the Lagrange f and g coefficients (Curtis, algorithms 3.3 and 3.4). Exact for any conic, so no error
 * builds up however far it is carried.
 */
export function propagate(rKm: Vec3, vKmS: Vec3, dtS: number, muKm3S2: number): OrbitState {
  const r0 = norm(rKm);
  const v0 = norm(vKmS);
  const vr0 = dot(rKm, vKmS) / r0;
  const alpha = 2 / r0 - v0 ** 2 / muKm3S2;
  const sqrtMu = Math.sqrt(muKm3S2);

  let chi = sqrtMu * Math.abs(alpha) * dtS;
  for (let i = 0; i < 100; i++) {
    const z = alpha * chi ** 2;
    const C = stumpffC(z);
    const S = stumpffS(z);
    const F = ((r0 * vr0) / sqrtMu) * chi ** 2 * C + (1 - alpha * r0) * chi ** 3 * S + r0 * chi - sqrtMu * dtS;
    const dF = ((r0 * vr0) / sqrtMu) * chi * (1 - z * S) + (1 - alpha * r0) * chi ** 2 * C + r0;
    const step = F / dF;
    chi -= step;
    if (Math.abs(step) < 1e-10) break;
  }

  const z = alpha * chi ** 2;
  const f = 1 - (chi ** 2 / r0) * stumpffC(z);
  const g = dtS - (chi ** 3 / sqrtMu) * stumpffS(z);
  const r: Vec3 = [f * rKm[0] + g * vKmS[0], f * rKm[1] + g * vKmS[1], f * rKm[2] + g * vKmS[2]];
  const R = norm(r);
  const fDot = (sqrtMu / (R * r0)) * (alpha * chi ** 3 * stumpffS(z) - chi);
  const gDot = 1 - (chi ** 2 / R) * stumpffC(z);
  return {
    rKm: r,
    vKmS: [fDot * rKm[0] + gDot * vKmS[0], fDot * rKm[1] + gDot * vKmS[1], fDot * rKm[2] + gDot * vKmS[2]],
  };
}
