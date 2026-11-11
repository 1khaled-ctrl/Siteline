import { create } from 'zustand';

/** Where the camera is: the whole solar system, the Moon as a globe, or the Moon's south pole. */
export type MoonView = 'solar' | 'globe' | 'pole';
export const VIEWS: MoonView[] = ['solar', 'globe', 'pole'];
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
}

interface AppState extends View {
  /** Bumped when the camera should fly to the current site (not saved in the link). */
  focusSeq: number;
  /** Time-lapse: lighting time offset from landing, in hours, and the play speed in hours per second. */
  playOffsetH: number;
  playing: boolean;
  speedHPerS: number;
  set: (patch: Partial<View>) => void;
  /** Select a site and fly the south-pole camera to it. */
  focusSite: (latDeg: number, lonDeg: number) => void;
  togglePin: (pin: Pin) => void;
  setPlay: (patch: { playing?: boolean; speedHPerS?: number; playOffsetH?: number }) => void;
}

const DEFAULTS: View = {
  landingUtc: '2028-03-03T00:00:00.000Z',
  slipDays: 0,
  latDeg: -90,
  lonDeg: 0,
  view: 'solar',
  layer: 'none',
  pins: [],
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
  return clean({
    landingUtc: p.get('t') ?? undefined,
    slipDays: num('slip'),
    latDeg: num('lat'),
    lonDeg: num('lon'),
    view: (p.get('view') as MoonView | null) ?? undefined,
    layer: (p.get('layer') as Layer | null) ?? undefined,
    pins,
  });
}

export const useApp = create<AppState>((set) => ({
  ...DEFAULTS,
  ...fromUrl(),
  focusSeq: 0,
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
  if (s.pins.length) p.set('pins', s.pins.map((x) => `${x.latDeg},${x.lonDeg}`).join(';'));
  window.history.replaceState(null, '', `?${p}`);
});
