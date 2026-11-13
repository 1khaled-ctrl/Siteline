import {
  type ContinentKey,
  type EarthAssets,
  type EarthCountry,
  type EarthStyle,
  EarthView,
  type OceanKey,
} from '@siteline/engine';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useStageInsets } from '../stage';
import { useApp } from '../store';
import { CalloutLayer } from './Callouts';
import { BodyCard, onOutline } from './SceneCards';
import { ViewHint, ViewPills, viewButton } from './ViewPills';
import { revealWhen, useLoad, ViewStatus } from './ViewStatus';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
const EARTH_ASSETS: EarthAssets = {
  map: `${ASSETS}/img/earth_map.jpg`,
  satellite: `${ASSETS}/img/earth.jpg`,
  night: `${ASSETS}/img/earth_night.jpg`,
  ids: `${ASSETS}/img/earth_ids.png`,
  countries: `${ASSETS}/data/earth.json`,
  detail: `${ASSETS}/data/earth10.json`,
};
const CONTINENTS: ContinentKey[] = [
  'africa',
  'europe',
  'asia',
  'northAmerica',
  'southAmerica',
  'oceania',
  'antarctica',
];
const OCEANS: OceanKey[] = ['pacific', 'atlantic', 'indian', 'arctic', 'southern'];
const STYLES: { id: EarthStyle; label: string }[] = [
  { id: 'map', label: 'earth.styleMap' },
  { id: 'satellite', label: 'earth.styleSatellite' },
  { id: 'night', label: 'earth.styleNight' },
];
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ms = (n: number) => (reducedMotion() ? 0 : n);

/** An exact name first, then names that start with the text, then names that contain it. */
export function findCountry(countries: readonly EarthCountry[], query: string): EarthCountry | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return (
    countries.find((c) => c.name.toLowerCase() === q) ??
    countries.find((c) => c.name.toLowerCase().startsWith(q)) ??
    countries.find((c) => c.name.toLowerCase().includes(q))
  );
}

export function EarthMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [globe, setGlobe] = useState<EarthView | null>(null);
  const [countries, setCountries] = useState<readonly EarthCountry[]>([]);
  const [style, setStyle] = useState<EarthStyle>('map');
  const [realLight, setRealLight] = useState(false);
  const [query, setQuery] = useState('');
  const [notFound, setNotFound] = useState(false);
  const place = useApp((s) => s.earthPlace);
  const command = useApp((s) => s.earthCommand);
  const lightingUtcMs = useLightingUtcMs();
  const load = useLoad();
  const { ready, fail } = load;
  const names = useMemo(
    () =>
      Object.fromEntries([
        ...CONTINENTS.map((k) => [k, t(`earth.continents.${k}`)]),
        ...OCEANS.map((k) => [k, t(`earth.oceans.${k}`)]),
      ]) as Record<ContinentKey | OceanKey, string>,
    [t],
  );

  useEffect(() => {
    if (!ref.current) return;
    const created = new EarthView(ref.current, {
      assets: EARTH_ASSETS,
      names,
      onPick: (picked) => useApp.getState().setEarthPlace(picked),
      onCountries: setCountries,
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
      useApp.getState().setEarthPlace(null);
    };
  }, [names, ready, fail]);

  useEffect(() => globe?.setStyle(style), [globe, style]);
  useEffect(() => globe?.setRealLight(realLight), [globe, realLight]);
  useEffect(
    () =>
      globe?.setPlace(place ? { latDeg: place.latDeg, lonDeg: place.lonDeg, countryId: place.country?.id } : undefined),
    [globe, place],
  );

  useEffect(() => {
    if (!globe || !realLight) return;
    let live = true;
    physics.earthSun(lightingUtcMs, URLS.data).then((p) => {
      if (live) globe.setSubsolar(p.latDeg, p.lonDeg);
    });
    return () => {
      live = false;
    };
  }, [globe, realLight, lightingUtcMs]);

  // The breadcrumbs ask the camera to move.
  useEffect(() => {
    if (!globe || !command) return;
    if (command.type === 'home') void globe.flyHome(ms(1400));
    else if (useApp.getState().earthPlace?.country)
      void globe.flyToCountry(useApp.getState().earthPlace?.country as EarthCountry, ms(1400));
  }, [globe, command]);

  const search = (e: FormEvent) => {
    e.preventDefault();
    const c = findCountry(countries, query);
    setNotFound(!c);
    if (!globe || !c) return;
    useApp.getState().setEarthPlace({ latDeg: c.latDeg, lonDeg: c.lonDeg, country: c });
    void globe.flyToCountry(c, ms(1400));
  };

  const insets = useStageInsets();
  useEffect(() => {
    globe?.setInsets(insets);
  }, [globe, insets]);

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className={`stage-canvas ${revealWhen(load)}`} data-testid="earth-map" />
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
                  label: t('facts.heading.Earth'),
                  children: <BodyCard body="Earth" />,
                },
              ]
            : []
        }
      />
      <ViewPills wide>
        <fieldset className="flex gap-1.5">
          <legend className="sr-only">{t('earth.style')}</legend>
          {STYLES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={style === s.id}
              className={viewButton}
              onClick={() => setStyle(s.id)}
            >
              {t(s.label)}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          aria-pressed={realLight}
          title={t('earth.dayNightHint')}
          className={viewButton}
          onClick={() => setRealLight((v) => !v)}
        >
          {t('earth.dayNight')}
        </button>
        <button type="button" className={viewButton} onClick={() => void globe?.flyHome(ms(1400))}>
          {t('earth.home')}
        </button>
        <button
          type="button"
          aria-label={t('earth.zoomIn')}
          className={viewButton}
          onClick={() => void globe?.zoomBy(0.55, ms(300))}
        >
          +
        </button>
        <button
          type="button"
          aria-label={t('earth.zoomOut')}
          className={viewButton}
          onClick={() => void globe?.zoomBy(1.8, ms(300))}
        >
          −
        </button>
      </ViewPills>
      <ViewHint>{t('earth.hint')}</ViewHint>
      <ViewStatus view="earth" load={load} />
      <search className="absolute inset-e-3 top-3">
        <form onSubmit={search} className="flex flex-col items-end gap-1">
          <input
            type="search"
            list="earth-countries"
            value={query}
            aria-label={t('earth.search')}
            placeholder={t('earth.searchPlaceholder')}
            className="min-h-8 w-52 rounded-md border border-line bg-panel-raised/92 px-2.5 text-[12.5px]"
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setNotFound(false);
            }}
          />
          <datalist id="earth-countries">
            {countries.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          {notFound && (
            <p role="status" className="rounded-md bg-panel-raised/92 px-2 py-1 text-xs text-quiet">
              {t('earth.searchNone', { query })}
            </p>
          )}
        </form>
      </search>
    </section>
  );
}
