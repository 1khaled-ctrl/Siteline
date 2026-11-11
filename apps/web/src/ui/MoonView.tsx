import { useEffect } from 'react';
import { useApp } from '../store';
import { EarthMap } from './EarthMap';
import { GlobeMap } from './GlobeMap';
import { PoleMap } from './PoleMap';
import { SolarMap } from './SolarMap';

const LOOP_HOURS = 30 * 24;

/** Advances the time-lapse clock while it is playing, looping over the 30-day timeline. */
function usePlayClock() {
  const playing = useApp((s) => s.playing);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const { speedHPerS, playOffsetH, setPlay } = useApp.getState();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setPlay({ playOffsetH: (playOffsetH + speedHPerS * dt) % LOOP_HOURS });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);
}

export function MoonView() {
  const view = useApp((s) => s.view);
  usePlayClock();
  if (view === 'solar') return <SolarMap />;
  if (view === 'earth') return <EarthMap />;
  return view === 'globe' ? <GlobeMap /> : <PoleMap />;
}
