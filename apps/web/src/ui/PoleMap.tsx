import { type LayerColour, PoleView } from '@siteline/engine';
import { mapValue, type PolarMaps } from '@siteline/physics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { REGIONS } from '../regions';
import { LAYERS, type Layer, useApp } from '../store';
import { ViewHint, ViewPills, viewButton } from './ViewPills';
import { useLoad, ViewStatus } from './ViewStatus';

const EXAGGERATION = 3;
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

// Cividis-like ramp for sunlight and Earth view (colour-blind safe); one hue for shadowed ground.
const RAMP: [number, [number, number, number]][] = [
  [0, [0.0, 0.13, 0.3]],
  [0.5, [0.49, 0.49, 0.47]],
  [1, [1.0, 0.91, 0.3]],
];
function ramp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v));
  const i = x < 0.5 ? 0 : 1;
  const f = (x - RAMP[i][0]) / (RAMP[i + 1][0] - RAMP[i][0]);
  const a = RAMP[i][1];
  const b = RAMP[i + 1][1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function colourFor(layer: Layer, maps: PolarMaps): LayerColour | null {
  if (layer === 'none') return null;
  if (layer === 'shadow') {
    const half = (maps.n - 1) / 2;
    return (x, y) => {
      const r = Math.round(half - y / maps.pixM);
      const c = Math.round(x / maps.pixM + half);
      if (r < 0 || c < 0 || r >= maps.n || c >= maps.n) return null;
      return maps.shadowed[r * maps.n + c] ? [0.25, 0.5, 1] : null;
    };
  }
  const plane = layer === 'sun' ? maps.sunPct : maps.earthPct;
  // Long-term sunlight tops out near 92 % at the best ridges, so stretch the ramp to that.
  const scale = layer === 'sun' ? 92 : 100;
  return (x, y) => {
    const v = mapValue(maps, plane, x, y);
    return Number.isNaN(v) ? null : ramp(v / scale);
  };
}

export function PoleMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<PoleView | null>(null);
  const [maps, setMaps] = useState<PolarMaps>();
  const load = useLoad();
  const { ready, fail } = load;
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const focusSeq = useApp((s) => s.focusSeq);
  const layer = useApp((s) => s.layer);
  const pins = useApp((s) => s.pins);
  const lightingUtcMs = useLightingUtcMs();

  useEffect(() => {
    let live = true;
    let created: PoleView | undefined;
    physics.dem(URLS.terrain).then(
      (dem) => {
        if (!live || !ref.current) return;
        created = new PoleView(ref.current, dem, {
          exaggeration: EXAGGERATION,
          regions: REGIONS,
          onPick: (lat, lon) => useApp.getState().set({ latDeg: round4(lat), lonDeg: round4(lon) }),
        });
        setView(created);
        ready();
      },
      (e: unknown) => {
        if (live) fail(e);
      },
    );
    physics.maps(URLS.maps).then(
      (m) => {
        if (live) setMaps(m);
      },
      () => {},
    );
    return () => {
      live = false;
      created?.dispose();
      setView(null);
    };
  }, [ready, fail]);

  useEffect(() => {
    view?.setSite(latDeg, lonDeg);
  }, [view, latDeg, lonDeg]);

  useEffect(() => {
    view?.setPins(pins);
  }, [view, pins]);

  useEffect(() => {
    if (view && focusSeq > 0) {
      const { latDeg: lat, lonDeg: lon } = useApp.getState();
      view.focus(lat, lon);
    }
  }, [view, focusSeq]);

  useEffect(() => {
    if (!view) return;
    view.setLayer(maps ? colourFor(layer, maps) : null);
  }, [view, maps, layer]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    physics.sunKm(lightingUtcMs, URLS.data).then((sun) => {
      if (live) view.setSun(sun);
    });
    return () => {
      live = false;
    };
  }, [view, lightingUtcMs]);

  return (
    <section className="fade-in absolute inset-0 overflow-hidden">
      <div ref={ref} className="absolute inset-0" data-testid="pole-map" />
      <ViewPills
        below={
          layer !== 'none' && (
            <p className="w-60 rounded-lg border border-line bg-panel/92 px-2.5 py-2 text-xs text-quiet">
              {t(`layers.${layer}Legend`)}
            </p>
          )
        }
      >
        <fieldset aria-label={t('layers.heading')} className="flex flex-wrap gap-1.5">
          {LAYERS.map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={layer === l}
              disabled={l !== 'none' && !maps}
              className={`${viewButton} disabled:opacity-50`}
              onClick={() => useApp.getState().set({ layer: l })}
            >
              {t(`layers.${l}`)}
            </button>
          ))}
        </fieldset>
      </ViewPills>
      <ViewHint>{t('map.hint', { exag: EXAGGERATION })}</ViewHint>
      <ViewStatus view="pole" load={load} />
      <button
        type="button"
        onClick={() => useApp.getState().set({ view: 'globe' })}
        className={`${viewButton} absolute inset-e-3 top-3`}
      >
        {t('map.backToGlobe')}
      </button>
    </section>
  );
}
