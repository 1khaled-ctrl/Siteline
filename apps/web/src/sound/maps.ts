/**
 * How data becomes sound, kept apart from the audio code so it can be tested and read on its own. Every sound here is a
 * plain function of a number the app already has: the share of the Sun's disc above a site's horizon, a camera move's
 * size and length, the opening's load progress, a stay's verdict.
 */
import type { Verdict } from '../verdict';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The time-lapse tone's lowest and highest pitch: G3 in the dark, two octaves up to G5 with the whole Sun up. */
export const SUN_TONE_LOW_HZ = 196;
export const SUN_TONE_OCTAVES = 2;

/**
 * The sunlight sonification. Pitch rises with the share of the Sun's disc above the site's horizon (0 to 1), evenly
 * by ear (an octave per half of the disc), and so does loudness: nearly silent in the dark, quiet in full Sun.
 */
export function sunTone(fraction: number): { hz: number; db: number } {
  const f = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
  return { hz: SUN_TONE_LOW_HZ * 2 ** (SUN_TONE_OCTAVES * f), db: -44 + 26 * f };
}

/** The share of the Sun's disc above the horizon at a moment, from a stay series; NaN outside it or where unknown. */
export function sunAt(series: { tUtcMs: ArrayLike<number>; sun: ArrayLike<number> }, tUtcMs: number): number {
  const t = series.tUtcMs;
  const n = t.length;
  if (n === 0 || !(tUtcMs >= t[0]) || !(tUtcMs <= t[n - 1])) return Number.NaN;
  // The samples are evenly spaced, so the one before is found directly; nudged in case of rounding.
  const step = n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 1;
  let i = Math.min(n - 2, Math.max(0, Math.floor((tUtcMs - t[0]) / step)));
  while (i > 0 && t[i] > tUtcMs) i--;
  while (i < n - 2 && t[i + 1] < tUtcMs) i++;
  if (n === 1) return series.sun[0];
  const k = t[i + 1] === t[i] ? 0 : (tUtcMs - t[i]) / (t[i + 1] - t[i]);
  return series.sun[i] + (series.sun[i + 1] - series.sun[i]) * k;
}

export interface FlightSize {
  durationMs: number;
  /** |ln(end distance / start distance)|. */
  zoom: number;
  turnRad: number;
}

/** A whoosh: how long, how loud at its peak, where its filter peaks, and the pan it sweeps across. */
export interface WhooshShape {
  seconds: number;
  peakDb: number;
  peakHz: number;
}

/** Flights shorter than this are a zoom click or a nudge, not a journey, and stay silent. */
export const WHOOSH_MIN_MS = 900;

/**
 * The whoosh for a camera flight. It lasts as long as the flight and peaks half-way, where the eased camera is fastest,
 * louder and brighter the faster the camera moves: the move's size (zoom plus swing) over its duration. A dive across
 * the solar system is the loudest; a short hop between countries is a breath.
 */
export function whooshShape(f: FlightSize): WhooshShape | null {
  if (!(f.durationMs >= WHOOSH_MIN_MS)) return null;
  const seconds = f.durationMs / 1000;
  const speed = (f.zoom + f.turnRad) / seconds;
  if (!(speed > 0.08)) return null;
  const k = clamp(speed / 2.4, 0.12, 1);
  return { seconds, peakDb: -36 + 14 * k, peakHz: 450 + 2600 * k };
}

/** The pull back out to the solar system: a whoosh whose air peaks early and falls away, then a chord swelling in. */
export interface PullBackShape extends WhooshShape {
  /** When the air is loudest and brightest, in seconds from the start: early, as the camera leaves the world. */
  peakS: number;
  /** When the chord starts to swell in, in seconds from the start: as the whole system comes into view. */
  chordS: number;
}

/** The opening's chord, as the emblem's gold ring opens into the Earth's orbit: E major, spread wide. */
export const OPENING_CHORD = ['E4', 'B4', 'E5', 'G#5'] as const;

/**
 * The opening's chord an octave down, sounded each time you come back out to the solar system, so the overview always
 * arrives on the chord the app opened on.
 */
export const HOME_CHORD = ['E3', 'B3', 'E4', 'G#4'] as const;

/**
 * The pull back out from a world to the whole solar system: the dive's whoosh in reverse. It is as loud and bright as a
 * whoosh for the same move, but peaks early and then falls, both in level and pitch, as the worlds recede (the opposite
 * of a dive's rise to the middle); the home chord swells in under its tail.
 */
export function pullBackShape(f: FlightSize): PullBackShape | null {
  const whoosh = whooshShape(f);
  return whoosh && { ...whoosh, peakS: whoosh.seconds * 0.35, chordS: whoosh.seconds * 0.45 };
}

/**
 * The opening's drone at a share of the loading done (0 to 1): its filter opens and it grows from a hush toward a quiet
 * hum, so it builds with the dots under the emblem.
 */
export function droneLevel(progress: number): { cutoffHz: number; db: number } {
  const p = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
  return { cutoffHz: 140 * 2 ** (2.6 * p), db: -42 + 16 * p };
}

/** A note of a verdict tone: its pitch, when it starts after the first (s), how long it rings (s) and how hard. */
export interface Note {
  note: string;
  at: number;
  seconds: number;
  velocity: number;
}

/**
 * The site report's verdict, as a short, calm phrase that differs by ear: a rising major third for a pass, one soft
 * middle note while it is not decided, and a single short low note for a fail. Always alongside the verdict's icon and
 * word on screen, never instead of them.
 */
export const VERDICT_NOTES: Record<Verdict, readonly Note[]> = {
  pass: [
    { note: 'E5', at: 0, seconds: 0.16, velocity: 0.5 },
    { note: 'G#5', at: 0.13, seconds: 0.38, velocity: 0.55 },
  ],
  undecided: [{ note: 'E5', at: 0, seconds: 0.3, velocity: 0.38 }],
  fail: [{ note: 'E3', at: 0, seconds: 0.28, velocity: 0.6 }],
};
