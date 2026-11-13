import { create } from 'zustand';
import emblem from './assets/emblem.json';
import { measureFrames } from './perf';

/** What the opening waits for, each named on its loading line. */
export type BootTask = 'fonts' | 'emblem' | 'positions' | 'orbits' | 'imagery' | 'view';
export type BootStatus = 'pending' | 'done' | 'failed';

/**
 * How the app opens: the emblem turning while the data loads and then a flight into the solar system, the emblem
 * fading out for anyone who asked for less motion, or nothing once it has played in this tab.
 */
export type IntroMode = 'cinematic' | 'fade' | 'none';

const SEEN_KEY = 'siteline.introSeen';

function readSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage can be off (a private window, blocked site data): the opening then plays on each load.
  }
}

/** `?intro=1` plays the opening even after it has played in this tab, and `?intro=0` skips it. */
function introMode(): IntroMode {
  if (typeof window === 'undefined') return 'none';
  const asked = new URLSearchParams(window.location.search).get('intro');
  if (asked === '0' || (asked !== '1' && readSeen())) return 'none';
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'fade' : 'cinematic';
}

export const INTRO_MODE: IntroMode = introMode();

/** The emblem's width on screen: big on a laptop, most of the narrow side on a phone. */
export const COIN_PX =
  typeof window === 'undefined'
    ? 360
    : Math.round(Math.min(0.62 * Math.min(window.innerWidth, window.innerHeight), 360));
/** The radius of the emblem's gold ring at that size, which the Earth's orbit takes over. */
export const RING_PX = emblem.ring.r * COIN_PX;

interface BootState {
  tasks: Partial<Record<BootTask, BootStatus>>;
  /** True once the app is showing: the opening has handed over, or there is none. */
  opened: boolean;
  setTask: (task: BootTask, status: BootStatus) => void;
  open: () => void;
}

/** Marks the page as open, which lets the panel's cards float in. */
function markOpened(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.opened = '';
}
if (INTRO_MODE === 'none') markOpened();

export const useBoot = create<BootState>((set) => ({
  tasks: {},
  opened: INTRO_MODE === 'none',
  setTask: (task, status) => set((s) => ({ tasks: { ...s.tasks, [task]: status } })),
  open: () => {
    markOpened();
    set({ opened: true });
    // The first moments of the open app (the scene moving behind frosted glass) are the hardest work it does: a slow
    // device turns its effects down from here on.
    void measureFrames(2000);
  },
}));

/** Counts a load toward the opening, which holds until every counted load settles. Hands back the same promise. */
export function track<T>(task: BootTask, promise: Promise<T>): Promise<T> {
  const { opened, setTask } = useBoot.getState();
  if (opened) return promise;
  setTask(task, 'pending');
  promise.then(
    () => setTask(task, 'done'),
    () => setTask(task, 'failed'),
  );
  return promise;
}

/** True when nothing counted is still loading; a failure counts as settled, so its view can say what went wrong. */
export const allSettled = (tasks: BootState['tasks']): boolean =>
  Object.values(tasks).every((status) => status !== 'pending');

/** The first load still running, in the order the line names them. */
export function firstPending(tasks: BootState['tasks']): BootTask | undefined {
  const order: BootTask[] = ['view', 'positions', 'orbits', 'imagery', 'fonts', 'emblem'];
  return order.find((task) => tasks[task] === 'pending');
}
