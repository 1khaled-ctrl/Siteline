import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BODY_CONSTANTS } from '../bodyFacts';
import { formatNumber, formatUtc } from '../format';
import {
  type CraftSample,
  type Journey,
  LUNAR_ORBIT_ALTITUDE_KM,
  MARS_TOF_DAYS,
  MOON_COAST_DAYS,
  MOON_ORBIT_DAYS,
  marsJourney,
  moonJourney,
  type Positions,
  playbackTime,
  trackAt,
  WINDOW_C3_FACTOR,
  type XY,
} from '../journey';
import { DAY_MS, physics, URLS } from '../physics';
import { type JourneyTarget, useApp } from '../store';
import { smallButton } from './Controls';
import { Spinner } from './ViewStatus';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** How long a full play-through takes on screen. */
const PLAY_SECONDS = 16;
const HOUR_MS = 3_600_000;
const COLOURS = {
  bg: '#070b16',
  ink: '#e8edf7',
  quiet: '#8e9ab5',
  line: '#22304f',
  craft: '#f4b63f',
  path: 'rgba(244, 182, 63, 0.35)',
  earth: '#5ba9ff',
  moon: '#c9ced8',
  mars: '#e0734a',
  sun: '#ffd27a',
};

/** The craft between its samples, by time; before departure at the start and after arrival at the end. */
function craftAt(samples: readonly CraftSample[], tUtcMs: number): { s: CraftSample; heading: number } {
  let i = 1;
  while (i < samples.length - 1 && samples[i].tUtcMs < tUtcMs) i++;
  const a = samples[i - 1];
  const b = samples[i];
  const k = Math.min(1, Math.max(0, (tUtcMs - a.tUtcMs) / (b.tUtcMs - a.tUtcMs)));
  const xy: XY = [a.xy[0] + (b.xy[0] - a.xy[0]) * k, a.xy[1] + (b.xy[1] - a.xy[1]) * k];
  return {
    s: {
      tUtcMs,
      xy,
      speedKmS: a.speedKmS + (b.speedKmS - a.speedKmS) * k,
      distEarthKm: a.distEarthKm + (b.distEarthKm - a.distEarthKm) * k,
    },
    heading: Math.atan2(b.xy[1] - a.xy[1], b.xy[0] - a.xy[0]),
  };
}

/** When the transfer first comes within `rKm` of the Moon's centre; the arrival time if it never does. */
function orbitEntryUtcMs(j: Journey, rKm: number): number {
  const moon = j.tracks.moon ?? [];
  if (!moon.length) return j.arriveUtcMs;
  const dist = (c: CraftSample) => {
    const m = trackAt(moon, c.tUtcMs);
    return Math.hypot(c.xy[0] - m[0], c.xy[1] - m[1]);
  };
  for (let i = 1; i < j.craft.length; i++) {
    const [a, b] = [j.craft[i - 1], j.craft[i]];
    const [da, db] = [dist(a), dist(b)];
    if (da > rKm && db <= rKm) return a.tUtcMs + ((da - rKm) / (da - db)) * (b.tUtcMs - a.tUtcMs);
  }
  return j.arriveUtcMs;
}

interface Labels {
  earth: string;
  moon: string;
  mars: string;
  sun: string;
  depart: string;
  arrive: string;
  descent: string;
  touchdown: string;
  site: string;
  siteInset: string;
  scale: string;
  closeScale: string;
}

export interface Site {
  latDeg: number;
  lonDeg: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** Size of the "where it lands" globe in the corner, px. */
const INSET_R = 40;

/** One frame of the journey at `tUtcMs`, top-down onto the plane of motion. */
function draw(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  j: Journey,
  tUtcMs: number,
  labels: Labels,
  site: Site,
) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = COLOURS.bg;
  g.fillRect(0, 0, w, h);

  const moonTrip = j.body === 'Moon';
  const target = moonTrip ? 'moon' : 'mars';
  const targetXY = trackAt(j.tracks[target] ?? [], tUtcMs);

  // The whole trip, framed on everything drawn, so the picture fills the canvas whichever way the orbit lies.
  const pts: XY[] = [...j.craft.map((c) => c.xy), ...Object.values(j.tracks).flatMap((tr) => tr.map((p) => p.xy))];
  if (!moonTrip) pts.push(...(j.rings.mars ?? []), ...(j.rings.earth ?? []));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const wholeS = Math.min((w * 0.84) / (x1 - x0 || 1), (h * 0.74) / (y1 - y0 || 1));
  const whole: XY = [(x0 + x1) / 2, (y0 + y1) / 2];

  // Near the Moon the camera closes in on it, so the lunar orbit and the descent are big enough to follow. It zooms
  // geometrically and keeps the Moon still on screen while it does, rather than sliding it across.
  const moonR = BODY_CONSTANTS.Moon.radiusKm;
  const orbitR = moonR + LUNAR_ORBIT_ALTITUDE_KM;
  const closeMoonPx = Math.max(48, Math.min(Math.min(w, h) * 0.3, w / 2 - 2 * INSET_R - 28));
  const closeS = closeMoonPx / moonR;
  const zoom = moonTrip ? smoothstep(j.arriveUtcMs - 14 * HOUR_MS, j.arriveUtcMs + HOUR_MS, tUtcMs) : 0;
  const s = wholeS * (closeS / wholeS) ** zoom;
  const pull = zoom === 0 ? 0 : (1 - wholeS / s) / (1 - wholeS / closeS);
  const mx = whole[0] + (targetXY[0] - whole[0]) * pull;
  const my = whole[1] + (targetXY[1] - whole[1]) * pull;
  const toScreen = ([x, y]: XY): XY => [w / 2 + (x - mx) * s, h / 2 + 12 - (y - my) * s];

  const disc = (at: XY, r: number, fill: string, glow: number) => {
    const [x, y] = toScreen(at);
    g.save();
    g.shadowColor = fill;
    g.shadowBlur = glow;
    g.fillStyle = fill;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  // Seen from above the orbit, the half facing the Sun is lit: the terminator is a straight line through the centre.
  const litDisc = (at: XY, r: number, fill: string, glow: number) => {
    if (!j.sunDir) {
      disc(at, r, fill, glow);
      return;
    }
    const [x, y] = toScreen(at);
    const sunA = Math.atan2(-j.sunDir[1], j.sunDir[0]);
    g.save();
    g.shadowColor = fill;
    g.shadowBlur = glow / 2;
    g.fillStyle = '#1b202b';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = glow;
    g.fillStyle = fill;
    g.beginPath();
    g.arc(x, y, r, sunA - Math.PI / 2, sunA + Math.PI / 2);
    g.closePath();
    g.fill();
    g.restore();
  };
  const label = (at: XY, text: string, dy: number, colour = COLOURS.quiet) => {
    const [x, y] = toScreen(at);
    // Off the canvas once the camera has closed in: leave it out rather than pin it to an edge.
    if (x < -40 || x > w + 40 || y + dy < 0 || y + dy > h) return;
    g.fillStyle = colour;
    g.font = '500 12px "IBM Plex Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    // Kept inside the canvas, which on a phone is narrower than the orbit is wide.
    const half = g.measureText(text).width / 2 + 6;
    g.fillText(text, Math.min(w - half, Math.max(half, x)), y + dy);
  };
  const line = (path: readonly XY[], colour: string, width: number, dash: number[] = []) => {
    if (path.length < 2) return;
    g.save();
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    path.forEach((p, i) => {
      const [x, y] = toScreen(p);
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
    g.restore();
  };

  // Orbits and tracks first, then the path, then the bodies and the craft on top.
  if (moonTrip) {
    line(
      (j.tracks.moon ?? []).map((p) => p.xy),
      'rgba(201, 206, 216, 0.35)',
      1.2,
      [2, 5],
    );
  } else {
    line(j.rings.earth ?? [], 'rgba(91, 169, 255, 0.28)', 1);
    line(j.rings.mars ?? [], 'rgba(224, 115, 74, 0.3)', 1);
    disc([0, 0], 9, COLOURS.sun, 24);
    label([0, 0], labels.sun, 24);
  }
  line(
    j.craft.map((c) => c.xy),
    COLOURS.path,
    1.5,
    [5, 6],
  );
  // The simplified transfer aims at the Moon's centre, so the craft leaves it for the lunar orbit where it first comes
  // within the orbit's radius, rather than flying on into the Moon.
  const entryUtcMs = moonTrip ? orbitEntryUtcMs(j, orbitR) : j.arriveUtcMs;
  const done = j.craft.filter((c) => c.tUtcMs <= Math.min(tUtcMs, entryUtcMs)).map((c) => c.xy);
  const here = craftAt(j.craft, Math.min(tUtcMs, entryUtcMs));
  if (tUtcMs > j.craft[0].tUtcMs) done.push(here.s.xy);
  g.save();
  g.shadowColor = COLOURS.craft;
  g.shadowBlur = 8;
  line(done, COLOURS.craft, 2.2);
  g.restore();

  // Bodies are enlarged while the whole trip is in view, and drawn at their true size once that is bigger.
  const earthXY = moonTrip ? ([0, 0] as XY) : trackAt(j.tracks.earth ?? [], tUtcMs);
  const earthPx = moonTrip ? Math.max(11, BODY_CONSTANTS.Earth.radiusKm * s) : 6;
  (moonTrip ? litDisc : disc)(earthXY, earthPx, COLOURS.earth, 14);
  label(earthXY, labels.earth, earthPx + 16);
  const targetPx = moonTrip ? Math.max(6.5, moonR * s) : 5.5;
  (moonTrip ? litDisc : disc)(targetXY, targetPx, moonTrip ? COLOURS.moon : COLOURS.mars, 10);
  label(targetXY, moonTrip ? labels.moon : labels.mars, -targetPx - 8);
  // At the Moon the start is on top of the Earth, whose name is below it.
  if (zoom < 0.5) label(j.craft[0].xy, labels.depart, moonTrip ? -earthPx - 9 : 22, COLOURS.craft);

  // The craft: on its transfer orbit, then (Moon) circling in lunar orbit, then down to the surface.
  let craftXY = here.s.xy;
  let heading = here.heading;
  const landed = tUtcMs >= j.landUtcMs;
  const descending = j.descentUtcMs !== undefined && tUtcMs >= j.descentUtcMs && !landed;
  if (moonTrip && tUtcMs > entryUtcMs && j.lunarOrbitS) {
    // The lunar orbit to scale, with the craft going round it at its real period, starting where it came in from.
    const [tx, ty] = toScreen(targetXY);
    g.strokeStyle = 'rgba(244, 182, 63, 0.4)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(tx, ty, Math.max(targetPx + 7, orbitR * s), 0, Math.PI * 2);
    g.stroke();
    const entry = craftAt(j.craft, entryUtcMs).s.xy;
    const entryMoon = trackAt(j.tracks.moon ?? [], entryUtcMs);
    const a0 = Math.atan2(entry[1] - entryMoon[1], entry[0] - entryMoon[0]);
    const a = a0 + (2 * Math.PI * (Math.min(tUtcMs, j.landUtcMs) - entryUtcMs)) / (j.lunarOrbitS * 1000);
    // The descent brings it from the orbit's height to the ground over the last stretch.
    const down =
      j.descentUtcMs === undefined ? 0 : smoothstep(j.descentUtcMs, j.landUtcMs, Math.min(tUtcMs, j.landUtcMs));
    const rKm = orbitR + (moonR - orbitR) * down;
    const rPx = Math.max(targetPx + 7 - 7 * down, rKm * s);
    craftXY = [targetXY[0] + (rPx / s) * Math.cos(a), targetXY[1] + (rPx / s) * Math.sin(a)];
    heading = a + Math.PI / 2;
  } else if (landed) {
    craftXY = targetXY;
  }
  const [cx, cy] = toScreen(craftXY);
  if (!landed) {
    // A soft ring so the craft is easy to find while it is small against the whole trip.
    g.strokeStyle = 'rgba(244, 182, 63, 0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, 13, 0, Math.PI * 2);
    g.stroke();
  }
  g.save();
  g.translate(cx, cy);
  g.rotate(-heading);
  g.shadowColor = COLOURS.craft;
  g.shadowBlur = 14;
  g.fillStyle = COLOURS.craft;
  g.beginPath();
  g.moveTo(10, 0);
  g.lineTo(-7, 6.5);
  g.lineTo(-3.5, 0);
  g.lineTo(-7, -6.5);
  g.closePath();
  g.fill();
  g.restore();
  if (tUtcMs >= j.arriveUtcMs) {
    const text = landed ? labels.touchdown : descending ? labels.descent : labels.arrive;
    label(targetXY, text, targetPx + 22, COLOURS.craft);
  }

  if (j.sunDir) {
    // Which way the Sun is: an arrow from the corner, with its name past the tip so the two never cross.
    const [dx, dy] = j.sunDir;
    const ax = 44;
    const ay = h - 44;
    g.strokeStyle = COLOURS.sun;
    g.fillStyle = COLOURS.sun;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(ax + dx * 22, ay - dy * 22);
    g.stroke();
    g.beginPath();
    g.arc(ax + dx * 22, ay - dy * 22, 3, 0, Math.PI * 2);
    g.fill();
    g.font = '500 11px "IBM Plex Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(labels.sun, ax + dx * 38, ay - dy * 38);
    g.textBaseline = 'alphabetic';
  }

  // Where it lands, once the craft has arrived: a small globe seen from its equator above the site's longitude, so
  // the site sits at its real latitude, with the south pole at the bottom.
  if (tUtcMs >= j.arriveUtcMs) {
    const R = INSET_R;
    const ix = w - R - 16;
    const iy = R + 50;
    g.save();
    g.globalAlpha = Math.min(1, (tUtcMs - j.arriveUtcMs) / (3 * HOUR_MS));
    g.fillStyle = COLOURS.quiet;
    g.font = '500 11px "IBM Plex Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(labels.siteInset, ix, iy - R - 8);
    const grad = g.createRadialGradient(ix - R * 0.3, iy - R * 0.3, R * 0.1, ix, iy, R);
    grad.addColorStop(0, moonTrip ? '#d8dce4' : '#e79a6e');
    grad.addColorStop(1, moonTrip ? '#5a606c' : '#7a3a22');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(ix, iy, R, 0, Math.PI * 2);
    g.fill();
    // Parallels every 30° and meridians 30° and 60° either side of the site's.
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 0.8;
    for (const lat of [-60, -30, 0, 30, 60]) {
      const y = iy - R * Math.sin((lat * Math.PI) / 180);
      const half = R * Math.cos((lat * Math.PI) / 180);
      g.beginPath();
      g.moveTo(ix - half, y);
      g.lineTo(ix + half, y);
      g.stroke();
    }
    for (const dLon of [-60, -30, 0, 30, 60]) {
      g.beginPath();
      g.ellipse(ix, iy, Math.abs(R * Math.sin((dLon * Math.PI) / 180)) || 0.01, R, 0, 0, Math.PI * 2);
      g.stroke();
    }
    const sy = iy - R * Math.sin((site.latDeg * Math.PI) / 180);
    g.fillStyle = landed ? COLOURS.craft : 'rgba(244, 182, 63, 0.6)';
    g.shadowColor = COLOURS.craft;
    g.shadowBlur = landed ? 10 : 0;
    g.beginPath();
    g.arc(ix, sy, landed ? 5 : 4, 0, Math.PI * 2);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = COLOURS.ink;
    g.font = '500 11.5px "IBM Plex Sans", system-ui, sans-serif';
    g.fillText(labels.site, Math.min(ix, w - g.measureText(labels.site).width / 2 - 6), iy + R + 16);
    g.restore();
  }

  g.fillStyle = COLOURS.quiet;
  g.font = '400 11px "IBM Plex Sans", system-ui, sans-serif';
  g.textAlign = 'right';
  g.fillText(zoom > 0.5 ? labels.closeScale : labels.scale, w - 12, h - 12);
}

/** The button that opens the simulation for a landing. */
export function JourneyButton({ target }: { target: JourneyTarget }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`${smallButton} w-full`}
      onClick={() => useApp.getState().setJourney(target)}
      data-testid="journey-button"
    >
      <span aria-hidden="true">▶ </span>
      {t('journey.button')}
    </button>
  );
}

/** "Simulate the journey": from Earth to the landing site and date already chosen. */
export function JourneyDialog() {
  const target = useApp((s) => s.journey);
  const setJourney = useApp((s) => s.setJourney);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (target && !d.open) d.showModal();
    if (!target && d.open) d.close();
  }, [target]);
  const backdrop = (e: MouseEvent) => e.target === ref.current && setJourney(null);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes a modal dialog; the click is for the mouse.
    <dialog
      ref={ref}
      aria-labelledby="journey-title"
      onClose={() => setJourney(null)}
      onClick={backdrop}
      className="m-auto max-h-[94dvh] w-[min(1040px,calc(100%-24px))] overflow-y-auto rounded-xl border border-line bg-panel p-0 text-ink backdrop:bg-black/70"
    >
      {target && <JourneyBody target={target} />}
    </dialog>
  );
}

function JourneyBody({ target }: { target: JourneyTarget }) {
  const { t } = useTranslation();
  const setJourney = useApp((s) => s.setJourney);
  const landUtcMs = useApp((s) => Date.parse(s.landingUtc) + s.slipDays * DAY_MS);
  const [journey, setJourneyData] = useState<Journey>();
  const [error, setError] = useState<string>();
  const [k, setK] = useState(0);
  const [playing, setPlaying] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let live = true;
    const cache = new Map<number, Promise<Positions>>();
    const at = (tMs: number) => {
      let p = cache.get(tMs);
      if (!p) {
        p = physics.planetsAt(tMs, URLS.data);
        cache.set(tMs, p);
      }
      return p;
    };
    const run =
      target.body === 'Moon'
        ? moonJourney(landUtcMs, at)
        : Promise.all([physics.planetOrbits(URLS.data), physics.planetsSpan(URLS.data)]).then(([orbits, span]) =>
            marsJourney(landUtcMs, at, orbits, span.startUtcMs),
          );
    run.then(
      (j) => {
        if (!live) return;
        setJourneyData(j);
        setK(reducedMotion() ? 1 : 0);
        setPlaying(!reducedMotion());
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [target, landUtcMs]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setK((v) => {
        const next = Math.min(1, v + dt / PLAY_SECONDS);
        if (next >= 1) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const tUtcMs = journey ? playbackTime(journey, k) : 0;
  const ns = target.latDeg < 0 ? t('landers.south') : t('landers.north');
  const ew = target.lonDeg < 0 ? t('landers.west') : t('landers.east');
  const place = `${formatNumber(Math.abs(target.latDeg), 2)}° ${ns}, ${formatNumber(Math.abs(target.lonDeg), 2)}° ${ew}`;
  const labels = useMemo<Labels>(
    () => ({
      earth: t('bodies.earth'),
      moon: t('bodies.moon'),
      mars: t('bodies.mars'),
      sun: t('bodies.sun'),
      depart: t(`journey.depart.${target.body}`),
      arrive: t(`journey.arrive.${target.body}`),
      descent: t('journey.descent'),
      touchdown: t('journey.touchdown'),
      site: place,
      siteInset: t('journey.siteInset'),
      scale: t('journey.notToScale'),
      closeScale: t('journey.closeScale'),
    }),
    [t, target.body, place],
  );

  useEffect(() => {
    const c = canvas.current;
    if (!c || !journey) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * ratio)) c.width = Math.round(w * ratio);
    if (c.height !== Math.round(h * ratio)) c.height = Math.round(h * ratio);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(g, w, h, journey, tUtcMs, labels, target);
  }, [journey, tUtcMs, labels, target]);

  const phase = !journey
    ? ''
    : tUtcMs >= journey.landUtcMs
      ? t('journey.phase.landed')
      : journey.descentUtcMs !== undefined && tUtcMs >= journey.descentUtcMs
        ? t('journey.phase.descent')
        : tUtcMs >= journey.arriveUtcMs
          ? t(`journey.phase.arrived.${journey.body}`)
          : tUtcMs <= journey.departUtcMs
            ? t(`journey.phase.start.${journey.body}`)
            : t(`journey.phase.cruise.${journey.body}`);
  let now = journey && craftAt(journey.craft, Math.min(tUtcMs, journey.arriveUtcMs)).s;
  // In lunar orbit the craft goes where the Moon goes: its distance and speed are the Moon's, from the ephemeris.
  if (journey && now && journey.body === 'Moon' && tUtcMs > journey.arriveUtcMs && journey.tracks.moon) {
    const moon = journey.tracks.moon;
    const hourAgo = trackAt(moon, tUtcMs - 3_600_000);
    const xyNow = trackAt(moon, tUtcMs);
    now = {
      ...now,
      distEarthKm: Math.hypot(xyNow[0], xyNow[1]),
      speedKmS: Math.hypot(xyNow[0] - hourAgo[0], xyNow[1] - hourAgo[1]) / 3600,
    };
  }
  const dayNo = journey ? (tUtcMs - journey.departUtcMs) / DAY_MS : 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="journey-title" className="text-2xl">
            {t('journey.title', { name: target.name ?? place })}
          </h2>
          <p className="text-sm text-quiet">
            {t(`journey.subtitle.${target.body}`, { place, date: formatUtc(new Date(landUtcMs).toISOString()) })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setJourney(null)}
          className="min-h-9 rounded-md border border-line bg-panel-raised px-3 text-sm hover:border-line-hover"
        >
          {t('sources.close')}
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_15rem]">
        {/* Play and the timeline sit right under the picture, so they stay in view on a narrow screen too. */}
        <div className="flex min-w-0 flex-col gap-2">
          <div className="relative">
            <canvas
              ref={canvas}
              className="block h-[min(56dvh,520px)] w-full rounded-lg border border-line"
              role="img"
              aria-label={t('journey.canvasLabel', { phase })}
            />
            {!journey && !error && (
              <p role="status" className="absolute inset-0 grid place-items-center text-sm text-quiet">
                <span className="flex items-center gap-2">
                  <Spinner />
                  {t('journey.working')}
                </span>
              </p>
            )}
            {error && (
              <p role="alert" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-fail">
                {t('journey.failed', { message: error })}
              </p>
            )}
            {/* The caption sits on the animation itself, so no still or recording of it loses it. */}
            <p className="pointer-events-none absolute inset-x-2 top-2 mx-auto w-fit max-w-[90%] rounded-md bg-bar/85 px-2.5 py-1 text-center text-xs text-sun-ink">
              {t('journey.caption')}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!journey}
              className={smallButton}
              onClick={() => {
                if (k >= 1) setK(0);
                setPlaying((p) => !p);
              }}
            >
              {playing ? t('journey.pause') : k >= 1 ? t('journey.replay') : t('journey.play')}
            </button>
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(k * 1000)}
              disabled={!journey}
              aria-label={t('journey.scrub')}
              aria-valuetext={journey ? formatUtc(new Date(tUtcMs).toISOString()) : undefined}
              className="min-w-0 flex-1 accent-sun"
              onChange={(e) => {
                setPlaying(false);
                setK(Number(e.currentTarget.value) / 1000);
              }}
            />
          </div>
        </div>

        {journey && now && (
          <dl className="grid content-start gap-2 text-sm">
            <Readout label={t('journey.phaseLabel')} value={phase} />
            <Readout label={t('journey.time')} value={formatUtc(new Date(tUtcMs).toISOString())} />
            <Readout
              label={t('journey.day')}
              value={t('journey.dayValue', {
                n: formatNumber(Math.max(0, dayNo), 1),
                of: formatNumber(journey.tofDays, 0),
              })}
            />
            <Readout label={t('journey.fromEarth')} value={t('journey.km', { n: formatNumber(now.distEarthKm, 0) })} />
            <Readout
              label={t(`journey.speed.${journey.body}`)}
              value={t('journey.kms', { n: formatNumber(now.speedKmS, 2) })}
            />
            <Readout
              label={t('journey.c3')}
              value={t('journey.c3Value', { n: formatNumber(journey.c3Km2S2, 1).replace('-', '−') })}
            />
            {journey.body === 'Mars' && (
              <>
                <Readout label={t('journey.launch')} value={formatUtc(new Date(journey.departUtcMs).toISOString())} />
                <Readout
                  label={t('journey.arrivalSpeed')}
                  value={t('journey.kms', { n: formatNumber(journey.speedKmS, 2) })}
                />
                {journey.reference && <WindowNote journey={journey} />}
              </>
            )}
          </dl>
        )}
      </div>

      <p className="text-xs text-quiet">
        {t(`journey.assumptions.${target.body}`, {
          coast: MOON_COAST_DAYS,
          orbit: MOON_ORBIT_DAYS,
          min: MARS_TOF_DAYS.min,
          max: MARS_TOF_DAYS.max,
        })}
      </p>
    </div>
  );
}

/** Whether this landing date suits a launch window, judged against the ideal transfer for these two orbits. */
function WindowNote({ journey }: { journey: Journey }) {
  const { t } = useTranslation();
  const ref = journey.reference;
  if (!ref) return null;
  const near = journey.c3Km2S2 <= WINDOW_C3_FACTOR * ref.hohmannC3Km2S2;
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 text-xs ${near ? 'border-pass/50 bg-pass/8 text-pass' : 'border-warn/50 bg-warn/8 text-warn'}`}
    >
      {t(near ? 'journey.window.near' : 'journey.window.far', {
        ideal: formatNumber(ref.hohmannC3Km2S2, 1),
        months: formatNumber(ref.synodicDays / (365.25 / 12), 0),
      })}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel-raised px-2.5 py-1.5">
      <dt className="text-xs text-quiet">{label}</dt>
      <dd className="font-mono text-[13.5px]" dir="ltr">
        {value}
      </dd>
    </div>
  );
}
