import { useEffect } from 'react';
import { useApp } from '../store';
import { EarthMap } from './EarthMap';
import { GlobeMap } from './GlobeMap';
import { MarsMap } from './MarsMap';
import { PoleMap } from './PoleMap';
import { SiteMap } from './SiteMap';
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

function CurrentView() {
  const view = useApp((s) => s.view);
  if (view === 'solar') return <SolarMap />;
  if (view === 'earth') return <EarthMap />;
  if (view === 'mars') return <MarsMap />;
  if (view === 'site') return <SiteMap />;
  return view === 'globe' ? <GlobeMap /> : <PoleMap />;
}

/**
 * The 3D view. On a wide screen it fills the window up to the floating panel (410 px and its 12 px margin), so the
 * world sits in the middle of the part you can see, as the demo does by shifting its camera.
 */
export function MoonView() {
  usePlayClock();
  return (
    <div className="relative h-[60vh] lg:absolute lg:inset-y-0 lg:inset-s-0 lg:inset-e-[422px] lg:h-auto">
      <CurrentView />
    </div>
  );
}
