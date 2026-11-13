import { type SolarLabelKey, SolarView } from '@siteline/engine';
import type { SolarBodyKey } from '@siteline/physics';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INTRO_MODE, RING_PX, track, useBoot } from '../boot';
import { physics, URLS, useLightingUtcMs } from '../physics';
import { useStage, useStageInsets } from '../stage';
import { type MoonView, useApp } from '../store';
import { ViewHint } from './ViewPills';
import { useLoad, ViewStatus } from './ViewStatus';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
/** The same colour maps the Earth, Moon and Mars views use; the other planets have none, so stay a flat colour. */
const TEXTURES: Partial<Record<SolarBodyKey, string>> = {
  earth: `${ASSETS}/img/earth.jpg`,
  moon: `${ASSETS}/img/moon.jpg`,
  mars: `${ASSETS}/img/mars_color.jpg`,
};

/** Bodies with a view to fly into. */
const NAVIGABLE: ReadonlySet<SolarBodyKey> = new Set(['earth', 'mars', 'moon']);
const VIEW_OF: Partial<Record<SolarBodyKey, MoonView>> = { earth: 'earth', mars: 'mars', moon: 'globe' };
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

/** Fly the camera to a body, then open that body's own view if it has one. */
function fly(target: SolarView, body: SolarBodyKey, setFlying: (on: boolean) => void) {
  setFlying(true);
  void target.flyTo(body, reducedMotion() ? 0 : 1800).then(() => {
    const next = VIEW_OF[body];
    if (next) useApp.getState().set({ view: next });
  });
}

export function SolarMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SolarView | null>(null);
  const load = useLoad();
  const { ready, fail } = load;
  const [flying, setFlying] = useState(false);
  const lightingUtcMs = useLightingUtcMs();
  const command = useApp((s) => s.solarCommand);
  // A flight asked for before this view opened is old news: only later asks from the Worlds list count.
  const handled = useRef(command?.id ?? 0);

  useEffect(() => {
    if (!ref.current) return;
    const labels = Object.fromEntries(KEYS.map((k) => [k, t(`bodies.${k}`)])) as Record<SolarLabelKey, string>;
    const created: SolarView = new SolarView(ref.current, {
      labels,
      navigable: NAVIGABLE,
      textures: TEXTURES,
      onSelect: (body) => fly(created, body, setFlying),
      // The opening holds the camera over the Sun and flies it out from there.
      introRingPx: INTRO_MODE === 'cinematic' && !useBoot.getState().opened ? RING_PX : undefined,
    });
    setView(created);
    useStage.getState().setSolar(created);
    track('imagery', created.texturesReady());
    track('orbits', physics.planetOrbits(URLS.data)).then((orbits) => created.setOrbits(orbits), fail);
    return () => {
      if (useStage.getState().solar === created) useStage.getState().setSolar(null);
      created.dispose();
      setView(null);
    };
  }, [t, fail]);

  useEffect(() => {
    if (!view || !command || command.id <= handled.current) return;
    handled.current = command.id;
    fly(view, command.body, setFlying);
  }, [view, command]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    track('positions', physics.planetsAt(lightingUtcMs, URLS.data)).then(
      (positionsKm) => {
        if (!live) return;
        view.setSnapshot({ positionsKm });
        ready();
      },
      (e: unknown) => {
        if (live) fail(e);
      },
    );
    return () => {
      live = false;
    };
  }, [view, lightingUtcMs, ready, fail]);

  const insets = useStageInsets();
  useEffect(() => {
    view?.setInsets(insets);
  }, [view, insets]);

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className="stage-canvas" data-testid="solar-map" />
      <ViewHint>{flying ? t('solar.flying') : t('solar.hint')}</ViewHint>
      <ViewStatus view="solar" load={load} />
    </section>
  );
}
