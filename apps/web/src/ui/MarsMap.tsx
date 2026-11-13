import { findFeature, type MarsFeature, MarsView, marsRoutes } from '@siteline/engine';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MISSIONS, PINNED } from '../landers';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useActiveView, useStageInsets } from '../stage';
import { useApp } from '../store';
import { useFlyToMission, useLanderFiles, useShownUtcMs } from '../useLanders';
import { CalloutLayer } from './Callouts';
import { LanderPins } from './LanderPins';
import { BodyCard, MarsPlaceCard, onOutline } from './SceneCards';
import { ViewHint, ViewPills, viewButton } from './ViewPills';
import { revealWhen, useLoad, ViewStatus } from './ViewStatus';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
const MARS_ASSETS = {
  color: `${ASSETS}/img/mars_color.jpg`,
  height: `${ASSETS}/img/mars_height.png`,
  // Built from the height map and from USGS's Gazetteer download by `pnpm mars-data` (see CREDITS.md).
  normal: `${URLS.data}/mars/mars_normal.png`,
  names: `${URLS.data}/names/mars_names.json`,
};
const DEFAULT_RELIEF = 3;
// A lander is framed from this many Mars radii from the centre.
const LANDER_DISTANCE = 1.9;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ms = (n: number) => (reducedMotion() ? 0 : n);

export function MarsMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [globe, setGlobe] = useState<MarsView | null>(null);
  const [features, setFeatures] = useState<readonly MarsFeature[]>([]);
  const [heightsReady, setHeightsReady] = useState(false);
  const [realLight, setRealLight] = useState(false);
  const [names, setNames] = useState(true);
  const [relief, setRelief] = useState(DEFAULT_RELIEF);
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const place = useApp((s) => s.marsPlace);
  const command = useApp((s) => s.marsCommand);
  const lightingUtcMs = useLightingUtcMs();
  const shownMs = useShownUtcMs();
  const { tracks } = useLanderFiles();
  const load = useLoad();
  const { ready, fail } = load;
  useFlyToMission('Mars', globe ? (lat, lon) => void globe.flyTo(lat, lon, LANDER_DISTANCE, ms(1200)) : undefined);

  useEffect(() => {
    if (!ref.current) return;
    const created = new MarsView(ref.current, {
      assets: MARS_ASSETS,
      onPick: (picked) => useApp.getState().setMarsPlace(picked),
      onFeatures: setFeatures,
      onHeights: () => setHeightsReady(true),
    });
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
      setHeightsReady(false);
      useApp.getState().setMarsPlace(null);
    };
  }, [ready, fail]);

  useEffect(() => globe?.setRealLight(realLight), [globe, realLight]);
  useEffect(() => globe?.setNames(names), [globe, names]);
  useEffect(() => globe?.setRelief(relief), [globe, relief]);
  useEffect(() => globe?.setRoutes(tracks ? marsRoutes(MISSIONS, tracks, shownMs) : []), [globe, tracks, shownMs]);
  useEffect(
    () => globe?.setPlace(place ? { latDeg: place.latDeg, lonDeg: place.lonDeg, feature: place.feature } : undefined),
    [globe, place],
  );

  // A place picked before the heights arrived has no elevation yet; read it once they have.
  useEffect(() => {
    if (globe && heightsReady && place && place.elevationM === undefined)
      useApp.getState().setMarsPlace(globe.describe(place.latDeg, place.lonDeg));
  }, [globe, heightsReady, place]);

  useEffect(() => {
    if (!globe || !realLight) return;
    let live = true;
    physics.marsSun(lightingUtcMs, URLS.data).then((p) => {
      if (live) globe.setSubsolar(p.latDeg, p.lonDeg);
    });
    return () => {
      live = false;
    };
  }, [globe, realLight, lightingUtcMs]);

  // The breadcrumbs and the panel ask the camera to move.
  useEffect(() => {
    if (!globe || !command) return;
    const feature = useApp.getState().marsPlace?.feature;
    if (command.type === 'feature' && feature) void globe.flyToFeature(feature, ms(1400));
    else void globe.flyHome(ms(1400));
  }, [globe, command]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    const f = findFeature(features, query);
    setNotFound(!f);
    if (!globe || !f) return;
    // The feature that was asked for, not whichever smaller one sits at its centre (Hera Patera is inside Olympus Mons).
    useApp
      .getState()
      .setMarsPlace({ ...globe.describe(f.latDeg, f.lonDeg), feature: f, featureDistKm: 0, inside: true });
    void globe.flyToFeature(f, ms(1400));
  };

  const insets = useStageInsets();
  useActiveView(globe);
  useEffect(() => {
    globe?.setInsets(insets);
  }, [globe, insets]);

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className={`stage-canvas ${revealWhen(load)}`} data-testid="mars-map" />
      <CalloutLayer
        source={load.state === 'ready' ? globe : null}
        items={
          globe
            ? [
                {
                  id: 'body',
                  // On the globe's upper edge, clear of the toolbar, while the whole globe is in view.
                  anchor: () => onOutline(globe.discOnScreen(), -38),
                  prefer: 'ne',
                  label: t('facts.heading.Mars'),
                  children: <BodyCard body="Mars" />,
                },
                ...(place
                  ? [
                      {
                        id: 'place',
                        anchor: () => globe.placeOnScreen(place.latDeg, place.lonDeg),
                        prefer: 'ne' as const,
                        tone: 'sun' as const,
                        label: t('callout.place'),
                        children: <MarsPlaceCard />,
                      },
                    ]
                  : []),
              ]
            : []
        }
      />
      <LanderPins
        host={load.state === 'ready' ? globe : null}
        missions={PINNED.Mars}
        tracks={tracks}
        atUtcMs={shownMs}
      />
      <ViewPills wide>
        <button
          type="button"
          aria-pressed={realLight}
          title={t('mars.realSunHint')}
          className={viewButton}
          onClick={() => setRealLight((v) => !v)}
        >
          {t('mars.realSun')}
        </button>
        <button type="button" aria-pressed={names} className={viewButton} onClick={() => setNames((v) => !v)}>
          {t('mars.names')}
        </button>
        <label className={`${viewButton} flex items-center gap-2`}>
          <span>{t('mars.relief')}</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={relief}
            className="w-24 accent-sun"
            onChange={(e) => setRelief(Number(e.currentTarget.value))}
          />
          <output dir="ltr" className="w-6 text-end tabular-nums">
            {t('mars.reliefValue', { n: relief })}
          </output>
        </label>
        <button type="button" className={viewButton} onClick={() => void globe?.flyHome(ms(1400))}>
          {t('mars.home')}
        </button>
        <button
          type="button"
          aria-label={t('mars.zoomIn')}
          className={viewButton}
          onClick={() => void globe?.zoomBy(0.55, ms(300))}
        >
          +
        </button>
        <button
          type="button"
          aria-label={t('mars.zoomOut')}
          className={viewButton}
          onClick={() => void globe?.zoomBy(1.8, ms(300))}
        >
          −
        </button>
      </ViewPills>
      <ViewHint>{t('mars.hint')}</ViewHint>
      <ViewStatus view="mars" load={load} />
      <search className="absolute inset-e-3 top-3">
        <form onSubmit={search} className="flex flex-col items-end gap-1">
          <input
            type="search"
            list="mars-features"
            value={query}
            aria-label={t('mars.search')}
            placeholder={t('mars.searchPlaceholder')}
            className="min-h-8 w-64 rounded-md border border-line bg-panel-raised/92 px-2.5 text-[12.5px]"
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setNotFound(false);
            }}
          />
          <datalist id="mars-features">
            {features.map((f) => (
              <option key={`${f.name}-${f.latDeg}-${f.lonDeg}`} value={f.name} />
            ))}
          </datalist>
          {notFound && (
            <p role="status" className="rounded-md bg-panel-raised/92 px-2 py-1 text-xs text-quiet">
              {t('mars.searchNone', { query })}
            </p>
          )}
        </form>
      </search>
    </section>
  );
}
