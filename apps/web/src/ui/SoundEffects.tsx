import { onFlight } from '@siteline/engine';
import { useEffect } from 'react';
import { lightingUtcMsOf, useSunTrack } from '../physics';
import { sound, useSound } from '../sound';
import { sunAt } from '../sound/maps';
import { useApp } from '../store';

/** True while the time-lapse plays over the Moon with sound on: the moments its sunlight is heard. */
export function useSonifying(): boolean {
  const playing = useApp((s) => s.playing);
  const view = useApp((s) => s.view);
  const on = useSound((s) => s.on);
  const ready = useSound((s) => s.ready);
  return playing && on && ready && (view === 'pole' || view === 'globe');
}

/**
 * The sunlight sonification. While the time-lapse plays, the tone follows the share of the Sun's disc above the
 * selected site's horizon, read from the physics worker's stay check at the time-lapse's moment, frame by frame: it
 * rises as the Sun comes into view over the terrain and falls as it sets. The same reading is shown beside Play.
 */
function SunSonification() {
  const active = useSonifying();
  const track = useSunTrack(active);
  useEffect(() => {
    if (!active || !track) return;
    const follow = () => {
      const at = lightingUtcMsOf(useApp.getState());
      const f = sunAt(track, at);
      sound.sonify.set(Number.isFinite(f) ? f : 0, at);
    };
    follow();
    const stop = useApp.subscribe((s, before) => {
      if (s.playOffsetH !== before.playOffsetH) follow();
    });
    return () => {
      stop();
      sound.sonify.stop();
    };
  }, [active, track]);
  return null;
}

/**
 * The app's sounds that follow what happens anywhere: camera flights (the pull back out to the solar system has a sound
 * of its own) and the time-lapse.
 */
export function SoundEffects() {
  useEffect(() => onFlight((flight) => (flight.back ? sound.pullBack(flight) : sound.whoosh(flight))), []);
  return <SunSonification />;
}
