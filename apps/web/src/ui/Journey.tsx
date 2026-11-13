import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatUtc } from '../format';
import {
  type CraftSample,
  type Journey,
  MARS_TOF_DAYS,
  MOON_COAST_DAYS,
  MOON_ORBIT_DAYS,
  marsJourney,
  moonJourney,
  type Positions,
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
const PLAY_SECONDS = 14;
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

interface Labels {
  earth: string;
  moon: string;
  mars: string;
  sun: string;
  depart: string;
  arrive: string;
  touchdown: string;
  site: string;
  scale: string;
}

/** One frame of the journey at `tUtcMs`, top-down onto the plane of motion. */
function draw(g: CanvasRenderingContext2D, w: number, h: number, j: Journey, tUtcMs: number, labels: Labels) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = COLOURS.bg;
  g.fillRect(0, 0, w, h);

  const pts: XY[] = [...j.craft.map((c) => c.xy), ...Object.values(j.tracks).flatMap((tr) => tr.map((p) => p.xy))];
  if (j.body === 'Mars') pts.push(...(j.rings.mars ?? []), ...(j.rings.earth ?? []));
  // Framed on everything drawn, so the picture fills the canvas whichever way the orbit lies.
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((w * 0.84) / (x1 - x0 || 1), (h * 0.74) / (y1 - y0 || 1));
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const toScreen = ([x, y]: XY): XY => [w / 2 + (x - mx) * s, h / 2 + 12 - (y - my) * s];
  const fromScreen = ([x, y]: XY): XY => [(x - w / 2) / s + mx, (h / 2 + 12 - y) / s + my];

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
  const label = (at: XY, text: string, dy: number, colour = COLOURS.quiet) => {
    const [x, y] = toScreen(at);
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
  if (j.body === 'Mars') {
    line(j.rings.earth ?? [], 'rgba(91, 169, 255, 0.28)', 1);
    line(j.rings.mars ?? [], 'rgba(224, 115, 74, 0.3)', 1);
    disc([0, 0], 9, COLOURS.sun, 24);
    label([0, 0], labels.sun, 24);
  } else {
    line(
      (j.tracks.moon ?? []).map((p) => p.xy),
      'rgba(201, 206, 216, 0.35)',
      1.2,
      [2, 5],
    );
  }
  line(
    j.craft.map((c) => c.xy),
    COLOURS.path,
    1.5,
    [5, 6],
  );
  const done = j.craft.filter((c) => c.tUtcMs <= tUtcMs).map((c) => c.xy);
  const here = craftAt(j.craft, Math.min(tUtcMs, j.arriveUtcMs));
  if (tUtcMs > j.craft[0].tUtcMs) done.push(here.s.xy);
  g.save();
  g.shadowColor = COLOURS.craft;
  g.shadowBlur = 8;
  line(done, COLOURS.craft, 2.2);
  g.restore();

  const earthXY = j.body === 'Mars' ? trackAt(j.tracks.earth ?? [], tUtcMs) : ([0, 0] as XY);
  disc(earthXY, j.body === 'Mars' ? 6 : 11, COLOURS.earth, 14);
  label(earthXY, labels.earth, j.body === 'Mars' ? 20 : 27);
  const target = j.body === 'Mars' ? 'mars' : 'moon';
  const targetXY = trackAt(j.tracks[target] ?? [], tUtcMs);
  const targetR = j.body === 'Mars' ? 5.5 : 6.5;
  disc(targetXY, targetR, j.body === 'Mars' ? COLOURS.mars : COLOURS.moon, 10);
  label(targetXY, j.body === 'Mars' ? labels.mars : labels.moon, -14);
  // At the Moon the start is on top of the Earth, whose name is below it.
  label(j.craft[0].xy, labels.depart, j.body === 'Moon' ? -20 : 22, COLOURS.craft);

  // The craft: on its transfer orbit, then (Moon) circling in lunar orbit, then down at the site.
  let craftXY = here.s.xy;
  let heading = here.heading;
  const landed = tUtcMs >= j.landUtcMs;
  if (tUtcMs > j.arriveUtcMs && j.body === 'Moon') {
    const k = (tUtcMs - j.arriveUtcMs) / (j.landUtcMs - j.arriveUtcMs);
    const turns = 6 * k;
    const [tx, ty] = toScreen(targetXY);
    const r = landed ? 0 : targetR + 7;
    const a = turns * Math.PI * 2;
    g.strokeStyle = 'rgba(244, 182, 63, 0.4)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(tx, ty, targetR + 7, 0, Math.PI * 2);
    g.stroke();
    craftXY = fromScreen([tx + r * Math.cos(a), ty - r * Math.sin(a)]);
    heading = a + Math.PI / 2;
  } else if (landed) {
    craftXY = targetXY;
  }
  const [x, y] = toScreen(craftXY);
  g.save();
  g.translate(x, y);
  g.rotate(-heading);
  g.shadowColor = COLOURS.craft;
  g.shadowBlur = 14;
  g.fillStyle = COLOURS.craft;
  g.beginPath();
  g.moveTo(7, 0);
  g.lineTo(-5, 4.5);
  g.lineTo(-2.5, 0);
  g.lineTo(-5, -4.5);
  g.closePath();
  g.fill();
  g.restore();
  if (tUtcMs >= j.arriveUtcMs) label(targetXY, landed ? labels.touchdown : labels.arrive, 24, COLOURS.craft);

  if (j.sunDir) {
    const [dx, dy] = j.sunDir;
    const ax = 30;
    const ay = h - 30;
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
    g.textAlign = 'left';
    g.fillText(labels.sun, ax + 8, ay + 16);
  }

  // The landing site, once the craft has arrived: a small globe seen from straight above the site.
  if (tUtcMs >= j.arriveUtcMs) {
    const R = 46;
    const ix = w - R - 18;
    const iy = R + 18;
    g.save();
    g.globalAlpha = Math.min(1, (tUtcMs - j.arriveUtcMs) / (0.15 * (j.landUtcMs - j.arriveUtcMs + DAY_MS)));
    const grad = g.createRadialGradient(ix - R * 0.3, iy - R * 0.3, R * 0.1, ix, iy, R);
    grad.addColorStop(0, j.body === 'Mars' ? '#e79a6e' : '#d8dce4');
    grad.addColorStop(1, j.body === 'Mars' ? '#7a3a22' : '#5a606c');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(ix, iy, R, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1;
    for (const rr of [R * 0.4, R * 0.75]) {
      g.beginPath();
      g.arc(ix, iy, rr, 0, Math.PI * 2);
      g.stroke();
    }
    g.fillStyle = landed ? COLOURS.craft : 'rgba(244, 182, 63, 0.5)';
    g.beginPath();
    g.arc(ix, iy, landed ? 5 : 3.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = COLOURS.ink;
    g.font = '500 11.5px "IBM Plex Sans", system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(labels.site, ix, iy + R + 16);
    g.restore();
  }

  g.fillStyle = COLOURS.quiet;
  g.font = '400 11px "IBM Plex Sans", system-ui, sans-serif';
  g.textAlign = 'right';
  g.fillText(labels.scale, w - 12, h - 12);
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

  const tUtcMs = journey ? journey.departUtcMs + k * (journey.landUtcMs - journey.departUtcMs) : 0;
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
      touchdown: t('journey.touchdown'),
      site: place,
      scale: t('journey.notToScale'),
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
    draw(g, w, h, journey, tUtcMs, labels);
  }, [journey, tUtcMs, labels]);

  const phase = !journey
    ? ''
    : tUtcMs >= journey.landUtcMs
      ? t('journey.phase.landed')
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
