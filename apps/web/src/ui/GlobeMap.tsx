import { GlobeView } from '@siteline/engine';
import { MOON_RADIUS_M } from '@siteline/physics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PINNED } from '../landers';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useStageInsets } from '../stage';
import { useApp } from '../store';
import { useFlyToMission, useShownUtcMs } from '../useLanders';
import { LanderPins } from './LanderPins';
import { ViewHint, ViewPills } from './ViewPills';
import { revealWhen, useLoad, ViewStatus } from './ViewStatus';

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
  const load = useLoad();
  const { ready, fail } = load;
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
    let live = true;
    created.ready.then(
      () => live && ready(),
      (e: unknown) => live && fail(e),
    );
    return () => {
      live = false;
      created.dispose();
      setGlobe(null);
    };
  }, [ready, fail]);

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

  const insets = useStageInsets();
  useEffect(() => {
    globe?.setInsets(insets);
  }, [globe, insets]);

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className={`stage-canvas ${revealWhen(load)}`} data-testid="globe-map" />
      <LanderPins
        host={load.state === 'ready' ? globe : null}
        missions={PINNED.Moon}
        tracks={undefined}
        atUtcMs={shownMs}
      />
      <ViewPills>
        {/* The demo's gold call to action: the way down to where the landing sites are. */}
        <button
          type="button"
          disabled={!globe || flying}
          onClick={() => globe && void flyToPole(globe, setFlying)}
          className="min-h-9 rounded-md border border-sun/60 bg-sun/15 px-3 text-sm text-sun-ink hover:border-sun disabled:opacity-60"
        >
          {flying ? t('globe.flying') : t('globe.flyToPole')}
        </button>
      </ViewPills>
      <ViewHint>{t('globe.hint')}</ViewHint>
      <ViewStatus view="globe" load={load} />
    </section>
  );
}
