import type { SurfaceHeading } from '@siteline/engine/surface';
import { type ReactNode, type Ref, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../format';
import { type CompassMark, compassMarks, readoutDeg, tapeSpot } from './compass';

/** The tape's scale: at 2.5 px a degree, a wide screen shows about 90° either side of the heading and a phone 70°. */
const PX_PER_DEG = 2.5;
/** The tape runs half a turn past each end of 0° to 360°, so any heading has the view all round it. */
const TAPE_FROM_DEG = -180;
const TAPE_TO_DEG = 540;
const TAPE_WIDTH_PX = (TAPE_TO_DEG - TAPE_FROM_DEG) * PX_PER_DEG;
const TAPE_HEIGHT_PX = 46;
/** A mark beyond the tape waits this far in from its end, degrees, with an arrow the way to turn. */
const END_DEG = 7;
/** Marks waiting at the same end stand side by side, this far apart, degrees. */
const WAITING_STEP_DEG = 8;
/** The way back to touchdown shows once the eye is this far from it, metres. */
const TOUCHDOWN_SHOWN_M = 5;
/** The tape fades out toward both ends; its labels also fade out before they reach the heading's box in the middle. */
const FADE_ENDS = 'linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent)';
const FADE_AROUND_READOUT =
  'linear-gradient(90deg, transparent, #000 15%, #000 calc(50% - 40px), transparent calc(50% - 27px), transparent calc(50% + 27px), #000 calc(50% + 40px), #000 85%, transparent)';

export interface CompassHandle {
  /** Turns the tape to the view's heading and moves the marks along it; called after every frame that moved the view. */
  update(view: SurfaceHeading): void;
}

/** The Sun or the Earth as the eye sees it: its bearing, and whether any of its disc is in view from the eye. */
export interface CompassBody {
  azDeg: number;
  inView: boolean;
}

type MarkKey = 'sun' | 'earth' | 'touchdown';

interface Props {
  ref: Ref<CompassHandle>;
  sun?: CompassBody;
  earth?: CompassBody;
  /** Whether to show the way back to the touchdown point (it goes with the touchdown marker). */
  touchdownShown: boolean;
  className?: string;
}

/**
 * The compass along the top of the surface view: a tape of headings that turns with the view, the heading straight
 * ahead in whole degrees, and the Sun, the Earth and the touchdown point where they lie. It is drawn from the view's own
 * frames, outside React; React draws it once and when the bodies change.
 */
export function SurfaceCompass({ ref, sun, earth, touchdownShown, className = '' }: Props) {
  const { t } = useTranslation();
  const stripRef = useRef<HTMLDivElement>(null);
  const tapeRef = useRef<SVGSVGElement>(null);
  const tapeLabelsRef = useRef<SVGSVGElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const markEls = useRef<Partial<Record<MarkKey, HTMLSpanElement | null>>>({});
  const view = useRef<SurfaceHeading | null>(null);
  const halfSpanDeg = useRef(60);
  const shown = useRef({ sun: false, earth: false, touchdown: false });
  shown.current = { sun: sun !== undefined, earth: earth !== undefined, touchdown: touchdownShown };
  const marks = useMemo(() => compassMarks(TAPE_FROM_DEG, TAPE_TO_DEG), []);

  const place = useCallback(() => {
    const v = view.current;
    const tape = tapeRef.current;
    if (!v || !tape) return;
    const shift = `translateX(${(-(v.headingDeg - TAPE_FROM_DEG) * PX_PER_DEG).toFixed(1)}px)`;
    tape.style.transform = shift;
    if (tapeLabelsRef.current) tapeLabelsRef.current.style.transform = shift;
    const text = `${formatNumber(readoutDeg(v.headingDeg), 0)}°`;
    const readout = readoutRef.current;
    if (readout && readout.textContent !== text) readout.textContent = text;
    const waiting = { ccw: 0, cw: 0 };
    const spot = (key: MarkKey, relDeg: number | null) => {
      const el = markEls.current[key];
      if (!el) return;
      if (relDeg === null) {
        el.style.visibility = 'hidden';
        return;
      }
      const at = tapeSpot(relDeg, halfSpanDeg.current);
      let offsetDeg = at.offsetDeg;
      let beyond: string = at.beyond ?? '';
      if (at.beyond) {
        // Side by side at the end, the first outermost and the only one with the arrow.
        const n = waiting[at.beyond]++;
        offsetDeg += (at.beyond === 'ccw' ? 1 : -1) * n * WAITING_STEP_DEG;
        if (n > 0) beyond = '';
      }
      el.style.visibility = 'visible';
      el.style.transform = `translateX(${(offsetDeg * PX_PER_DEG).toFixed(1)}px)`;
      if (el.dataset.beyond !== beyond) el.dataset.beyond = beyond;
    };
    const on = shown.current;
    spot('sun', on.sun ? v.sunRelDeg : null);
    spot('earth', on.earth ? v.earthRelDeg : null);
    spot('touchdown', on.touchdown && v.fromTouchdownM >= TOUCHDOWN_SHOWN_M ? v.touchdownRelDeg : null);
  }, []);

  useImperativeHandle(ref, () => ({
    update: (v: SurfaceHeading) => {
      view.current = v;
      place();
    },
  }));

  // The marks again when what they show changes: a body read for the first time, the touchdown marker on or off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these say when to place the marks again; `place` reads them from a ref.
  useLayoutEffect(place, [place, sun, earth, touchdownShown]);

  // How much of the tape shows, as the strip's width changes.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const fit = () => {
      halfSpanDeg.current = Math.max(END_DEG, strip.clientWidth / 2 / PX_PER_DEG - END_DEG);
      place();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(strip);
    fit();
    return () => observer.disconnect();
  }, [place]);

  const label = (m: CompassMark) => (m.point ? t(`land.compass.${m.point}`) : formatNumber(m.headingDeg, 0));
  const textClass = (m: CompassMark) =>
    m.kind === 'cardinal'
      ? 'fill-ink font-display text-[14px] font-semibold'
      : m.kind === 'intercardinal'
        ? 'fill-ink/80 font-display text-[11px] font-medium'
        : 'fill-quiet font-mono text-[10px]';

  const mark = (key: MarkKey, icon: ReactNode) => (
    <span
      ref={(el) => {
        markEls.current[key] = el;
      }}
      className="group absolute start-1/2 top-[30px]"
      style={{ visibility: 'hidden' }}
      data-testid={`compass-${key}`}
    >
      <span className="flex -translate-x-1/2 items-center gap-px drop-shadow-[0_1px_2px_rgb(0_0_0/0.9)]">
        <span className="hidden text-[9px] leading-none text-ink group-data-[beyond=ccw]:inline">◀</span>
        {icon}
        <span className="hidden text-[9px] leading-none text-ink group-data-[beyond=cw]:inline">▶</span>
      </span>
    </span>
  );

  return (
    <figure
      dir="ltr"
      aria-label={t('land.compassTitle')}
      className={`glass pointer-events-none relative h-12 overflow-hidden ${className}`}
      data-testid="surface-compass"
    >
      <div ref={stripRef} className="absolute inset-0" aria-hidden="true">
        {/* The tape of headings: its ticks, then its labels, each fading out toward the ends. */}
        <div className="absolute inset-0" style={{ maskImage: FADE_ENDS, WebkitMaskImage: FADE_ENDS }}>
          <svg
            ref={tapeRef}
            className="absolute start-1/2 top-0 will-change-transform"
            width={TAPE_WIDTH_PX}
            height={TAPE_HEIGHT_PX}
            viewBox={`0 0 ${TAPE_WIDTH_PX} ${TAPE_HEIGHT_PX}`}
            aria-hidden="true"
          >
            {marks.map((m) => {
              const x = (m.deg - TAPE_FROM_DEG) * PX_PER_DEG;
              return (
                <line
                  key={m.deg}
                  x1={x}
                  x2={x}
                  y1={0}
                  y2={m.kind === 'cardinal' ? 10 : m.kind === 'tick' ? 4 : 7}
                  className={m.kind === 'tick' ? 'stroke-quiet/70' : 'stroke-ink/85'}
                  strokeWidth={m.kind === 'cardinal' ? 1.5 : 1}
                />
              );
            })}
          </svg>
        </div>
        <div
          className="absolute inset-0"
          style={{ maskImage: FADE_AROUND_READOUT, WebkitMaskImage: FADE_AROUND_READOUT }}
        >
          <svg
            ref={tapeLabelsRef}
            className="absolute start-1/2 top-0 will-change-transform"
            width={TAPE_WIDTH_PX}
            height={TAPE_HEIGHT_PX}
            viewBox={`0 0 ${TAPE_WIDTH_PX} ${TAPE_HEIGHT_PX}`}
            aria-hidden="true"
          >
            {marks
              .filter((m) => m.kind !== 'tick')
              .map((m) => (
                <text
                  key={m.deg}
                  x={(m.deg - TAPE_FROM_DEG) * PX_PER_DEG}
                  y={25}
                  textAnchor="middle"
                  className={textClass(m)}
                >
                  {label(m)}
                </text>
              ))}
          </svg>
        </div>
        {mark('touchdown', <TouchdownIcon />)}
        {mark('earth', <EarthIcon inView={earth?.inView ?? false} />)}
        {mark('sun', <SunIcon inView={sun?.inView ?? false} />)}
      </div>
      {/* Straight ahead: a gold line down from the top, and the heading in whole degrees. */}
      <span
        className="absolute start-1/2 top-0 h-2.5 w-0.5 -translate-x-1/2 rounded-b-full bg-sun"
        aria-hidden="true"
      />
      <p className="absolute start-1/2 top-2.5 min-w-12 -translate-x-1/2 rounded-md border border-sun/60 bg-panel px-1.5 text-center font-mono text-xs leading-[1.125rem] text-sun-ink tabular-nums">
        <span className="sr-only">{t('land.facing')} </span>
        <span ref={readoutRef} data-testid="compass-heading" />
      </p>
      {sun && earth && (
        <p className="sr-only">
          {t('land.compassBodies', { sun: formatNumber(sun.azDeg, 0), earth: formatNumber(earth.azDeg, 0) })}
        </p>
      )}
    </figure>
  );
}

/** The Sun: a disc with rays, filled while some of it is in view from the eye, an outline while it is hidden. */
export function SunIcon({ inView, className = 'size-3.5' }: { inView: boolean; className?: string }) {
  return (
    <svg viewBox="-7 -7 14 14" className={`overflow-visible ${className}`} aria-hidden="true">
      <circle r={2.7} className={inView ? 'fill-sun' : 'fill-none stroke-sun'} strokeWidth={1.3} />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => {
        const r = (a * Math.PI) / 180;
        return (
          <line
            key={a}
            x1={Math.sin(r) * 4.3}
            y1={-Math.cos(r) * 4.3}
            x2={Math.sin(r) * 6.3}
            y2={-Math.cos(r) * 6.3}
            className="stroke-sun"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

/** The Earth: a blue disc, filled while some of it is in view from the eye, an outline while it is hidden. */
export function EarthIcon({ inView, className = 'size-3.5' }: { inView: boolean; className?: string }) {
  return (
    <svg viewBox="-7 -7 14 14" className={className} aria-hidden="true">
      <circle r={5} className={inView ? 'fill-accent' : 'fill-none stroke-accent'} strokeWidth={1.5} />
    </svg>
  );
}

/** The touchdown point: a gold ring with a dot, like the marker on the ground. */
function TouchdownIcon() {
  return (
    <svg viewBox="-7 -7 14 14" className="size-3.5" aria-hidden="true">
      <circle r={5} className="fill-none stroke-sun" strokeWidth={1.5} />
      <circle r={1.6} className="fill-sun" />
    </svg>
  );
}
