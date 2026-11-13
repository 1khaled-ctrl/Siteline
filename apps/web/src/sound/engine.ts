/**
 * The audio itself, loaded on the first gesture. Tone.js makes everything that follows data or the picture (the
 * verdict phrase, the flight whoosh and the pull back out to the solar system, and the opening: its
 * hum, the glint of light on the emblem and the sounds of its reveal) from oscillators and noise, with no files; Howler
 * plays the two fixed sounds (the copilot's chime and the dial's tick).
 *
 * Levels are kept low throughout: a master trim and a limiter sit before the speakers, so nothing is ever loud.
 */
import { Howl, Howler } from 'howler';
import {
  Filter,
  FMSynth,
  Gain,
  getDestination,
  Limiter,
  Noise,
  now,
  Oscillator,
  Panner,
  PolySynth,
  Reverb,
  Synth,
  setContext,
  Volume,
} from 'tone';
import chimeUrl from '../assets/sound/chime.mp3';
import tickUrl from '../assets/sound/tick.wav';
import type { Verdict } from '../verdict';
import {
  droneLevel,
  type FlightSize,
  HOME_CHORD,
  OPENING_CHORD,
  pullBackShape,
  VERDICT_NOTES,
  whooshShape,
} from './maps';

const SILENT_DB = -80;
/** Howler's levels for its two sounds, out of 1. */
const LEVEL = { chime: 0.28, tick: 0.12 };

let master: Volume;
let chimeSound: Howl;
let tickSound: Howl;
let lastTickMs = 0;
/** What has played since the audio started: for checking, not for the app. */
export const played = {
  whoosh: 0,
  pullBack: 0,
  verdict: [] as Verdict[],
  chime: 0,
  tick: 0,
  drone: 0,
  glint: 0,
  reveal: [] as Reveal[],
};

/** Builds the output on the context the gesture started, and loads the two short sounds. */
export async function init(context: AudioContext): Promise<void> {
  setContext(context);
  const limiter = new Limiter(-3).toDestination();
  master = new Volume(-4).connect(limiter);
  chimeSound = new Howl({ src: [chimeUrl], volume: LEVEL.chime });
  tickSound = new Howl({ src: [tickUrl], volume: LEVEL.tick });
}

/** Mutes everything at once, and stops what is running so nothing resumes mid-phrase on unmuting. */
export function setMuted(mute: boolean): void {
  getDestination().mute = mute;
  Howler.mute(mute);
  if (mute) droneStop(0.15);
}

// The verdict phrase --------------------------------------------------------------------------------------------------

let bell: PolySynth | null = null;

function bellVoice(): PolySynth {
  if (!bell) {
    const room = new Reverb({ decay: 1.8, wet: 0.22 }).connect(master);
    const soft = new Filter(3200, 'lowpass').connect(room);
    bell = new PolySynth(Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.008, decay: 0.25, sustain: 0.12, release: 0.6 },
      volume: -14,
    }).connect(soft);
  }
  return bell;
}

export function verdict(v: Verdict): void {
  const b = bellVoice();
  played.verdict.push(v);
  const start = now() + 0.03;
  for (const n of VERDICT_NOTES[v]) b.triggerAttackRelease(n.note, n.seconds, start + n.at, n.velocity);
}

// The flight whoosh ---------------------------------------------------------------------------------------------------

let air: { noise: Noise; band: Filter; pan: Panner; level: Volume } | null = null;
let airStop = 0;

export function whoosh(flight: FlightSize): void {
  const shape = whooshShape(flight);
  if (!shape) return;
  played.whoosh++;
  if (!air) {
    const level = new Volume(SILENT_DB).connect(master);
    const pan = new Panner(0).connect(level);
    const band = new Filter({ type: 'bandpass', frequency: 300, Q: 0.8 }).connect(pan);
    air = { noise: new Noise('pink').connect(band), band, pan, level };
  }
  const { noise, band, pan, level } = air;
  const t0 = now() + 0.02;
  const mid = t0 + shape.seconds / 2;
  const end = t0 + shape.seconds;
  // Loudest and brightest half-way, where the eased camera moves fastest; it passes from one side to the other.
  level.volume.cancelScheduledValues(t0);
  level.volume.setValueAtTime(-60, t0);
  level.volume.linearRampToValueAtTime(shape.peakDb, mid);
  level.volume.linearRampToValueAtTime(-70, end);
  band.frequency.cancelScheduledValues(t0);
  band.frequency.setValueAtTime(220, t0);
  band.frequency.exponentialRampToValueAtTime(shape.peakHz, mid);
  band.frequency.exponentialRampToValueAtTime(180, end);
  pan.pan.cancelScheduledValues(t0);
  pan.pan.setValueAtTime(-0.3, t0);
  pan.pan.linearRampToValueAtTime(0.3, end);
  if (noise.state !== 'started') noise.start(t0);
  window.clearTimeout(airStop);
  airStop = window.setTimeout(() => noise.stop(), (shape.seconds + 0.3) * 1000);
}

let homePad: PolySynth | null = null;

/**
 * The pull back out to the whole solar system: the whoosh in reverse, rushing as the camera leaves the world and then
 * falling away in level and pitch as the worlds recede, crossing the other way from a dive; under its tail the opening's
 * chord an octave down swells in the opening's room, as the whole system comes into view.
 */
export function pullBack(flight: FlightSize): void {
  const shape = pullBackShape(flight);
  if (!shape) return;
  played.pullBack++;
  const t0 = now() + 0.02;
  const peak = t0 + shape.peakS;
  const end = t0 + shape.seconds;
  const level = new Volume(SILENT_DB).connect(master);
  const pan = new Panner(0.3).connect(level);
  const band = new Filter({ type: 'bandpass', frequency: shape.peakHz * 0.6, Q: 0.8 }).connect(pan);
  const noise = new Noise('pink').connect(band);
  level.volume.setValueAtTime(-60, t0);
  level.volume.linearRampToValueAtTime(shape.peakDb, peak);
  level.volume.linearRampToValueAtTime(-70, end);
  band.frequency.setValueAtTime(shape.peakHz * 0.6, t0);
  band.frequency.exponentialRampToValueAtTime(shape.peakHz, peak);
  band.frequency.exponentialRampToValueAtTime(160, end);
  pan.pan.setValueAtTime(0.3, t0);
  pan.pan.linearRampToValueAtTime(-0.3, end);
  noise.start(t0).stop(end + 0.05);
  disposeAt([noise, band, pan, level], end + 0.1);
  homePad ??= new PolySynth(Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 1.1, decay: 0.8, sustain: 0.5, release: 2.4 },
    volume: -22,
  }).connect(hallOf());
  homePad.triggerAttackRelease([...HOME_CHORD], shape.seconds - shape.chordS + 0.4, t0 + shape.chordS, 0.4);
}

// The opening's drone -------------------------------------------------------------------------------------------------

let drone: { voices: Oscillator[]; low: Filter; level: Volume } | null = null;

/** Starts the hum at the loading done so far; a second start only moves it on. */
export function droneStart(progress: number): void {
  if (!drone) {
    played.drone++;
    const level = new Volume(SILENT_DB).connect(master);
    const low = new Filter(140, 'lowpass').connect(level);
    // A1, E2 and a slightly sharp A2, which beats slowly against the A1's overtone so the hum breathes.
    const voices = (
      [
        [55, 'sine', 0.6],
        [82.41, 'triangle', 0.16],
        [110.3, 'sine', 0.24],
      ] as const
    ).map(([hz, type, gain]) => new Oscillator(hz, type).connect(new Gain(gain).connect(low)));
    for (const v of voices) v.start();
    drone = { voices, low, level };
  }
  droneProgress(progress);
}

export function droneProgress(progress: number): void {
  if (!drone) return;
  const { cutoffHz, db } = droneLevel(progress);
  drone.low.frequency.rampTo(cutoffHz, 0.9);
  drone.level.volume.rampTo(db, 0.9);
}

/** The reveal: the hum opens up and swells as the emblem rushes past, then fades out over the flight. */
export function droneSwell(): void {
  if (!drone) return;
  const t0 = now();
  drone.low.frequency.rampTo(2200, 1.0, t0);
  drone.level.volume.rampTo(-20, 0.9, t0);
  drone.level.volume.rampTo(SILENT_DB, 2.6, t0 + 1.0);
  stopDroneAt(t0 + 3.7);
}

export function droneStop(fadeS = 0.8): void {
  if (!drone) return;
  const t0 = now();
  drone.level.volume.rampTo(SILENT_DB, fadeS, t0);
  stopDroneAt(t0 + fadeS + 0.1);
}

function stopDroneAt(at: number): void {
  const d = drone;
  if (!d) return;
  drone = null;
  for (const v of d.voices) v.stop(at);
  window.setTimeout(
    () => {
      for (const v of d.voices) v.dispose();
      d.low.dispose();
      d.level.dispose();
    },
    Math.max(0, (at - now()) * 1000) + 300,
  );
}

// Howler's fixed sounds -----------------------------------------------------------------------------------------------

export function chime(): void {
  played.chime++;
  chimeSound.play();
}

export function tick(): void {
  // A fast spin is a rattle, not a burst: one tick per 35 ms at most.
  const t = performance.now();
  if (t - lastTickMs < 35) return;
  lastTickMs = t;
  played.tick++;
  tickSound.play();
}

// The opening's glint and reveal ---------------------------------------------------------------------------------------

/** How the opening hands over: the flight into the solar system, the rush past for any other view, or the plain fade. */
export type Reveal = 'flight' | 'rush' | 'fade';

/** The opening's sounds ring in one shared, longer room, so they read as one moment. */
let hall: Reverb | null = null;
const hallOf = (): Reverb => {
  hall ??= new Reverb({ decay: 3.4, wet: 0.42 }).connect(master);
  return hall;
};
let glintBell: FMSynth | null = null;
let pad: PolySynth | null = null;
let pinger: Synth | null = null;

function disposeAt(nodes: { dispose(): unknown }[], at: number): void {
  window.setTimeout(
    () => {
      for (const n of nodes) n.dispose();
    },
    Math.max(0, (at - now()) * 1000) + 250,
  );
}

/** A soft metallic glint, `inS` seconds from now: the light catching the emblem's face as it turns. */
export function introGlint(inS: number): void {
  glintBell ??= new FMSynth({
    harmonicity: 3.01,
    modulationIndex: 6,
    envelope: { attack: 0.002, decay: 1.3, sustain: 0, release: 1 },
    modulationEnvelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.2 },
    volume: -29,
  }).connect(hallOf());
  played.glint++;
  glintBell.triggerAttackRelease('E6', 0.04, now() + Math.max(0.01, inS), 0.6);
}

/** Air rushing past, rising and falling over `seconds`. */
function burst(at: number, seconds: number): void {
  const level = new Volume(SILENT_DB).connect(master);
  const band = new Filter({ type: 'bandpass', frequency: 260, Q: 0.7 }).connect(level);
  const noise = new Noise('pink').connect(band);
  level.volume.setValueAtTime(-60, at);
  level.volume.linearRampToValueAtTime(-23, at + seconds * 0.55);
  level.volume.linearRampToValueAtTime(-70, at + seconds);
  band.frequency.setValueAtTime(260, at);
  band.frequency.exponentialRampToValueAtTime(3200, at + seconds * 0.55);
  band.frequency.exponentialRampToValueAtTime(400, at + seconds);
  noise.start(at).stop(at + seconds + 0.05);
  disposeAt([noise, band, level], at + seconds + 0.1);
}

/** A quick, faint glide upward, with its tail in the room. */
function sparkle(at: number): void {
  const level = new Volume(SILENT_DB).connect(hallOf());
  const tone = new Oscillator(1800, 'sine').connect(level);
  tone.frequency.setValueAtTime(1800, at);
  tone.frequency.exponentialRampToValueAtTime(5200, at + 0.35);
  level.volume.setValueAtTime(SILENT_DB, at);
  level.volume.linearRampToValueAtTime(-31, at + 0.04);
  level.volume.linearRampToValueAtTime(SILENT_DB, at + 0.4);
  tone.start(at).stop(at + 0.45);
  disposeAt([tone, level], at + 0.5);
}

/**
 * The reveal's sounds, each on its beat of the picture (the times match the opening's timeline in Intro.tsx): the
 * emblem rushing past the camera, the shooting star streaking off, the gold ring opening out as a soft major chord, and
 * for the flight into the solar system, a small ping as the lander reaches the Moon.
 */
export function introReveal(kind: Reveal): void {
  played.reveal.push(kind);
  const t0 = now() + 0.03;
  if (kind !== 'fade') {
    burst(t0 + 0.08, 0.95);
    sparkle(t0 + 0.2);
  }
  pad ??= new PolySynth(Synth, {
    oscillator: { type: 'sine' },
    envelope: { attack: 0.35, decay: 0.6, sustain: 0.4, release: 1.6 },
    volume: -21,
  }).connect(hallOf());
  pad.triggerAttackRelease([...OPENING_CHORD], 0.9, t0 + (kind === 'fade' ? 0 : 0.15), 0.35);
  if (kind === 'flight') {
    pinger ??= new Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.004, decay: 1.4, sustain: 0, release: 1.2 },
      volume: -19,
    }).connect(hallOf());
    pinger.triggerAttackRelease('B5', 0.05, t0 + 2.3, 0.6);
  }
}
