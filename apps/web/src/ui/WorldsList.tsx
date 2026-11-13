import { SOLAR_LOOK } from '@siteline/engine';
import type { SolarBodyKey } from '@siteline/physics';
import { useTranslation } from 'react-i18next';
import { distancesOf, lightTimeS, type Measure, signalDelay } from '../bodyFacts';
import { formatNumber } from '../format';
import { usePlanetsAtHourState } from '../physics';
import { useApp } from '../store';
import { panel } from './Controls';
import { PanelError } from './ViewStatus';

export const WORLDS = [
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
] as const;
export type World = (typeof WORLDS)[number];
export type Flyable = Extract<SolarBodyKey, 'earth' | 'moon' | 'mars'>;
/** The worlds that have a view of their own to fly into. */
export const FLYABLE: ReadonlySet<World> = new Set<World>(['earth', 'moon', 'mars']);

/** A world's colour in the 3D view, as CSS. */
export const worldColour = (key: World) => `#${SOLAR_LOOK[key].color.toString(16).padStart(6, '0')}`;

export interface WorldReadings {
  name: string;
  fromSun: string;
  signal: string;
}

/**
 * Each world's distance from the Sun and signal time from Earth at the hour the views are lit for, worded for the
 * screen; a dash until the planets table arrives, or for the Sun's own distance and the Earth's own signal.
 */
export function useWorldReadings(): {
  readings: (key: World) => WorldReadings;
  error?: string;
  retry: () => void;
} {
  const { t } = useTranslation();
  const { positions, error, retry } = usePlanetsAtHourState();
  const none = t('worlds.none');
  const unit = (m: Measure<string>) => t(`facts.units.${m.unit}`, { n: formatNumber(m.n, m.digits) });
  const readings = (key: World): WorldReadings => {
    const d = positions && distancesOf(key, positions);
    return {
      name: t(`bodies.${key}`),
      fromSun: !d || key === 'sun' ? none : t('worlds.au', { n: formatNumber(d.sunDistAu, key === 'earth' ? 3 : 2) }),
      signal: d?.earthDistKm == null ? none : unit(signalDelay(lightTimeS(d.earthDistKm))),
    };
  };
  return { readings, error, retry };
}

/**
 * The solar-system view's list of worlds, for phones: on a wide screen each world carries its own card in the scene
 * instead. One raised row each, the name at the start and the two readings at the end.
 */
export function WorldsList() {
  const { t } = useTranslation();
  const { readings, error, retry } = useWorldReadings();
  const commandSolar = useApp((s) => s.commandSolar);

  return (
    <section className={`${panel} lg:hidden`} data-testid="worlds">
      <h2 className="text-2xl">{t('worlds.heading')}</h2>
      {error && (
        <div className="mt-3">
          <PanelError title={t('status.panel.worlds')} reason={error} onRetry={retry} />
        </div>
      )}
      <div className="mt-3 grid grid-cols-[1fr_6rem_5rem] gap-x-3 px-2.5 text-xs text-quiet" aria-hidden="true">
        <span>{t('worlds.world')}</span>
        <span className="text-end">{t('worlds.fromSun')}</span>
        <span className="text-end">{t('worlds.signal')}</span>
      </div>
      <ul className="mt-1 flex flex-col gap-1.5">
        {WORLDS.map((key) => {
          const { name, fromSun, signal } = readings(key);
          const flyable = FLYABLE.has(key);
          const cells = (
            <>
              <span className={`flex items-center gap-2 ${flyable ? 'text-accent' : ''}`}>
                <span className="size-2 shrink-0 rounded-pill" style={{ background: worldColour(key) }} />
                {name}
              </span>
              <span className="text-end font-mono text-[13px]" dir="ltr">
                <span className="sr-only">{t('worlds.fromSun')}: </span>
                {fromSun}
              </span>
              <span className="text-end font-mono text-[13px]" dir="ltr">
                <span className="sr-only">{t('worlds.signal')}: </span>
                {signal}
              </span>
            </>
          );
          const row =
            'grid min-h-11 w-full grid-cols-[1fr_6rem_5rem] items-center gap-x-3 rounded-lg border border-line bg-panel-raised/70 px-2.5 text-start text-sm';
          return (
            <li key={key} data-testid={`world-${key}`}>
              {flyable ? (
                <button
                  type="button"
                  className={`${row} hover:border-line-hover`}
                  onClick={() => commandSolar(key as Flyable)}
                >
                  {cells}
                </button>
              ) : (
                <div className={row}>{cells}</div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-quiet">{t('worlds.note')}</p>
    </section>
  );
}
