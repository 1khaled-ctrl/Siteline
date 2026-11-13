import type { SolarBodyKey } from '@siteline/physics';
import { useTranslation } from 'react-i18next';
import { distancesOf, lightTimeS, type Measure, signalDelay } from '../bodyFacts';
import { formatNumber } from '../format';
import { usePlanetsAtHourState } from '../physics';
import { useApp } from '../store';
import { panel } from './Controls';
import { PanelError } from './ViewStatus';

const WORLDS = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
/** The worlds that have a view of their own to fly into. */
const FLYABLE = new Set<string>(['earth', 'moon', 'mars']);

/** The solar-system view's panel: every world, how far it is from the Sun and how long a signal takes from Earth. */
export function WorldsList() {
  const { t } = useTranslation();
  const { positions, error, retry } = usePlanetsAtHourState();
  const commandSolar = useApp((s) => s.commandSolar);
  const none = t('worlds.none');
  const unit = (m: Measure<string>) => t(`facts.units.${m.unit}`, { n: formatNumber(m.n, m.digits) });

  return (
    <section className={panel} data-testid="worlds">
      <h2 className="text-2xl">{t('worlds.heading')}</h2>
      {error && (
        <div className="mt-3">
          <PanelError title={t('status.panel.worlds')} reason={error} onRetry={retry} />
        </div>
      )}
      {/* The demo's list of worlds: one raised row each, the name at the start and the two readings at the end. */}
      <div className="mt-3 grid grid-cols-[1fr_6rem_5rem] gap-x-3 px-2.5 text-xs text-quiet" aria-hidden="true">
        <span>{t('worlds.world')}</span>
        <span className="text-end">{t('worlds.fromSun')}</span>
        <span className="text-end">{t('worlds.signal')}</span>
      </div>
      <ul className="mt-1 flex flex-col gap-1.5">
        {WORLDS.map((key) => {
          const d = positions && distancesOf(key, positions);
          const name = t(`bodies.${key}`);
          const fromSun =
            !d || key === 'sun' ? none : t('worlds.au', { n: formatNumber(d.sunDistAu, key === 'earth' ? 3 : 2) });
          const signal = d?.earthDistKm == null ? none : unit(signalDelay(lightTimeS(d.earthDistKm)));
          const cells = (
            <>
              <span className={FLYABLE.has(key) ? 'text-accent' : undefined}>{name}</span>
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
            'grid min-h-10 w-full grid-cols-[1fr_6rem_5rem] items-center gap-x-3 rounded-lg border border-line bg-panel-raised px-2.5 text-start text-sm';
          return (
            <li key={key} data-testid={`world-${key}`}>
              {FLYABLE.has(key) ? (
                <button
                  type="button"
                  className={`${row} hover:border-line-hover`}
                  onClick={() => commandSolar(key as Extract<SolarBodyKey, 'earth' | 'moon' | 'mars'>)}
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
