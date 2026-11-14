import type { EarthPlace, LanderBody, MarsPlace, MissionFilter } from '@siteline/engine';
import { create } from 'zustand';
import { findLander } from './landers';
import { isRobotId, LANDING_RADII_M, type LandingRadius, type RobotId } from './robots';

/**
 * Where the camera is: the solar system, the Earth, Mars, the Moon as a globe, the Moon's south pole, or the close-up
 * terrain around the selected lander's site (on the Moon or Mars).
 */
export type MoonView = 'solar' | 'earth' | 'mars' | 'globe' | 'pole' | 'site';
export const VIEWS: MoonView[] = ['solar', 'earth', 'mars', 'globe', 'pole', 'site'];
/** The view that shows each body as a whole. */
export const BODY_VIEW: Record<LanderBody, MoonView> = { Moon: 'globe', Mars: 'mars' };
export type Layer = 'none' | 'sun' | 'earth' | 'shadow';
export const LAYERS: Layer[] = ['none', 'sun', 'earth', 'shadow'];
export const MAX_PINS = 4;

export interface Pin {
  latDeg: number;
  lonDeg: number;
}

export interface View {
  landingUtc: string;
  /**
   * True while the date follows the real clock, to the minute. The app opens that way; picking a date stops it and Now
   * starts it again. Not written into the link: a link with no date is live.
   */
  live: boolean;
  slipDays: number;
  latDeg: number;
  lonDeg: number;
  view: MoonView;
  layer: Layer;
  pins: Pin[];
  /** The lander whose card is open, by its id in `data/missions.json`. */
  missionId: string | null;
  /** The robot the site is read against, beside its own four checks; null for none. */
  robot: RobotId | null;
  /** The landing accuracy the robot's landing circle uses, metres. */
  landingRadiusM: LandingRadius;
}

interface AppState extends View {
  /** Bumped when the camera should fly to the current site (not saved in the link). */
  focusSeq: number;
  /** The place last picked on the Earth globe, and the camera move the breadcrumbs ask for. Not saved in the link. */
  earthPlace: EarthPlace | null;
  earthCommand: { id: number; type: 'home' | 'country' } | null;
  setEarthPlace: (place: EarthPlace | null) => void;
  commandEarth: (type: 'home' | 'country') => void;
  /** The same for Mars: the place last picked, and the camera move the breadcrumbs ask for. */
  marsPlace: MarsPlace | null;
  marsCommand: { id: number; type: 'home' | 'feature' } | null;
  setMarsPlace: (place: MarsPlace | null) => void;
  commandMars: (type: 'home' | 'feature') => void;
  /** A flight the Worlds list asks the solar-system view for, to a body that has its own view. Not saved in the link. */
  solarCommand: { id: number; body: 'earth' | 'mars' | 'moon' } | null;
  commandSolar: (body: 'earth' | 'mars' | 'moon') => void;
  /** Which landers the list shows, and a counter that asks the camera to fly to the open lander. Not saved in the link. */
  missionFilter: MissionFilter;
  missionFlySeq: number;
  setMissionFilter: (filter: MissionFilter) => void;
  /** Open a lander's card and fly to it, switching to its planet if needed; null closes the card. */
  selectMission: (id: string | null) => void;
  /** Show the close-up terrain around the open lander, or go back to its planet. */
  openSite: () => void;
  closeSite: () => void;
  /** Time-lapse: lighting time offset from landing, in hours, and the play speed in hours per second. */
  playOffsetH: number;
  playing: boolean;
  speedHPerS: number;
  set: (patch: Partial<View>) => void;
  /** Select a site and fly the south-pole camera to it. */
  focusSite: (latDeg: number, lonDeg: number) => void;
  togglePin: (pin: Pin) => void;
  setPlay: (patch: { playing?: boolean; speedHPerS?: number; playOffsetH?: number }) => void;
  /** The sources-and-methods dialog: false when shut, else the dataset id to scroll to (or true for the top). */
  sources: string | boolean;
  setSources: (sources: string | boolean) => void;
  /** The landing the journey simulation flies to, while its dialog is open. */
  journey: JourneyTarget | null;
  setJourney: (journey: JourneyTarget | null) => void;
}

export interface JourneyTarget {
  body: LanderBody;
  latDeg: number;
  lonDeg: number;
  /** A feature or lander name for the title, if there is one. */
  name?: string;
}

/** The dates the ephemeris tables cover, the same range the date fields allow. */
export const FIRST_UTC_MS = Date.parse('2026-01-01T00:00:00Z');
export const LAST_UTC_MS = Date.parse('2035-12-31T23:00:00Z');
const MINUTE_MS = 60_000;

/** The real time now, to the minute, kept inside the tables' range. */
export const nowUtc = (): string =>
  new Date(Math.min(LAST_UTC_MS, Math.max(FIRST_UTC_MS, Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS))).toISOString();

const DEFAULTS: View = {
  landingUtc: nowUtc(),
  live: true,
  slipDays: 0,
  latDeg: -90,
  lonDeg: 0,
  view: 'solar',
  layer: 'none',
  pins: [],
  missionId: null,
  robot: null,
  landingRadiusM: 100,
};
export const MAX_SLIP_DAYS = 15;
export const PLAY_SPEEDS_H_PER_S = [6, 24, 72];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// Rounded to a micro-degree (3 cm) so wrapping never leaves float noise in the share link.
const wrapLon = (v: number) => Math.round((((((v + 180) % 360) + 360) % 360) - 180) * 1e6) / 1e6;
export const samePin = (a: Pin, b: Pin) => a.latDeg === b.latDeg && a.lonDeg === b.lonDeg;

function cleanPin(p: unknown): Pin | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const { latDeg, lonDeg } = p as Partial<Pin>;
  if (typeof latDeg !== 'number' || typeof lonDeg !== 'number' || !Number.isFinite(latDeg + lonDeg)) return undefined;
  return { latDeg: clamp(latDeg, -90, 90), lonDeg: wrapLon(lonDeg) };
}

function clean(patch: Partial<View>): Partial<View> {
  const out: Partial<View> = {};
  if (patch.landingUtc !== undefined && Number.isFinite(Date.parse(patch.landingUtc))) {
    out.landingUtc = new Date(patch.landingUtc).toISOString();
  }
  if (typeof patch.live === 'boolean') out.live = patch.live;
  if (patch.slipDays !== undefined && Number.isFinite(patch.slipDays)) {
    out.slipDays = clamp(Math.round(patch.slipDays), -MAX_SLIP_DAYS, MAX_SLIP_DAYS);
  }
  if (patch.latDeg !== undefined && Number.isFinite(patch.latDeg)) out.latDeg = clamp(patch.latDeg, -90, 90);
  if (patch.lonDeg !== undefined && Number.isFinite(patch.lonDeg)) out.lonDeg = wrapLon(patch.lonDeg);
  if (patch.view && VIEWS.includes(patch.view)) out.view = patch.view;
  if (patch.layer && LAYERS.includes(patch.layer)) out.layer = patch.layer;
  if (patch.missionId !== undefined)
    out.missionId = patch.missionId && findLander(patch.missionId) ? patch.missionId : null;
  if (patch.robot !== undefined) out.robot = isRobotId(patch.robot) ? patch.robot : null;
  if (patch.landingRadiusM !== undefined && (LANDING_RADII_M as readonly number[]).includes(patch.landingRadiusM))
    out.landingRadiusM = patch.landingRadiusM;
  if (Array.isArray(patch.pins)) {
    out.pins = patch.pins.map(cleanPin).filter((p): p is Pin => p !== undefined);
    out.pins = out.pins.filter((p, i) => out.pins?.findIndex((q) => samePin(p, q)) === i).slice(0, MAX_PINS);
  }
  return out;
}

/**
 * The app always opens in the solar system on the live clock. Only a link made to be followed (the Share button's,
 * with `open=pole`) starts elsewhere, at its own date and slip, and it is used once: the address bar drops those, so a
 * reload starts over. The address bar never keeps the view, date or slip itself, and old ones left in it are ignored.
 */
function fromUrl(): Partial<View> {
  const p = new URLSearchParams(window.location.search);
  const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
  const shared = p.has('open');
  const view = (p.get('open') as MoonView | null) ?? undefined;
  const landingUtc = shared ? (p.get('t') ?? undefined) : undefined;
  const slipDays = shared ? num('slip') : undefined;
  if (['open', 'view', 't', 'slip'].some((k) => p.has(k))) {
    for (const k of ['open', 'view', 't', 'slip']) p.delete(k);
    window.history.replaceState(null, '', `?${p}`);
  }
  const pins = (p.get('pins') ?? '')
    .split(';')
    .filter(Boolean)
    .map((s) => s.split(',').map(Number))
    .map(([latDeg, lonDeg]) => ({ latDeg, lonDeg }));
  const link = clean({
    landingUtc,
    // A shared link that names a date holds it; everything else follows the clock.
    live: landingUtc ? false : undefined,
    slipDays,
    latDeg: num('lat'),
    lonDeg: num('lon'),
    view,
    layer: (p.get('layer') as Layer | null) ?? undefined,
    missionId: p.get('mission'),
    robot: (p.get('robot') as RobotId | null) ?? undefined,
    landingRadiusM: num('ring') as LandingRadius | undefined,
    pins,
  });
  // The close-up needs a lander. Whether it has terrain to show is known once the close-ups' headers arrive, and
  // the close-up says so itself if not.
  if (link.view === 'site' && !findLander(link.missionId ?? '')) link.view = 'solar';
  return link;
}

/** Where leaving the close-up goes: the lander's planet. */
const closedSiteView = (missionId: string | null): MoonView => {
  const m = findLander(missionId ?? '');
  return m ? BODY_VIEW[m.body] : 'solar';
};

const initial = { ...DEFAULTS, ...fromUrl() };

export const useApp = create<AppState>((set) => ({
  ...initial,
  focusSeq: 0,
  earthPlace: null,
  earthCommand: null,
  setEarthPlace: (earthPlace) => set({ earthPlace }),
  commandEarth: (type) => set((s) => ({ earthCommand: { id: (s.earthCommand?.id ?? 0) + 1, type } })),
  marsPlace: null,
  marsCommand: null,
  setMarsPlace: (marsPlace) => set({ marsPlace }),
  commandMars: (type) => set((s) => ({ marsCommand: { id: (s.marsCommand?.id ?? 0) + 1, type } })),
  solarCommand: null,
  commandSolar: (body) => set((s) => ({ solarCommand: { id: (s.solarCommand?.id ?? 0) + 1, body } })),
  missionFilter: 'all',
  // A link that names a lander flies to it once its planet is on screen.
  missionFlySeq: initial.missionId ? 1 : 0,
  setMissionFilter: (missionFilter) => set({ missionFilter }),
  selectMission: (id) =>
    set((s) => {
      const m = id ? findLander(id) : undefined;
      if (!m) return { missionId: null, view: s.view === 'site' ? closedSiteView(s.missionId) : s.view };
      return { missionId: m.id, view: BODY_VIEW[m.body], missionFlySeq: s.missionFlySeq + 1 };
    }),
  // Asked only where the close-ups' headers name the lander (the site menu, the lander card).
  openSite: () => set((s) => (findLander(s.missionId ?? '') ? { view: 'site' } : {})),
  closeSite: () => set((s) => ({ view: closedSiteView(s.missionId), missionFlySeq: s.missionFlySeq + 1 })),
  playOffsetH: 0,
  playing: false,
  speedHPerS: PLAY_SPEEDS_H_PER_S[1],
  // Picking a date stops the clock, unless the change says otherwise (Now, and the clock's own ticks).
  set: (patch) =>
    set(clean(patch.landingUtc !== undefined && patch.live === undefined ? { ...patch, live: false } : patch)),
  focusSite: (latDeg, lonDeg) => set((s) => ({ ...clean({ latDeg, lonDeg }), view: 'pole', focusSeq: s.focusSeq + 1 })),
  togglePin: (pin) =>
    set((s) => {
      const pins = s.pins.some((p) => samePin(p, pin))
        ? s.pins.filter((p) => !samePin(p, pin))
        : [...s.pins, pin].slice(-MAX_PINS);
      return { pins };
    }),
  setPlay: (patch) => set(patch),
  sources: false,
  setSources: (sources) => set({ sources }),
  journey: null,
  setJourney: (journey) => set({ journey }),
}));

// The address bar keeps the site, pins, layer and lander, but not the view, date or slip, so opening the app again
// starts in the solar system on the live clock; the Share button's link carries its own view, date and slip. It is
// written only when it changes: the store changes on every frame while the time-lapse plays or the camera flies, and
// browsers throttle the address bar (Firefox throws after 100 writes in 10 seconds, which stopped the time-lapse).
let shownQuery = '';
useApp.subscribe((s) => {
  const p = new URLSearchParams({
    lat: String(s.latDeg),
    lon: String(s.lonDeg),
  });
  if (s.layer !== 'none') p.set('layer', s.layer);
  if (s.missionId) p.set('mission', s.missionId);
  if (s.robot) p.set('robot', s.robot);
  if (s.robot && s.landingRadiusM !== DEFAULTS.landingRadiusM) p.set('ring', String(s.landingRadiusM));
  if (s.pins.length) p.set('pins', s.pins.map((x) => `${x.latDeg},${x.lonDeg}`).join(';'));
  const query = `?${p}`;
  if (query === shownQuery) return;
  shownQuery = query;
  window.history.replaceState(null, '', query);
});

// The view shown before the current one, and when that changed, so a view that opens can begin with the move back out
// of the one you left.
let shown: { view: MoonView; previous: MoonView | null; atMs: number } = {
  view: useApp.getState().view,
  previous: null,
  atMs: Number.NEGATIVE_INFINITY,
};
useApp.subscribe((s) => {
  if (s.view !== shown.view) shown = { view: s.view, previous: shown.view, atMs: performance.now() };
});

/** The view you have just left for this one; null if the view did not change a moment ago (as on a reload or a retry). */
export function cameFrom(): MoonView | null {
  return performance.now() - shown.atMs < 1000 ? shown.previous : null;
}

// While the date is live it follows the real clock: day and night on the Earth, the planets and the Moon's light all
// match the moment you are looking.
if (typeof window !== 'undefined') {
  const tick = () => {
    const s = useApp.getState();
    const now = nowUtc();
    if (s.live && s.landingUtc !== now) s.set({ landingUtc: now, live: true });
  };
  setInterval(tick, 10_000);
  document.addEventListener('visibilitychange', tick);
}
