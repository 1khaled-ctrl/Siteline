import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStage } from '../stage';
import { samePin, useApp } from '../store';
import { FLYABLE, type Flyable, WORLDS, type World, worldColour } from './WorldsList';

/** One click of the dial: twelve to a turn, like a watch's crown. */
const STEP_DEG = 30;
/** Turning faster than this many clicks a second moves time a day per click instead of an hour. */
const FAST_STEPS_PER_S = 7;
const LOOP_HOURS = 30 * 24;

type Mode = 'worlds' | 'time' | 'sites';

const tick = () => navigator.vibrate?.(6);

/**
 * The phone's one control: a dial at the bottom of the screen, turned with the thumb. What it turns depends on the
 * view: the worlds in the solar system (the sheet shows the one picked, and a tap flies there), or time everywhere
 * else (an hour a click, a day a click when turned fast; a tap goes back to the landing time), or, at the south pole
 * with sites pinned, which pinned site you are looking at. Arrow keys turn it too.
 */
export function OrbitDial() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  const pins = useApp((s) => s.pins);
  const playOffsetH = useApp((s) => s.playOffsetH);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const world = useStage((s) => s.dialWorld);
  const sheetOpen = useStage((s) => s.sheetOpen);
  const [sitesMode, setSitesMode] = useState(false);
  const mode: Mode = view === 'solar' ? 'worlds' : view === 'pole' && sitesMode && pins.length > 1 ? 'sites' : 'time';
  const [angle, setAngle] = useState(0);
  const grip = useRef<{ last: number; acc: number; moved: boolean; at: number } | null>(null);
  const knob = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pins.length < 2) setSitesMode(false);
  }, [pins.length]);

  /** Moves whatever the dial turns by `n` clicks; `fast` when the thumb is flying. */
  function turn(n: number, fast = false) {
    if (!n) return;
    tick();
    if (mode === 'worlds') {
      const i = WORLDS.indexOf(world);
      const next = WORLDS[(((i + n) % WORLDS.length) + WORLDS.length) % WORLDS.length];
      useStage.getState().setDialWorld(next);
      useStage.getState().solar?.highlight(next === 'sun' ? null : next);
    } else if (mode === 'time') {
      const { setPlay } = useApp.getState();
      const next = playOffsetH + n * (fast ? 24 : 1);
      setPlay({ playing: false, playOffsetH: ((next % LOOP_HOURS) + LOOP_HOURS) % LOOP_HOURS });
    } else {
      const here = pins.findIndex((p) => samePin(p, { latDeg, lonDeg }));
      const next = pins[(((here + n) % pins.length) + pins.length) % pins.length];
      useApp.getState().focusSite(next.latDeg, next.lonDeg);
    }
  }

  /** A tap on the middle: fly to the picked world, or back to the landing time. */
  function press() {
    if (mode === 'worlds' && FLYABLE.has(world)) useApp.getState().commandSolar(world as Flyable);
    else if (mode === 'time') useApp.getState().setPlay({ playing: false, playOffsetH: 0 });
  }

  const centreOf = () => {
    const r = knob.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 0, y: 0 };
  };
  const angleAt = (e: ReactPointerEvent) => {
    const c = centreOf();
    return (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI;
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    grip.current = { last: angleAt(e), acc: 0, moved: false, at: performance.now() };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g) return;
    const a = angleAt(e);
    // The shortest way round from the last reading, so crossing ±180° does not jump a full turn.
    const d = ((a - g.last + 540) % 360) - 180;
    g.last = a;
    g.acc += d;
    if (Math.abs(g.acc) > 4) g.moved = true;
    setAngle((v) => v + d);
    const clicks = Math.trunc(g.acc / STEP_DEG);
    if (clicks) {
      const now = performance.now();
      const rate = Math.abs(clicks) / Math.max(0.016, (now - g.at) / 1000);
      g.at = now;
      g.acc -= clicks * STEP_DEG;
      turn(clicks, rate > FAST_STEPS_PER_S);
    }
  };
  const onUp = () => {
    const g = grip.current;
    grip.current = null;
    if (g && !g.moved) press();
    // Settle on the nearest click.
    setAngle((v) => Math.round(v / STEP_DEG) * STEP_DEG);
  };

  const hours = Math.round(playOffsetH);
  const value =
    mode === 'worlds'
      ? t(`bodies.${world}`)
      : mode === 'time'
        ? hours === 0
          ? t('dial.landing')
          : t('dial.hours', { n: hours >= 48 ? `${Math.floor(hours / 24)} d ${hours % 24}` : hours })
        : t('dial.site', {
            n: pins.findIndex((p) => samePin(p, { latDeg, lonDeg })) + 1 || 1,
            of: pins.length,
          });

  return (
    <div
      className={`dial-wrap pointer-events-none absolute inset-x-0 z-30 flex items-end justify-center transition-opacity duration-300 ${sheetOpen ? 'opacity-0' : 'opacity-100'}`}
      data-testid="dial"
      inert={sheetOpen}
    >
      {view === 'pole' && pins.length > 1 && (
        <button
          type="button"
          className="dial-chip pointer-events-auto me-2 mb-8"
          aria-pressed={sitesMode}
          onClick={() => setSitesMode((v) => !v)}
        >
          {sitesMode ? t('dial.modeSites') : t('dial.modeTime')}
        </button>
      )}
      <div
        ref={knob}
        role="slider"
        tabIndex={0}
        aria-label={t(`dial.label.${mode}`)}
        aria-valuetext={value}
        aria-valuenow={mode === 'time' ? hours : undefined}
        className="dial glass pointer-events-auto relative grid size-[104px] touch-none place-items-center rounded-full select-none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          const n =
            e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
          if (n) {
            e.preventDefault();
            setAngle((v) => v + n * STEP_DEG);
            turn(n, e.shiftKey);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            press();
          }
        }}
      >
        {/* The rim's ticks turn with the thumb; the notch at the top stays put. */}
        <div className="dial-rim absolute inset-0" style={{ rotate: `${angle}deg` }} aria-hidden="true">
          {Array.from({ length: 12 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: twelve fixed ticks.
            <span key={i} className="dial-tick" style={{ rotate: `${i * 30}deg` }} />
          ))}
        </div>
        <span className="dial-notch" aria-hidden="true" />
        <div className="pointer-events-none flex flex-col items-center px-3 text-center">
          {mode === 'worlds' && (
            <span
              className="mb-1 size-2.5 rounded-pill"
              style={{ background: worldColour(world as World), boxShadow: `0 0 8px ${worldColour(world as World)}` }}
            />
          )}
          <span className="font-display text-[15px] leading-tight">{value}</span>
          <span className="mt-0.5 text-[10px] text-quiet">
            {mode === 'worlds'
              ? FLYABLE.has(world)
                ? t('dial.tapFly')
                : t('dial.turn')
              : mode === 'time'
                ? t('dial.tapReset')
                : t('dial.turn')}
          </span>
        </div>
      </div>
    </div>
  );
}
