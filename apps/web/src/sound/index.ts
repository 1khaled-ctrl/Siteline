/**
 * SiteLine's sound: a few short, quiet sounds that confirm and inform. Nothing plays until
 * a tap or a key press lets the page make sound (browsers allow none before), the M key or the header's button mutes it
 * all at once, and every sound sits beside something visible, never instead of it.
 *
 * This module is the light part the app loads up front: the on/off choice, the unlock, and calls that do nothing until
 * the audio is running. Tone.js and Howler load on the first gesture, in `engine.ts`.
 */
import { create } from 'zustand';
import type { Verdict } from '../verdict';
import type { Reveal } from './engine';
import type { FlightSize } from './maps';

const KEY = 'siteline.sound';

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

interface SoundState {
  /** The listener's choice, kept between visits in this browser: sound on (the default) or muted. */
  on: boolean;
  /** True once a gesture has started the audio and the sounds have loaded. */
  ready: boolean;
}

export const useSound = create<SoundState>(() => ({
  on: typeof window === 'undefined' ? false : readOn(),
  ready: false,
}));

type Engine = typeof import('./engine');
let engine: Promise<Engine> | null = null;
let context: AudioContext | null = null;

/**
 * Starts the audio, from inside a tap, click or key press: the only moment browsers allow it. The context is made and
 * woken right here, synchronously; the libraries follow. Safe to call on every gesture.
 */
export function unlockSound(): void {
  if (!useSound.getState().on) return;
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    if (context.state !== 'running') {
      // A silent sample played inside the gesture wakes audio on iPhones; resume() does it everywhere else.
      const silence = context.createBufferSource();
      silence.buffer = context.createBuffer(1, 1, 22050);
      silence.connect(context.destination);
      silence.start(0);
      void context.resume();
    }
  } catch {
    return;
  }
  if (!engine) {
    const ctx = context;
    (window as Window & { TONE_SILENCE_LOGGING?: boolean }).TONE_SILENCE_LOGGING = true;
    engine = import('./engine').then(async (e) => {
      await e.init(ctx);
      e.setMuted(!useSound.getState().on);
      useSound.setState({ ready: true });
      return e;
    });
    engine.catch(() => {
      engine = null;
    });
  }
}

/** Turns sound on or off, and remembers the choice. Turning it on is itself a gesture, so it starts the audio. */
export function setSoundOn(on: boolean): void {
  useSound.setState({ on });
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Storage can be off (a private window): the choice then lasts for this visit.
  }
  if (on) unlockSound();
  void engine?.then((e) => e.setMuted(!on));
}

/** Runs `play` once the audio is running and sound is on; does nothing otherwise. */
function use(play: (e: Engine) => void): void {
  if (!engine || !useSound.getState().on) return;
  void engine.then((e) => {
    if (useSound.getState().on) play(e);
  });
}

export const sound = {
  /** The stay check's verdict, as a short phrase: rising for a pass, one soft note undecided, one low note for a fail. */
  verdict: (verdict: Verdict) => use((e) => e.verdict(verdict)),
  /** Air for a camera flight, as long as the flight and louder the faster the camera moves. */
  whoosh: (flight: FlightSize) => use((e) => e.whoosh(flight)),
  /** The pull back out to the solar system from a world's view: air falling away, then the opening's chord, lower. */
  pullBack: (flight: FlightSize) => use((e) => e.pullBack(flight)),
  /** A very quiet tick for one click of the phone's dial. */
  tick: () => use((e) => e.tick()),
  /** A small chime when the copilot answers. */
  chime: () => use((e) => e.chime()),
  /** The opening's hum, built from its load progress (0 to 1), swelling into the reveal. */
  drone: {
    start: (progress: number) => use((e) => e.droneStart(progress)),
    progress: (progress: number) => use((e) => e.droneProgress(progress)),
    swell: () => use((e) => e.droneSwell()),
    stop: () => use((e) => e.droneStop()),
  },
  /** The emblem's own sounds: a glint as the light catches its face, and the beats of its reveal. */
  intro: {
    glint: (inS: number) => use((e) => e.introGlint(inS)),
    reveal: (kind: Reveal) => use((e) => e.introReveal(kind)),
  },
};

// For checking in development: what has played, and the running engine itself. Not in the built app.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as Window & { __sitelineSound?: unknown }).__sitelineSound = {
    context: () => context?.state ?? 'none',
    engine: () => engine,
    state: () => useSound.getState(),
    report: async () => {
      const e = await engine;
      return e ? { ...e.played, verdict: [...e.played.verdict] } : null;
    },
  };
}

/** Whether a key press is typing into a field, where M is a letter, not the mute key. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

if (typeof window !== 'undefined') {
  // As the pointer lifts, on clicks and on key presses, not as it goes down: starting the audio device can hold the page
  // for half a second (on Windows), and at the start of a drag that froze the 3D view. A touch only counts as a gesture
  // as the finger lifts anyway.
  for (const type of ['pointerup', 'click'] as const) window.addEventListener(type, unlockSound, true);
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target)) {
        setSoundOn(!useSound.getState().on);
        return;
      }
      unlockSound();
    },
    true,
  );
}
