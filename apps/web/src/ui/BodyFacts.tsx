import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import {
  BODY_CONSTANTS,
  dayLength,
  distancesOf,
  escapeSpeedKmS,
  FACT_SOURCES,
  type FactBody,
  kelvinToCelsius,
  lightTimeS,
  type Measure,
  SOLAR_CONSTANT_W_M2,
  signalDelay,
  sunlightWM2,
  surfaceGravityMS2,
  TABLE_KEY,
} from '../bodyFacts';
import { formatNumber } from '../format';
import { usePlanetsAtHour } from '../physics';
import { panel } from './Controls';

function Ext({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">
      {children}
    </a>
  );
}

/**
 * One reading in its own tile, label over value. A sentence (`text`) is set in the body face rather than mono.
 * `edge` colours the tile's start edge: gold for sunlight, blue for the link to Earth.
 */
export function StatTile({
  label,
  children,
  text,
  edge,
}: {
  label: string;
  children: ReactNode;
  text?: boolean;
  edge?: 'sun' | 'earth';
}) {
  const edgeClass = edge === 'sun' ? 'border-s-3 border-s-sun' : edge === 'earth' ? 'border-s-3 border-s-accent' : '';
  return (
    <div className={`min-w-0 rounded-lg border border-line bg-panel-raised px-2.5 py-2 ${edgeClass}`}>
      <dt className="text-xs text-quiet">{label}</dt>
      {text ? (
        <dd className="mt-0.5 text-sm" data-text>
          {children}
        </dd>
      ) : (
        <dd className="text-[17px] wrap-break-word" dir="ltr">
          {children}
        </dd>
      )}
    </div>
  );
}

/** What the Moon, the Earth or Mars is like: the facts that do not depend on where you land. */
export function BodyFacts({ body }: { body: FactBody }) {
  const { t } = useTranslation();
  // How far the body is from the Sun and the Earth at the hour the map is lit for; that moves the last two readings.
  const positions = usePlanetsAtHour();
  const distances = positions && distancesOf(TABLE_KEY[body], positions);
  const c = BODY_CONSTANTS[body];
  const unit = (m: Measure<string>) => t(`facts.units.${m.unit}`, { n: formatNumber(m.n, m.digits) });
  // A true minus sign, as in the rest of the text, rather than the hyphen the number formatter gives.
  const celsius = (kelvin: number | undefined) =>
    kelvin === undefined ? '' : formatNumber(kelvinToCelsius(kelvin), 0).replace('-', '−');
  const mbar =
    c.surfacePressureMbar === null ? '' : formatNumber(c.surfacePressureMbar, c.surfacePressureMbar < 100 ? 1 : 0);
  const sunlight = distances && sunlightWM2(SOLAR_CONSTANT_W_M2, distances.sunDistAu);
  const pending = t('facts.pending');

  return (
    <section className={panel} data-testid="body-facts">
      <h2 className="mb-2 text-2xl">{t(`facts.heading.${body}`)}</h2>
      <dl className="grid grid-cols-2 gap-2">
        <StatTile label={t('facts.gravity')}>
          {t('facts.units.gravity', { n: formatNumber(surfaceGravityMS2(c.gmKm3PerS2, c.radiusKm), 2) })}
        </StatTile>
        <StatTile label={t('facts.escape')}>
          {t('facts.units.escape', { n: formatNumber(escapeSpeedKmS(c.gmKm3PerS2, c.radiusKm), 2) })}
        </StatTile>
        <StatTile label={t('facts.rotation')}>{unit(dayLength(c.rotationH))}</StatTile>
        <StatTile label={t('facts.solarDay')}>{unit(dayLength(c.solarDayH))}</StatTile>
        <StatTile label={t('facts.sunlight')} edge="sun">
          {sunlight === undefined ? pending : t('facts.units.sunlight', { n: formatNumber(sunlight, 0) })}
        </StatTile>
        {body !== 'Earth' && (
          <StatTile label={t('facts.signal')} edge="earth">
            {distances?.earthDistKm == null ? pending : unit(signalDelay(lightTimeS(distances.earthDistKm)))}
          </StatTile>
        )}
        <StatTile label={t('facts.temperature')} text>
          {t(`facts.temp.${body}`, {
            mean: celsius(c.temperatureK.meanK),
            low: celsius(c.temperatureK.rangeK?.[0]),
            high: celsius(c.temperatureK.rangeK?.[1]),
            coldest: celsius(c.temperatureK.coldestK),
          })}
        </StatTile>
        <StatTile label={t('facts.surface')} text>
          {t(`facts.surfaceKind.${body}`, { mbar })}
        </StatTile>
      </dl>
      <p className="mt-3 text-xs text-quiet">
        <Trans
          i18nKey={`facts.sources.${body}`}
          components={{
            fact: <Ext href={FACT_SOURCES[c.factSheet][1]} />,
            gm: <Ext href={FACT_SOURCES.spiceGm[1]} />,
            paige: <Ext href={FACT_SOURCES.paige2010[1]} />,
          }}
        />
      </p>
    </section>
  );
}
