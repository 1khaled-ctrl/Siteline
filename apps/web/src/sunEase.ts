import type { Vec3 } from '@siteline/physics';

/** How long the light takes to settle after the date or the launch slip changes. */
export const EASE_MS = 500;
/** Real Sun positions asked for along the way: enough that the light follows the Sun's own path, not a shortcut. */
export const EASE_SAMPLES = 12;
/**
 * The longest jump the light eases across. The slip slider moves up to 15 days either way; beyond that (a new date
 * picked months away) the Sun would circle the sky several times in half a second, so the light simply jumps.
 */
export const EASE_MAX_MS = 16 * 86_400_000;

/**
 * The slowest frame an ease may take, at its median: slower than this (under 20 frames a second) and the device is
 * dropping too many frames for the effect to be worth it, so the light goes back to jumping.
 */
export const EASE_MAX_FRAME_MS = 50;

/** Whether an ease's frames came too slowly: the median gap between them over `EASE_MAX_FRAME_MS`. */
export function tooSlow(frameGapsMs: readonly number[]): boolean {
  if (frameGapsMs.length === 0) return false;
  const sorted = [...frameGapsMs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] > EASE_MAX_FRAME_MS;
}

/** Whether to ease from one lighting time to the next, or jump. `slow`: the device cannot keep up, so never ease. */
export function shouldEase(
  fromMs: number,
  toMs: number,
  opts: { playing: boolean; reducedMotion: boolean; slow?: boolean },
): boolean {
  const gap = Math.abs(toMs - fromMs);
  return (
    Number.isFinite(fromMs) &&
    Number.isFinite(toMs) &&
    gap > 0 &&
    gap <= EASE_MAX_MS &&
    !opts.playing &&
    !opts.reducedMotion &&
    !opts.slow
  );
}

/** The times to ask the Sun's position at, evenly spaced after `fromMs` and ending exactly at `toMs`. */
export function easeTimes(fromMs: number, toMs: number, samples = EASE_SAMPLES): number[] {
  return Array.from({ length: samples }, (_, i) =>
    i + 1 === samples ? toMs : fromMs + ((toMs - fromMs) * (i + 1)) / samples,
  );
}

/** Ease in and out: slow at both ends, fastest in the middle (smoothstep), clamped to 0..1. */
export function easeProgress(elapsedMs: number, durationMs = EASE_MS): number {
  const x = Math.min(Math.max(elapsedMs / durationMs, 0), 1);
  return x * x * (3 - 2 * x);
}

const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/**
 * Between two Sun positions: the direction turns along the great circle between them (a spherical interpolation) and
 * the distance changes in a straight line, so the light never dims or swings through a shortcut on the way.
 */
export function slerpVec(a: Vec3, b: Vec3, f: number): Vec3 {
  const la = length(a);
  const lb = length(b);
  const ua: Vec3 = [a[0] / la, a[1] / la, a[2] / la];
  const ub: Vec3 = [b[0] / lb, b[1] / lb, b[2] / lb];
  const dot = Math.min(Math.max(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2], -1), 1);
  const angle = Math.acos(dot);
  const r = la + (lb - la) * f;
  if (angle < 1e-9) return [ua[0] * r, ua[1] * r, ua[2] * r];
  const s = Math.sin(angle);
  const wa = Math.sin((1 - f) * angle) / s;
  const wb = Math.sin(f * angle) / s;
  return [(ua[0] * wa + ub[0] * wb) * r, (ua[1] * wa + ub[1] * wb) * r, (ua[2] * wa + ub[2] * wb) * r];
}

/**
 * Where the Sun is along a path of real positions (`path[0]` where the light starts, the last one where it ends) when
 * the ease is `progress` of the way through: between the two samples either side, by `slerpVec`.
 */
export function alongPath(path: readonly Vec3[], progress: number): Vec3 {
  if (path.length === 1 || progress <= 0) return path[0];
  if (progress >= 1) return path[path.length - 1];
  const at = progress * (path.length - 1);
  const i = Math.floor(at);
  return slerpVec(path[i], path[i + 1], at - i);
}
