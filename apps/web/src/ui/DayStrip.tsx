import { DEFAULT_STAY } from '@siteline/contracts';
import { type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { STRIP_STEP_MINUTES, type DayStrip as Strip } from '../dayStrip';
import { formatNumber } from '../format';
import { DAY_MS, physics, URLS } from '../physics';
import { Spinner } from './ViewStatus';

type Result = Strip & { sources: string[] };
type Rgb = readonly [number, number, number];

/** The pole map's sunlight ramp (colour-blind safe), so gold means the same thing in both places. */
const SUN_RAMP: [number, Rgb][] = [
  [0, [0, 33, 77]],
  [0.5, [125, 125, 120]],
  [1, [255, 232, 77]],
];
const EARTH_RAMP: [number, Rgb][] = [
  [0, [0, 22, 50]],
  [1, [91, 169, 255]],
];
const ROW_H = 8;
const GAP = 2;
const LABEL_W = 34;
const TOP = 12;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function colour(ramp: [number, Rgb][], v: number): string {
  const x = Math.max(0, Math.min(1, v));
  let i = 0;
  while (i < ramp.length - 2 && x > ramp[i + 1][0]) i++;
  const [a, ca] = ramp[i];
  const [b, cb] = ramp[i + 1];
  const k = (x - a) / (b - a);
  return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * k)).join(',')})`;
}

const yearOf = (ms: number) => new Date(ms).getUTCFullYear();
const dayOfYear = (ms: number) => Math.floor((ms - Date.UTC(yearOf(ms), 0, 1)) / DAY_MS);

/** Which day of the strip a point on the canvas is, or undefined between rows or past the ends. */
function dayAt(strip: Strip, width: number, x: number, y: number): number | undefined {
  const firstYear = yearOf(strip.startUtcMs);
  const row = Math.floor((y - TOP) / (ROW_H + GAP));
  const col = Math.floor(((x - LABEL_W) / (width - LABEL_W)) * 366);
  if (row < 0 || col < 0 || col > 365) return undefined;
  const ms = Date.UTC(firstYear + row, 0, 1) + col * DAY_MS;
  const d = Math.round((ms - strip.startUtcMs) / DAY_MS);
  return d >= 0 && d < strip.days && yearOf(ms) === firstYear + row ? d : undefined;
}

function drawStrip(
  c: HTMLCanvasElement,
  strip: Strip,
  values: Float32Array,
  ramp: [number, Rgb][],
  reveal: number,
  stay: { fromMs: number; toMs: number },
  monthLetters: string[],
) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const w = c.clientWidth;
  const firstYear = yearOf(strip.startUtcMs);
  const years = yearOf(strip.startUtcMs + (strip.days - 1) * DAY_MS) - firstYear + 1;
  const h = TOP + years * (ROW_H + GAP);
  c.style.height = `${h}px`;
  c.width = Math.round(w * ratio);
  c.height = Math.round(h * ratio);
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(ratio, 0, 0, ratio, 0, 0);
  g.clearRect(0, 0, w, h);
  const colW = (w - LABEL_W) / 366;

  g.font = '10px "IBM Plex Mono", monospace';
  g.fillStyle = '#8e9ab5';
  g.textAlign = 'center';
  monthLetters.forEach((m, i) => {
    g.fillText(m, LABEL_W + (dayOfYear(Date.UTC(2001, i, 15)) + 0.5) * colW, 9);
  });
  g.textAlign = 'start';
  for (let r = 0; r < years; r++) g.fillText(String(firstYear + r), 0, TOP + r * (ROW_H + GAP) + ROW_H - 1);

  const shown = Math.floor(strip.days * reveal);
  for (let d = 0; d < shown; d++) {
    const ms = strip.startUtcMs + d * DAY_MS;
    g.fillStyle = colour(ramp, values[d]);
    g.fillRect(LABEL_W + dayOfYear(ms) * colW, TOP + (yearOf(ms) - firstYear) * (ROW_H + GAP), Math.ceil(colW), ROW_H);
  }

  // The stay being checked, outlined in gold (it can cross the new year).
  g.strokeStyle = '#ffe2a6';
  g.lineWidth = 1.5;
  for (let ms = stay.fromMs; ms < stay.toMs; ) {
    const end = Math.min(stay.toMs, Date.UTC(yearOf(ms) + 1, 0, 1));
    const x = LABEL_W + dayOfYear(ms) * colW;
    const y = TOP + (yearOf(ms) - firstYear) * (ROW_H + GAP);
    if (yearOf(ms) - firstYear < years)
      g.strokeRect(x - 1, y - 1.5, Math.max(3, ((end - ms) / DAY_MS) * colW) + 2, ROW_H + 3);
    ms = end;
  }
}

/**
 * The long view behind the verdict: for every day the ephemeris covers, how much of it this spot has the Sun and the
 * Earth, by the stay check's own rules. Lunar nights, winters and the long dark spells show as bands.
 */
export function DayStripPanel({
  latDeg,
  lonDeg,
  fromMs,
  toMs,
}: {
  latDeg: number;
  lonDeg: number;
  fromMs: number;
  toMs: number;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [reveal, setReveal] = useState(0);
  const [hover, setHover] = useState<number>();
  const sunRef = useRef<HTMLCanvasElement>(null);
  const earthRef = useRef<HTMLCanvasElement>(null);
  const monthLetters = t('dayStrip.months');
  const months = useMemo(() => monthLetters.split(','), [monthLetters]);

  useEffect(() => {
    let live = true;
    setResult(undefined);
    setError(undefined);
    // The strip covers every day, so it depends on the spot only; the landing date just moves the outline.
    const query = {
      ...DEFAULT_STAY,
      site: { id: `moon:${latDeg},${lonDeg}`, body: 'moon' as const, latDeg, lonDeg },
      landingUtc: new Date(0).toISOString(),
    };
    physics.dayStrip(query, URLS).then(
      (r) => live && setResult(r),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [latDeg, lonDeg]);

  useEffect(() => {
    if (!result) return;
    if (reducedMotion()) {
      setReveal(1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - start) / 1400);
      setReveal(1 - (1 - k) ** 3);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    setReveal(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [result]);

  useEffect(() => {
    if (!result) return;
    const stay = { fromMs, toMs };
    if (sunRef.current) drawStrip(sunRef.current, result, result.sun, SUN_RAMP, reveal, stay, months);
    if (earthRef.current) drawStrip(earthRef.current, result, result.earth, EARTH_RAMP, reveal, stay, months);
  }, [result, reveal, fromMs, toMs, months]);

  if (error) return <p className="text-xs text-quiet">{t('dayStrip.failed', { message: error })}</p>;
  if (!result)
    return (
      <p className="flex items-center gap-2 text-xs text-quiet">
        <Spinner className="size-3.5" />
        {t('dayStrip.working')}
      </p>
    );

  const first = yearOf(result.startUtcMs);
  const last = yearOf(result.startUtcMs + (result.days - 1) * DAY_MS);
  const focus = hover ?? Math.round((fromMs - result.startUtcMs) / DAY_MS);
  const inRange = focus >= 0 && focus < result.days;
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(dayAt(result, r.width, e.clientX - r.left, e.clientY - r.top));
  };
  const strip = (ref: typeof sunRef, label: string, which: 'sun' | 'earth') => (
    <figure className="m-0">
      <figcaption className="mb-1 flex items-baseline justify-between text-xs text-quiet">
        <span>{label}</span>
        <span className="font-mono" dir="ltr">
          {t('dayStrip.overall', { pct: formatNumber(which === 'sun' ? result.sunPct : result.earthPct, 0) })}
        </span>
      </figcaption>
      <canvas
        ref={ref}
        className="block w-full cursor-crosshair"
        role="img"
        aria-label={t(`dayStrip.aria.${which}`, {
          first,
          last,
          pct: formatNumber(which === 'sun' ? result.sunPct : result.earthPct, 0),
        })}
        onPointerMove={move}
        onPointerLeave={() => setHover(undefined)}
      />
    </figure>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="day-strip">
      <h3 className="text-base">{t('dayStrip.heading', { first, last })}</h3>
      {strip(sunRef, t('dayStrip.sun'), 'sun')}
      {strip(earthRef, t('dayStrip.earth'), 'earth')}
      <p className="min-h-5 font-mono text-[12px] text-ink" aria-live="polite" dir="ltr">
        {inRange &&
          t('dayStrip.day', {
            date: new Date(result.startUtcMs + focus * DAY_MS).toISOString().slice(0, 10),
            sun: formatNumber(result.sun[focus] * 100, 0),
            earth: formatNumber(result.earth[focus] * 100, 0),
          })}
      </p>
      <p className="text-xs text-quiet">
        {t('dayStrip.note', {
          pct: formatNumber(DEFAULT_STAY.minSunFraction * 100, 0),
          hours: formatNumber(STRIP_STEP_MINUTES / 60, 0),
        })}
      </p>
    </div>
  );
}
