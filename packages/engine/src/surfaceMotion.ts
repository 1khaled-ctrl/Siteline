/**
 * The surface view's camera moves, as plain maths: the illustrative descent to the landing point, and the walk's
 * directions. Local metres: east, north, up, with the landing point's ground at the origin.
 *
 * The descent is a camera path chosen to show the target and the ground around it. It is not a spacecraft trajectory:
 * no thrust, fuel, mass or guidance goes into it, and the view says so.
 */

/** How the descent runs: where it starts, relative to the landing point, and how long it takes. */
export interface DescentPlan {
  /** The direction the camera faces at touchdown, radians clockwise from north; the approach comes from behind it. */
  headingRad: number;
  /** Height above the landing point's ground at the start, metres. */
  startAltM: number;
  /** How far back along the heading the descent starts, metres. */
  startBackM: number;
  durationS: number;
  /** The eye height it ends at, metres. */
  eyeM: number;
}

export const DEFAULT_DESCENT: Omit<DescentPlan, 'headingRad' | 'eyeM'> = {
  startAltM: 1500,
  startBackM: 1100,
  durationS: 10,
};

/** Smoothstep between edges a and b. */
export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export interface Pose {
  east: number;
  north: number;
  up: number;
  /** Where the camera looks, as a local direction (not necessarily unit length). */
  look: [number, number, number];
}

/** The unit vector a heading points along, on the ground: east and north. */
export const headingVector = (headingRad: number): [number, number] => [Math.sin(headingRad), Math.cos(headingRad)];

/**
 * The camera at fraction `k` (0 to 1) of the descent. It starts high and behind the landing point, glides toward it
 * while looking at the target, finishes straight down over the last part, and turns its gaze from the target to the
 * horizon along the heading as it lands. It never goes below `clearanceM` above the ground under it (`groundAt` gives
 * the ground's local up), so it cannot pass through a ridge on the way, and it ends exactly at the eye height over the
 * landing point.
 */
export function descentPose(
  k: number,
  plan: DescentPlan,
  groundAt: (east: number, north: number) => number,
  clearanceM = 5,
): Pose {
  const t = Math.min(1, Math.max(0, k));
  const [he, hn] = headingVector(plan.headingRad);
  // Horizontal: from behind the target to over it by 85% of the way; then the last of the drop is vertical.
  const back = plan.startBackM * (1 - smooth(0, 0.85, t));
  const east = -he * back;
  const north = -hn * back;
  const target = groundAt(0, 0);
  const base = Number.isFinite(target) ? target : 0;
  // Height: at rest at both ends, falling fastest in the middle.
  const alt = plan.eyeM + (plan.startAltM - plan.eyeM) * (1 - smooth(0, 1, t));
  const ground = groundAt(east, north);
  // Near the end the clearance shrinks to the eye height, so touchdown lands exactly at eye level.
  const keep = t >= 1 ? plan.eyeM : Math.max(plan.eyeM, clearanceM * (1 - smooth(0.9, 1, t)));
  const up = Math.max(base + alt, Number.isFinite(ground) ? ground + keep : base + alt);
  // Gaze: at the target, then toward the horizon along the heading.
  const toTarget: [number, number, number] = [-east, -north, base - up];
  const lenT = Math.hypot(...toTarget) || 1;
  const w = smooth(0.72, 1, t);
  const look: [number, number, number] = [
    (toTarget[0] / lenT) * (1 - w) + he * w,
    (toTarget[1] / lenT) * (1 - w) + hn * w,
    (toTarget[2] / lenT) * (1 - w),
  ];
  return { east, north, up, look };
}

/** Heading (clockwise from north) and pitch (up positive) of a local direction, radians. */
export function lookAngles(dir: readonly [number, number, number]): { headingRad: number; pitchRad: number } {
  const flat = Math.hypot(dir[0], dir[1]);
  return { headingRad: Math.atan2(dir[0], dir[1]), pitchRad: Math.atan2(dir[2], flat) };
}

/** The pitch limit: just short of straight up or down, so the view never flips. */
export const PITCH_LIMIT_RAD = (85 * Math.PI) / 180;

export const clampPitch = (pitchRad: number): number => Math.min(PITCH_LIMIT_RAD, Math.max(-PITCH_LIMIT_RAD, pitchRad));

/**
 * A walking step in local east and north, from the heading and the forward and rightward inputs (each −1 to 1). Moving
 * diagonally is no faster than straight.
 */
export function walkStep(headingRad: number, forward: number, right: number, distanceM: number): [number, number] {
  const len = Math.hypot(forward, right);
  if (len === 0) return [0, 0];
  const f = forward / Math.max(1, len);
  const r = right / Math.max(1, len);
  const [he, hn] = headingVector(headingRad);
  // Right of the heading is the heading turned 90° clockwise: (hn, −he).
  return [(f * he + r * hn) * distanceM, (f * hn - r * he) * distanceM];
}

/** Degrees wrapped to 0 (inclusive) to 360 (exclusive). */
export function wrapDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Where a bearing lies from a heading: degrees, −180 (exclusive) to 180, positive clockwise (to the right of the view). */
export function relativeDeg(bearingDeg: number, headingDeg: number): number {
  const d = wrapDeg(bearingDeg - headingDeg);
  return d > 180 ? d - 360 : d;
}

/** The heading of a direction along the ground (its east and north parts), degrees clockwise from north, 0 to 360. */
export function headingDegOf(east: number, north: number): number {
  return wrapDeg((Math.atan2(east, north) * 180) / Math.PI);
}

/** The screen a pointer goes on: its size in pixels, and the tangents of half the camera's field of view across and up. */
export interface ScreenView {
  width: number;
  height: number;
  tanHalfX: number;
  tanHalfY: number;
}

/** Where pointers may sit: pixels in from each side, and the top and bottom of the band they keep to (y down). */
export interface PointerBand {
  sidePx: number;
  topPx: number;
  bottomPx: number;
}

/**
 * A pointer at the edge of the screen toward a direction that is out of view, or null when the direction is on screen.
 * The direction is in the camera's own frame: x right, y up, looking along −z.
 *
 * In front of the camera, the pointer sits where the line from the screen's centre toward the direction leaves the
 * band. Behind it (or square to one side), it sits at the side to turn toward, at the band's height for the screen's
 * centre: straight behind, that is the left. `angleRad` is the way it points on the screen, from rightward, clockwise.
 */
export function edgePointer(
  dir: readonly [number, number, number],
  view: ScreenView,
  band: PointerBand,
): { x: number; y: number; angleRad: number } | null {
  const [x, y, z] = dir;
  const cx = view.width / 2;
  const cy = view.height / 2;
  const left = band.sidePx;
  const right = view.width - band.sidePx;
  if (z > -1e-6) {
    const toRight = x > 0;
    return {
      x: toRight ? right : left,
      y: Math.min(band.bottomPx, Math.max(band.topPx, cy)),
      angleRad: toRight ? 0 : Math.PI,
    };
  }
  // Its place on the screen, pixels from the centre (y down).
  const sx = (x / -z / view.tanHalfX) * cx;
  const sy = (-y / -z / view.tanHalfY) * cy;
  if (Math.abs(sx) <= cx && Math.abs(sy) <= cy) return null;
  // Along the line from the centre to it, as far as the band goes.
  let s = Number.POSITIVE_INFINITY;
  if (sx > 0) s = Math.min(s, (right - cx) / sx);
  if (sx < 0) s = Math.min(s, (left - cx) / sx);
  if (sy > 0) s = Math.min(s, (band.bottomPx - cy) / sy);
  if (sy < 0) s = Math.min(s, (band.topPx - cy) / sy);
  // (`|| 0` turns the −0 of a level pointer into 0.)
  return { x: cx + sx * s, y: cy + sy * s, angleRad: Math.atan2(sy, sx) || 0 };
}
