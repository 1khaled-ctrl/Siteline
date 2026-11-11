import { findFeature, type MarsFeature, MarsView } from '@siteline/engine';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useApp } from '../store';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
const MARS_ASSETS = {
  preview: `${ASSETS}/img/mars.jpg`,
  color: `${ASSETS}/img/mars_color.jpg`,
  normal: `${ASSETS}/img/mars_normal.jpg`,
  height: `${ASSETS}/img/mars_height.png`,
  names: `${ASSETS}/data/names.json`,
};
const DEFAULT_RELIEF = 3;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ms = (n: number) => (reducedMotion() ? 0 : n);

const buttonBase = 'min-h-9 rounded-lg px-3 text-sm backdrop-blur-md';
const toggle = (on: boolean) =>
  `${buttonBase} border ${on ? 'border-accent bg-accent/20' : 'border-white/15 bg-panel/80'}`;

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

  useEffect(() => {
    if (!ref.current) return;
    const created = new MarsView(ref.current, {
      assets: MARS_ASSETS,
      onPick: (picked) => useApp.getState().setMarsPlace(picked),
      onFeatures: setFeatures,
      onHeights: () => setHeightsReady(true),
    });
    setGlobe(created);
    return () => {
      created.dispose();
      setGlobe(null);
      setHeightsReady(false);
      useApp.getState().setMarsPlace(null);
    };
  }, []);

  useEffect(() => globe?.setRealLight(realLight), [globe, realLight]);
  useEffect(() => globe?.setNames(names), [globe, names]);
  useEffect(() => globe?.setRelief(relief), [globe, relief]);
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
    useApp.getState().setMarsPlace(globe.describe(f.latDeg, f.lonDeg));
    void globe.flyToFeature(f, ms(1400));
  };

  return (
    <section className="fade-in relative min-h-[60vh] overflow-hidden rounded-xl border border-white/10 lg:min-h-0">
      <div ref={ref} className="absolute inset-0" data-testid="mars-map" />
      <p className="pointer-events-none absolute inset-s-3 top-3 max-w-md rounded-lg bg-panel/72 px-3 py-2 text-xs text-quiet backdrop-blur-md">
        {t('mars.hint')}
      </p>
      <search className="absolute inset-e-3 top-3">
        <form onSubmit={search} className="flex flex-col items-end gap-1">
          <input
            type="search"
            list="mars-features"
            value={query}
            aria-label={t('mars.search')}
            placeholder={t('mars.searchPlaceholder')}
            className="min-h-9 w-64 rounded-lg border border-white/15 bg-panel/80 px-3 text-sm backdrop-blur-md"
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
            <p role="status" className="rounded-lg bg-panel/80 px-2 py-1 text-xs text-quiet">
              {t('mars.searchNone', { query })}
            </p>
          )}
        </form>
      </search>
      <div className="absolute inset-s-3 bottom-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={realLight}
          title={t('mars.realSunHint')}
          className={toggle(realLight)}
          onClick={() => setRealLight((v) => !v)}
        >
          {t('mars.realSun')}
        </button>
        <button type="button" aria-pressed={names} className={toggle(names)} onClick={() => setNames((v) => !v)}>
          {t('mars.names')}
        </button>
        <label className={`${buttonBase} flex items-center gap-2 border border-white/15 bg-panel/80`}>
          <span>{t('mars.relief')}</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={relief}
            onChange={(e) => setRelief(Number(e.currentTarget.value))}
          />
          <output dir="ltr" className="w-6 text-end tabular-nums">
            {t('mars.reliefValue', { n: relief })}
          </output>
        </label>
      </div>
      <div className="absolute inset-e-3 bottom-3 flex flex-col gap-1">
        <button
          type="button"
          className={`${buttonBase} border border-white/15 bg-panel/80`}
          onClick={() => void globe?.flyHome(ms(1400))}
        >
          {t('mars.home')}
        </button>
        <button
          type="button"
          aria-label={t('mars.zoomIn')}
          className={`${buttonBase} border border-white/15 bg-panel/80`}
          onClick={() => void globe?.zoomBy(0.55, ms(300))}
        >
          +
        </button>
        <button
          type="button"
          aria-label={t('mars.zoomOut')}
          className={`${buttonBase} border border-white/15 bg-panel/80`}
          onClick={() => void globe?.zoomBy(1.8, ms(300))}
        >
          −
        </button>
      </div>
    </section>
  );
}
