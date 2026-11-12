import type { EarthPlace, LanderBody, MarsPlace, MissionFilter } from '@siteline/engine';
import { create } from 'zustand';
import { findLander } from './landers';

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
  slipDays: number;
  latDeg: number;
  lonDeg: number;
  view: MoonView;
  layer: Layer;
  pins: Pin[];
  /** The lander whose card is open, by its id in `data/missions.json`. */
  missionId: string | null;
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

const DEFAULTS: View = {
  landingUtc: '2028-03-03T00:00:00.000Z',
  slipDays: 0,
  latDeg: -90,
  lonDeg: 0,
  view: 'solar',
  layer: 'none',
  pins: [],
  missionId: null,
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
  if (patch.slipDays !== undefined && Number.isFinite(patch.slipDays)) {
    out.slipDays = clamp(Math.round(patch.slipDays), -MAX_SLIP_DAYS, MAX_SLIP_DAYS);
  }
  if (patch.latDeg !== undefined && Number.isFinite(patch.latDeg)) out.latDeg = clamp(patch.latDeg, -90, 90);
  if (patch.lonDeg !== undefined && Number.isFinite(patch.lonDeg)) out.lonDeg = wrapLon(patch.lonDeg);
  if (patch.view && VIEWS.includes(patch.view)) out.view = patch.view;
  if (patch.layer && LAYERS.includes(patch.layer)) out.layer = patch.layer;
  if (patch.missionId !== undefined)
    out.missionId = patch.missionId && findLander(patch.missionId) ? patch.missionId : null;
  if (Array.isArray(patch.pins)) {
    out.pins = patch.pins.map(cleanPin).filter((p): p is Pin => p !== undefined);
    out.pins = out.pins.filter((p, i) => out.pins?.findIndex((q) => samePin(p, q)) === i).slice(0, MAX_PINS);
  }
  return out;
}

function fromUrl(): Partial<View> {
  const p = new URLSearchParams(window.location.search);
  const num = (k: string) => (p.get(k) ? Number(p.get(k)) : undefined);
  const pins = (p.get('pins') ?? '')
    .split(';')
    .filter(Boolean)
    .map((s) => s.split(',').map(Number))
    .map(([latDeg, lonDeg]) => ({ latDeg, lonDeg }));
  const link = clean({
    landingUtc: p.get('t') ?? undefined,
    slipDays: num('slip'),
    latDeg: num('lat'),
    lonDeg: num('lon'),
    view: (p.get('view') as MoonView | null) ?? undefined,
    layer: (p.get('layer') as Layer | null) ?? undefined,
    missionId: p.get('mission'),
    pins,
  });
  // The close-up needs a lander that has terrain to show.
  if (link.view === 'site' && !findLander(link.missionId ?? '')?.patch) link.view = 'solar';
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
  openSite: () => set((s) => (findLander(s.missionId ?? '')?.patch ? { view: 'site' } : {})),
  closeSite: () => set((s) => ({ view: closedSiteView(s.missionId), missionFlySeq: s.missionFlySeq + 1 })),
  playOffsetH: 0,
  playing: false,
  speedHPerS: PLAY_SPEEDS_H_PER_S[1],
  set: (patch) => set(clean(patch)),
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

useApp.subscribe((s) => {
  const p = new URLSearchParams({
    view: s.view,
    t: s.landingUtc,
    slip: String(s.slipDays),
    lat: String(s.latDeg),
    lon: String(s.lonDeg),
  });
  if (s.layer !== 'none') p.set('layer', s.layer);
  if (s.missionId) p.set('mission', s.missionId);
  if (s.pins.length) p.set('pins', s.pins.map((x) => `${x.latDeg},${x.lonDeg}`).join(';'));
  window.history.replaceState(null, '', `?${p}`);
});
