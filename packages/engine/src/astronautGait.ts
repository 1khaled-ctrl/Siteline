/**
 * How the astronaut's legs and arms move as you walk in Land Here: a hand-made, illustrative stride, not motion
 * capture. One cycle is two steps; its phase advances with the distance covered, so the feet keep time with the ground
 * at any pace, and the limbs ease back to standing when you stop.
 */

/** One stride (two steps) at walking pace, and the longer, bounding stride at the fast pace, metres. */
export const WALK_STRIDE_M = 1.6;
export const LOPE_STRIDE_M = 3.2;
/** Above this speed the stride lengthens toward the lope, metres per second. */
export const LOPE_FROM_M_PER_S = 2;
/** How fast the limbs settle to standing, or pick up the stride, per second. */
export const GAIT_EASE_PER_S = 6;

/** The stride for a speed: a walk's at walking pace, lengthening to a lope's by three times that speed. */
export function strideFor(speedMps: number): number {
  const k = Math.min(1, Math.max(0, (speedMps - LOPE_FROM_M_PER_S) / (2 * LOPE_FROM_M_PER_S)));
  return WALK_STRIDE_M + k * (LOPE_STRIDE_M - WALK_STRIDE_M);
}

/** The phase after covering `distanceM` (negative walking backwards), radians in [0, 2π). */
export function advancePhase(phaseRad: number, distanceM: number, strideM: number): number {
  const p = phaseRad + (2 * Math.PI * distanceM) / strideM;
  const tau = 2 * Math.PI;
  return ((p % tau) + tau) % tau;
}

/** How much of the stride shows, 0 standing to 1 striding, eased toward `target` over `dtS` seconds. */
export function easeAmount(amount: number, target: number, dtS: number): number {
  return target + (amount - target) * Math.exp(-GAIT_EASE_PER_S * dtS);
}

/** Joint angles, radians. Positive swings a thigh or upper arm forward and bends a knee or elbow. Index 0 is left. */
export interface GaitPose {
  thighRad: [number, number];
  kneeRad: [number, number];
  ankleRad: [number, number];
  upperArmRad: [number, number];
  elbowRad: [number, number];
  /** How far the forearms turn in toward the body, about the vertical (the same for both, mirrored). */
  forearmInRad: number;
  /** The hips turn with the forward leg and the chest turns back against them, about the vertical. */
  hipTurnRad: number;
}

const deg = (d: number) => (d * Math.PI) / 180;
/**
 * The suit is stiff and pressurised: modest swings, the knees a little bent even when standing, and the arms carried
 * forward and bent at the elbow, as a pressurised suit holds them (which also brings the gloves into view).
 */
const THIGH_SWING = deg(24);
const KNEE_LIFT = deg(42);
const KNEE_STAND = deg(4);
const ANKLE_SWING = deg(10);
const ARM_STAND = deg(10);
const ARM_SWING = deg(16);
const ELBOW_STAND = deg(40);
const FOREARM_IN = deg(22);
const ELBOW_SWING = deg(10);
const HIP_TURN = deg(5);

/** The pose at `phaseRad` with `amount` of the stride showing; amount 0 is standing whatever the phase. */
export function gaitPose(phaseRad: number, amount: number): GaitPose {
  const a = Math.min(1, Math.max(0, amount));
  const leg = (offset: number): [number, number, number] => {
    const p = phaseRad + offset;
    const swing = Math.sin(p);
    // The knee bends as the leg passes under the body going forward (cos > 0 going from back to front).
    const lift = Math.max(0, Math.cos(p));
    return [a * THIGH_SWING * swing, KNEE_STAND + a * KNEE_LIFT * lift, a * ANKLE_SWING * Math.cos(p)];
  };
  const [tl, kl, al] = leg(0);
  const [tr, kr, ar] = leg(Math.PI);
  // Each arm swings with the opposite leg.
  const swingL = a * ARM_SWING * Math.sin(phaseRad + Math.PI);
  const swingR = a * ARM_SWING * Math.sin(phaseRad);
  return {
    thighRad: [tl, tr],
    kneeRad: [kl, kr],
    ankleRad: [al, ar],
    upperArmRad: [ARM_STAND + swingL, ARM_STAND + swingR],
    // The elbow bends further as its arm comes forward.
    elbowRad: [
      ELBOW_STAND + Math.max(0, swingL) * (ELBOW_SWING / ARM_SWING),
      ELBOW_STAND + Math.max(0, swingR) * (ELBOW_SWING / ARM_SWING),
    ],
    forearmInRad: FOREARM_IN,
    hipTurnRad: a * HIP_TURN * Math.sin(phaseRad),
  };
}
