import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStage } from '../stage';

type State = 'off' | 'on' | 'denied' | 'none';

/** Degrees of phone tilt to radians of look: 20° of tilt turns the view about 4.6°. */
const GAIN = 0.004;
const MAX_YAW = 0.1;
const MAX_PITCH = 0.07;
const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

interface OrientationPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Tilt to look, on phones: once you tap the button (never on its own, and iPhones ask first), tilting the phone turns
 * the 3D view a little, as if looking through a window, from wherever you held it when you tapped. Dragging still
 * works on top. Tap again to stop. Not offered to anyone who asked for reduced motion.
 */
export function TiltButton() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>('off');
  const [calm] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const stop = useRef<() => void>(() => {});
  const sheetOpen = useStage((s) => s.sheetOpen);

  useEffect(() => () => stop.current(), []);
  // A note about why tilt is off says so for a few seconds, then gets out of the way.
  useEffect(() => {
    if (state !== 'denied' && state !== 'none') return;
    const timer = setTimeout(() => setState('off'), 5000);
    return () => clearTimeout(timer);
  }, [state]);
  if (calm || typeof DeviceOrientationEvent === 'undefined') return null;

  async function start() {
    const permission = (DeviceOrientationEvent as unknown as OrientationPermission).requestPermission;
    if (permission && (await permission().catch(() => 'denied')) !== 'granted') {
      setState('denied');
      return;
    }
    let base: { beta: number; gamma: number } | null = null;
    const want = { yaw: 0, pitch: 0 };
    const now = { yaw: 0, pitch: 0 };
    let heard = false;
    const orient = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      heard = true;
      base ??= { beta: e.beta, gamma: e.gamma };
      let dx = e.gamma - base.gamma;
      let dy = e.beta - base.beta;
      // Held sideways, the phone's axes swap.
      const turn = screen.orientation?.angle ?? 0;
      if (turn === 90) [dx, dy] = [dy, -dx];
      else if (turn === 270 || turn === -90) [dx, dy] = [-dy, dx];
      want.yaw = clamp(-dx * GAIN, MAX_YAW);
      want.pitch = clamp(-dy * GAIN, MAX_PITCH);
    };
    let frame = 0;
    const step = () => {
      now.yaw += (want.yaw - now.yaw) * 0.12;
      now.pitch += (want.pitch - now.pitch) * 0.12;
      useStage.getState().active?.setLook(now.yaw, now.pitch);
      frame = requestAnimationFrame(step);
    };
    window.addEventListener('deviceorientation', orient);
    frame = requestAnimationFrame(step);
    // No reading at all within a moment means there is no sensor to read.
    const check = setTimeout(() => {
      if (!heard) {
        stop.current();
        setState('none');
      }
    }, 1500);
    stop.current = () => {
      window.removeEventListener('deviceorientation', orient);
      cancelAnimationFrame(frame);
      clearTimeout(check);
      useStage.getState().active?.setLook(0, 0);
      stop.current = () => {};
    };
    setState('on');
  }

  return (
    <div
      className={`tilt-wrap pointer-events-none fixed inset-s-4 z-20 flex flex-col items-start gap-2 transition-opacity duration-300 ${sheetOpen ? 'opacity-0' : ''}`}
      inert={sheetOpen}
    >
      {(state === 'denied' || state === 'none') && (
        <p role="status" className="glass pointer-events-auto max-w-56 px-3 py-2 text-xs text-quiet">
          {t(`tilt.${state}`)}
        </p>
      )}
      <button
        type="button"
        aria-pressed={state === 'on'}
        aria-label={state === 'on' ? t('tilt.on') : t('tilt.off')}
        className="tilt glass pointer-events-auto grid size-11 place-items-center rounded-full"
        onClick={() => {
          if (state === 'on') {
            stop.current();
            setState('off');
          } else void start();
        }}
      >
        {/* A phone tipped a little, with two arcs for motion. */}
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="8" y="4" width="8" height="16" rx="2" transform="rotate(-14 12 12)" />
            <path d="M3.5 9.5a9 9 0 0 0 0 5M20.5 9.5a9 9 0 0 1 0 5" />
          </g>
        </svg>
      </button>
    </div>
  );
}
