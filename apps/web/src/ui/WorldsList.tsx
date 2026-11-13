import { SOLAR_LOOK } from '@siteline/engine';
import type { SolarBodyKey } from '@siteline/physics';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { distancesOf, lightTimeS, type Measure, signalDelay } from '../bodyFacts';
import { formatNumber } from '../format';
import { usePlanetsAtHourState } from '../physics';
import { useApp } from '../store';
import { panel } from './Controls';
import { PanelError } from './ViewStatus';

/** The worlds on the ring, in order from the Sun; the Sun itself is the ring's centre. */
const RING = ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
type World = (typeof RING)[number] | 'sun';
type Flyable = Extract<SolarBodyKey, 'earth' | 'moon' | 'mars'>;
/** The worlds that have a view of their own to fly into. */
const FLYABLE = new Set<string>(['earth', 'moon', 'mars']);

/** The ring's radius, in percent of the square's width. */
const RING_PCT = 40;

const cssColour = (key: World) => `#${SOLAR_LOOK[key].color.toString(16).padStart(6, '0')}`;
/** A ball's width in px, from the 3D view's own sizes (which are for looking at, not to scale). */
const ballPx = (key: World) => Math.round(10 + Math.min(SOLAR_LOOK[key].size, 1.8) * 9);

/** A world as a small lit ball in the 3D view's colour. */
function Ball({ world, px = ballPx(world), lit }: { world: World; px?: number; lit?: boolean }) {
  const colour = cssColour(world);
  return (
    <span
      className="block rounded-pill transition-shadow duration-300"
      style={{
        width: px,
        height: px,
        background:
          world === 'sun'
            ? `radial-gradient(circle, #fff 0%, ${colour} 45%, #f08a1c 100%)`
            : `radial-gradient(circle at 32% 30%, #fff 0%, ${colour} 38%, #05070d 115%)`,
        boxShadow:
          world === 'sun'
            ? `0 0 22px 4px ${colour}aa`
            : lit
              ? '0 0 0 2px var(--color-panel-sunk), 0 0 0 3.5px var(--color-accent), 0 0 16px 3px var(--color-accent)'
              : `0 0 10px 0 ${colour}66`,
      }}
    />
  );
}

/**
 * The solar-system view's panel: the worlds circle the Sun on one slow ring, and the one you pick shows its distance
 * from the Sun and its signal time from Earth in the middle. The ring is a menu, evenly spaced, not a map.
 */
export function WorldsList() {
  const { t } = useTranslation();
  const { positions, error, retry } = usePlanetsAtHourState();
  const commandSolar = useApp((s) => s.commandSolar);
  const [picked, setPicked] = useState<World | null>(null);
  const [pointed, setPointed] = useState<World | null>(null);
  const shown: World = pointed ?? picked ?? 'sun';

  const none = t('worlds.none');
  const unit = (m: Measure<string>) => t(`facts.units.${m.unit}`, { n: formatNumber(m.n, m.digits) });
  const d = positions && distancesOf(shown, positions);
  const fromSun =
    !d || shown === 'sun' ? none : t('worlds.au', { n: formatNumber(d.sunDistAu, shown === 'earth' ? 3 : 2) });
  const signal = d?.earthDistKm == null ? none : unit(signalDelay(lightTimeS(d.earthDistKm)));
  const node = (key: World) => ({
    'data-testid': `world-${key}`,
    'aria-pressed': picked === key,
    onPointerEnter: () => setPointed(key),
    onPointerLeave: () => setPointed(null),
    onFocus: () => setPointed(key),
    onBlur: () => setPointed(null),
    onClick: () => setPicked(picked === key ? null : key),
  });

  return (
    <section className={panel} data-testid="worlds">
      <h2 className="text-2xl">{t('worlds.heading')}</h2>
      {error && (
        <div className="mt-3">
          <PanelError title={t('status.panel.worlds')} reason={error} onRetry={retry} />
        </div>
      )}
      {/* A dial, so it never mirrors; its left and top are the picture's own. */}
      <fieldset
        className="orbit relative mx-auto mt-2 aspect-square w-full min-w-0 max-w-[380px]"
        dir="ltr"
        aria-label={t('worlds.orbits')}
        data-paused={picked ? '' : undefined}
      >
        <div className="absolute inset-[10%] rounded-pill border border-line-hover/70" aria-hidden="true" />
        <div className="absolute inset-[22%] rounded-pill border border-dashed border-line/80" aria-hidden="true" />
        <div className="orbit-spin absolute inset-0">
          {RING.map((key, i) => {
            const angle = (i / RING.length) * 2 * Math.PI - Math.PI / 2;
            const on = shown === key;
            return (
              <div
                key={key}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${50 + RING_PCT * Math.cos(angle)}%`, top: `${50 + RING_PCT * Math.sin(angle)}%` }}
              >
                <button
                  type="button"
                  {...node(key)}
                  className={`orbit-unspin flex size-14 flex-col items-center justify-center gap-1 rounded-pill transition-transform duration-300 ${on ? 'scale-125' : ''}`}
                >
                  <Ball world={key} lit={on || picked === key} />
                  <span
                    className={`font-display text-[10px] leading-none tracking-wider uppercase ${
                      on ? 'text-ink' : FLYABLE.has(key) ? 'text-accent' : 'text-quiet'
                    }`}
                  >
                    {t(`bodies.${key}`)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        {/* The middle: the Sun until a world is picked, then that world's two readings. */}
        <div className="absolute inset-[24%] flex flex-col items-center justify-center text-center" aria-live="polite">
          {shown === 'sun' ? (
            <button type="button" {...node('sun')} className="relative grid size-11 place-items-center rounded-pill">
              <span className="absolute size-9 animate-ping rounded-pill border border-sun/40 [animation-duration:3s]" />
              <Ball world="sun" px={26} />
            </button>
          ) : (
            <Ball world={shown} px={18} />
          )}
          <p className="mt-1.5 font-display text-xl leading-tight">{t(`bodies.${shown}`)}</p>
          <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-2 text-start text-[11px] leading-snug">
            <dt className="text-quiet">{t('worlds.fromSun')}</dt>
            <dd className="text-end text-xs">{fromSun}</dd>
            <dt className="text-quiet">{t('worlds.signalShort')}</dt>
            <dd className="text-end text-xs">{signal}</dd>
          </dl>
          {FLYABLE.has(shown) && picked === shown ? (
            <button
              type="button"
              data-testid="world-fly"
              className="mt-2 min-h-8 rounded-pill bg-accent px-3.5 text-xs font-semibold text-space hover:brightness-110"
              onClick={() => commandSolar(shown as Flyable)}
            >
              {t('worlds.fly')}
            </button>
          ) : (
            <p className="mt-1.5 min-h-4 text-[10px] text-quiet">
              {FLYABLE.has(shown) ? t('worlds.pickToFly') : shown === 'sun' ? t('worlds.pick') : ''}
            </p>
          )}
        </div>
      </fieldset>
      <p className="mt-2 text-xs text-quiet">{t('worlds.note')}</p>
    </section>
  );
}
