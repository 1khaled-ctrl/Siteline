import { GlobeView } from '@siteline/engine';
import { MOON_RADIUS_M } from '@siteline/physics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PINNED } from '../landers';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useApp } from '../store';
import { useFlyToMission, useShownUtcMs } from '../useLanders';
import { LanderPins } from './LanderPins';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
// The loaded terrain reaches about 76°S; anything south of this opens in the south-pole view.
const POLE_VIEW_LIMIT_DEG = -77;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// A lander is framed from this many Moon radii from the centre.
const LANDER_DISTANCE_KM = 1.9 * (MOON_RADIUS_M / 1000);

async function flyToPole(view: GlobeView, setFlying: (v: boolean) => void, focus?: { lat: number; lon: number }) {
  setFlying(true);
  await view.flyToSouthPole(reducedMotion() ? 0 : 2600);
  const app = useApp.getState();
  if (focus) app.focusSite(focus.lat, focus.lon);
  else app.set({ view: 'pole' });
}

export function GlobeMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [globe, setGlobe] = useState<GlobeView | null>(null);
  const [flying, setFlying] = useState(false);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const lightingUtcMs = useLightingUtcMs();
  const shownMs = useShownUtcMs();
  useFlyToMission(
    'Moon',
    globe ? (lat, lon) => void globe.flyTo(lat, lon, LANDER_DISTANCE_KM, reducedMotion() ? 0 : 1200) : undefined,
  );

  useEffect(() => {
    if (!ref.current) return;
    const created = new GlobeView(
      ref.current,
      {
        color: `${ASSETS}/img/moon.jpg`,
        colorHd: `${ASSETS}/img/moon_color.jpg`,
        slopesHd: `${ASSETS}/img/moon_normal.jpg`,
      },
      {
        onPick: (lat, lon) => {
          const rounded = { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
          useApp.getState().set({ latDeg: rounded.lat, lonDeg: rounded.lon });
          if (lat <= POLE_VIEW_LIMIT_DEG) void flyToPole(created, setFlying, rounded);
        },
      },
    );
    setGlobe(created);
    return () => {
      created.dispose();
      setGlobe(null);
    };
  }, []);

  useEffect(() => {
    globe?.setSite(latDeg, lonDeg);
  }, [globe, latDeg, lonDeg]);

  useEffect(() => {
    if (!globe) return;
    let live = true;
    physics.sunKm(lightingUtcMs, URLS.data).then((sun) => {
      if (live) globe.setSun(sun);
    });
    return () => {
      live = false;
    };
  }, [globe, lightingUtcMs]);

  return (
    <section className="fade-in relative min-h-[60vh] overflow-hidden rounded-xl border border-white/10 lg:min-h-0">
      <div ref={ref} className="absolute inset-0" data-testid="globe-map" />
      <LanderPins host={globe} missions={PINNED.Moon} tracks={undefined} atUtcMs={shownMs} />
      <p className="pointer-events-none absolute inset-s-3 top-3 max-w-md rounded-lg bg-panel/72 px-3 py-2 text-xs text-quiet backdrop-blur-md">
        {t('globe.hint')}
      </p>
      <button
        type="button"
        disabled={!globe || flying}
        onClick={() => globe && void flyToPole(globe, setFlying)}
        className="absolute inset-x-0 bottom-4 mx-auto min-h-11 w-fit rounded-full bg-accent px-6 font-semibold text-space shadow-lg disabled:opacity-60"
      >
        {flying ? t('globe.flying') : t('globe.flyToPole')}
      </button>
    </section>
  );
}
