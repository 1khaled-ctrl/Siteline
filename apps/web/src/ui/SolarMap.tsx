import { type SolarLabelKey, SolarView } from '@siteline/engine';
import type { SolarBodyKey } from '@siteline/physics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { type MoonView, useApp } from '../store';

/** Bodies with a view to fly into. Mars joins when its view is built. */
const NAVIGABLE: ReadonlySet<SolarBodyKey> = new Set(['earth', 'moon']);
const VIEW_OF: Partial<Record<SolarBodyKey, MoonView>> = { earth: 'earth', moon: 'globe' };
const KEYS: SolarLabelKey[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SolarMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SolarView | null>(null);
  const [error, setError] = useState<string>();
  const [flying, setFlying] = useState(false);
  const lightingUtcMs = useLightingUtcMs();

  useEffect(() => {
    if (!ref.current) return;
    const labels = Object.fromEntries(KEYS.map((k) => [k, t(`bodies.${k}`)])) as Record<SolarLabelKey, string>;
    const created = new SolarView(ref.current, {
      labels,
      navigable: NAVIGABLE,
      onSelect: (body) => {
        setFlying(true);
        void created.flyTo(body, reducedMotion() ? 0 : 1800).then(() => {
          const next = VIEW_OF[body];
          if (next) useApp.getState().set({ view: next });
        });
      },
    });
    setView(created);
    physics.planetOrbits(URLS.data).then(
      (orbits) => created.setOrbits(orbits),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      created.dispose();
      setView(null);
    };
  }, [t]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    physics.planetsAt(lightingUtcMs, URLS.data).then(
      (positionsKm) => {
        if (live) view.setSnapshot({ positionsKm });
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [view, lightingUtcMs]);

  return (
    <section className="fade-in relative min-h-[60vh] overflow-hidden rounded-xl border border-white/10 lg:min-h-0">
      <div ref={ref} className="absolute inset-0" data-testid="solar-map" />
      <p className="pointer-events-none absolute inset-s-3 top-3 max-w-md rounded-lg bg-panel/72 px-3 py-2 text-xs text-quiet backdrop-blur-md">
        {error ? t('solar.error', { message: error }) : flying ? t('solar.flying') : t('solar.hint')}
      </p>
    </section>
  );
}
