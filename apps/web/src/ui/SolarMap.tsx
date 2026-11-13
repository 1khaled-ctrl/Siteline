import { type SolarLabelKey, SolarView } from '@siteline/engine';
import type { SolarBodyKey } from '@siteline/physics';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { INTRO_MODE, RING_PX, track, useBoot } from '../boot';
import { findLander } from '../landers';
import { followLighting, physics, URLS } from '../physics';
import { useActiveView, useStage, useStageInsets, useWide } from '../stage';
import { cameFrom, type MoonView, useApp } from '../store';
import { type Callout, CalloutLayer } from './Callouts';
import { ViewHint } from './ViewPills';
import { useLoad, ViewStatus } from './ViewStatus';
import { FLYABLE, type Flyable, useWorldReadings, type World, type WorldReadings, worldColour } from './WorldsList';

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

/** The world whose own view you have just left for this one, if you have: the solar system opens by pulling back from it. */
function leftWorld(): SolarBodyKey | undefined {
  const from = cameFrom();
  if (from === 'globe' || from === 'pole') return 'moon';
  if (from === 'earth' || from === 'mars') return from;
  if (from !== 'site') return undefined;
  const body = findLander(useApp.getState().missionId ?? '')?.body;
  return body === 'Mars' ? 'mars' : body === 'Moon' ? 'moon' : undefined;
}

/** Fly the camera to a body, then open that body's own view if it has one. */
function fly(target: SolarView, body: SolarBodyKey, setFlying: (on: boolean) => void) {
  setFlying(true);
  void target.flyTo(body, reducedMotion() ? 0 : 1800).then(() => {
    const next = VIEW_OF[body];
    if (next) useApp.getState().set({ view: next });
  });
}

/** A world's card in the scene: its name and colour, its two readings, and a way in if it has a view of its own. */
function WorldCard({ world, r }: { world: World; r: WorldReadings }) {
  const { t } = useTranslation();
  const flyable = FLYABLE.has(world);
  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-pill"
          style={{ background: worldColour(world), boxShadow: `0 0 8px ${worldColour(world)}` }}
        />
        <h3 className="font-display text-[15px] leading-none">{r.name}</h3>
        {flyable && (
          <button
            type="button"
            className="callout-go ms-auto"
            aria-label={t('callout.flyTo', { name: r.name })}
            onClick={() => useApp.getState().commandSolar(world as Flyable)}
          >
            {t('callout.fly')}
          </button>
        )}
      </div>
      <dl className="callout-readings mt-2">
        <dt>{t('worlds.fromSun')}</dt>
        <dd>{r.fromSun}</dd>
        <dt>{t('worlds.signal')}</dt>
        <dd>{r.signal}</dd>
      </dl>
      <button type="button" className="callout-source" onClick={() => useApp.getState().setSources('spice-de440s')}>
        {t('callout.sourceDe440')}
      </button>
    </>
  );
}

export function SolarMap() {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SolarView | null>(null);
  const load = useLoad();
  const { ready, fail } = load;
  const [flying, setFlying] = useState(false);
  // Back from a world's own view, the camera pulls back out from that world first; the cards wait for it to finish.
  const [arriveFrom] = useState(leftWorld);
  const [arriving, setArriving] = useState(arriveFrom !== undefined);
  const moving = flying || arriving;
  const command = useApp((s) => s.solarCommand);
  // A flight asked for before this view opened is old news: only later asks from the Worlds list count.
  const handled = useRef(command?.id ?? 0);
  // The worlds that carry a card in the scene: the three you can fly into, plus the one you point at or click.
  const [hovered, setHovered] = useState<SolarBodyKey | null>(null);
  const [picked, setPicked] = useState<SolarBodyKey | null>(null);
  const { readings } = useWorldReadings();

  useEffect(() => {
    if (!ref.current) return;
    const labels = Object.fromEntries(KEYS.map((k) => [k, t(`bodies.${k}`)])) as Record<SolarLabelKey, string>;
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const created: SolarView = new SolarView(ref.current, {
      labels,
      navigable: NAVIGABLE,
      textures: TEXTURES,
      onSelect: (body) => fly(created, body, setFlying),
      onHover: (body) => {
        clearTimeout(leaving);
        if (body) {
          setHovered(body);
          return;
        }
        // Give the pointer a moment to reach the card, and keep the card while it is being read.
        const clear = () => {
          if (document.documentElement.dataset.reading !== undefined) leaving = setTimeout(clear, 300);
          else setHovered(null);
        };
        leaving = setTimeout(clear, 450);
      },
      onPoint: (body) => setPicked((p) => (p === body ? null : body)),
      // The opening holds the camera over the Sun and flies it out from there.
      introRingPx: INTRO_MODE === 'cinematic' && !useBoot.getState().opened ? RING_PX : undefined,
      arriveFrom,
      onArrive: () => setArriving(false),
    });
    setView(created);
    useStage.getState().setSolar(created);
    track('imagery', created.texturesReady());
    track('orbits', physics.planetOrbits(URLS.data)).then((orbits) => created.setOrbits(orbits), fail);
    return () => {
      clearTimeout(leaving);
      if (useStage.getState().solar === created) useStage.getState().setSolar(null);
      created.dispose();
      setView(null);
    };
  }, [t, fail, arriveFrom]);

  useEffect(() => {
    if (!view || !command || command.id <= handled.current) return;
    handled.current = command.id;
    fly(view, command.body, setFlying);
  }, [view, command]);

  // The planets follow the store directly, so the time-lapse does not re-render this view on every frame.
  useEffect(() => {
    if (!view) return;
    return followLighting(
      (tUtcMs) => track('positions', physics.planetsAt(tUtcMs, URLS.data)),
      (positionsKm) => {
        view.setSnapshot({ positionsKm });
        ready();
      },
      fail,
    );
  }, [view, ready, fail]);

  const insets = useStageInsets();
  useActiveView(view);
  useEffect(() => {
    view?.setInsets(insets);
  }, [view, insets]);

  const wide = useWide();
  const carded = useMemo(
    () => [...new Set<World>(['earth', 'moon', 'mars', ...(picked ? [picked] : []), ...(hovered ? [hovered] : [])])],
    [picked, hovered],
  );
  // A world with a card does not need its name chip as well.
  useEffect(() => {
    view?.setHiddenLabels(new Set(wide && !moving ? carded : []));
  }, [view, carded, wide, moving]);
  const callouts: Callout[] =
    view && !moving
      ? carded.map((world) => ({
          id: world,
          anchor: () => view.projectBody(world),
          prefer: world === 'moon' ? 'nw' : world === 'mars' ? 'se' : world === 'earth' ? 'sw' : 'ne',
          tone: FLYABLE.has(world) ? 'accent' : 'sun',
          label: readings(world).name,
          children: <WorldCard world={world} r={readings(world)} />,
        }))
      : [];

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className="stage-canvas" data-testid="solar-map" />
      <CalloutLayer source={view} items={callouts} />
      <ViewHint>{flying ? t('solar.flying') : t('solar.hint')}</ViewHint>
      <ViewStatus view="solar" load={load} />
    </section>
  );
}
