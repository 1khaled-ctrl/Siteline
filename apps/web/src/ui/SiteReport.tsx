import type { Reason, StayResult } from '@siteline/contracts';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber, formatUtc } from '../format';
import { useStay } from '../physics';
import { MAX_PINS, samePin, useApp } from '../store';
import { StatTile } from './BodyFacts';
import { Checks } from './Checks';
import { panel, smallButton } from './Controls';
import { Timeline } from './Timeline';

type Check = 'yes' | 'no' | 'unknown';

/** The verdict's box and the check chips, tinted like the demo's pass and fail boxes. */
const VERDICT_BOX = {
  pass: 'border-pass/60 bg-pass/8',
  fail: 'border-fail/60 bg-fail/7',
  undecided: 'border-warn/60 bg-warn/8',
} as const;
const CHIP: Record<Check, string> = {
  yes: 'border-pass/55 bg-pass/10 text-pass',
  no: 'border-fail/55 bg-fail/10 text-fail',
  unknown: 'border-warn/55 bg-warn/10 text-warn',
};
const STYLE: Record<Check, { icon: string; color: string }> = {
  yes: { icon: '✓', color: 'text-pass' },
  no: { icon: '✗', color: 'text-fail' },
  unknown: { icon: '?', color: 'text-warn' },
};

function checks(r: StayResult) {
  const has = (code: Reason['code']) => r.reasons.some((x) => x.code === code);
  const noEphemeris = r.reasons.some((x) => x.code === 'NO_DATA' && x.detail.missing === 'ephemeris');
  const light = (code: Reason['code']): Check => (noEphemeris ? 'unknown' : has(code) ? 'no' : 'yes');
  return {
    sun: light('SUN_BELOW_HORIZON'),
    earth: light('EARTH_BELOW_HORIZON'),
    slope: (Number.isFinite(r.slope100mDeg) ? (has('SLOPE_TOO_STEEP') ? 'no' : 'yes') : 'unknown') as Check,
    zone: (has('OUTSIDE_ZONE') ? 'no' : 'yes') as Check,
  };
}

function ReasonLine({ reason }: { reason: Reason }) {
  const key = reason.code === 'NO_DATA' ? `reason.NO_DATA_${reason.detail.missing}` : `reason.${reason.code}`;
  const values = {
    at: reason.atUtc ? formatUtc(reason.atUtc) : '',
    slope: typeof reason.detail.slope100mDeg === 'number' ? formatNumber(reason.detail.slope100mDeg) : '',
  };
  return (
    <li>
      <Trans i18nKey={key} values={values} components={{ d: <span /> }} />
    </li>
  );
}

export function SiteReport() {
  const { t } = useTranslation();
  const { query, result, terrain, terrainError, longTerm, error, loading } = useStay();
  const pins = useApp((s) => s.pins);
  const pinned = query ? pins.some((p) => samePin(p, query.site)) : false;

  if (error) return <section className={panel}>{t('report.error', { message: error })}</section>;
  if (!result || !query) return <section className={panel}>{t('report.loading')}</section>;

  const c = checks(result);
  const all = Object.values(c);
  const verdict = all.includes('no') ? 'fail' : all.includes('unknown') ? 'undecided' : 'pass';
  const verdictStyle = STYLE[verdict === 'pass' ? 'yes' : verdict === 'fail' ? 'no' : 'unknown'];
  const events = [
    ['sunset', result.nextSunsetUtc],
    ['sunrise', result.nextSunriseUtc],
    ['earthset', result.nextEarthsetUtc],
    ['earthrise', result.nextEarthriseUtc],
  ] as const;
  const pct = (v: number) => (Number.isFinite(v) ? `${formatNumber(v)}%` : '—');
  const slopeText = terrain ? t('report.needsFinerTerrain') : t('report.noTerrain');

  return (
    <section className={`${panel} flex flex-col gap-4`} aria-busy={loading}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl">{t('report.heading')}</h2>
        <span className="text-sm text-quiet">{t('report.landing', { date: formatUtc(query.landingUtc) })}</span>
      </div>

      <div className={`rounded-lg border p-3 ${VERDICT_BOX[verdict]}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`font-display text-lg font-semibold ${verdictStyle.color}`} aria-live="polite">
            <span aria-hidden="true">{verdictStyle.icon} </span>
            {t(`report.verdict.${verdict}`)}
          </p>
          <button
            type="button"
            className={smallButton}
            disabled={!pinned && pins.length >= MAX_PINS}
            onClick={() => useApp.getState().togglePin({ latDeg: query.site.latDeg, lonDeg: query.site.lonDeg })}
          >
            {pinned ? t('report.unpin') : t('report.pin', { max: MAX_PINS })}
          </button>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {(Object.keys(c) as (keyof typeof c)[]).map((k) => (
            <li key={k} className={`rounded-pill border px-2.5 py-0.5 text-[12.5px] ${CHIP[c[k]]}`}>
              <span aria-hidden="true">{STYLE[c[k]].icon} </span>
              {t(`report.${k}`)}:{' '}
              <strong className="font-semibold">
                {c[k] === 'unknown' && k === 'slope' ? slopeText : t(`report.${c[k]}`)}
              </strong>
            </li>
          ))}
        </ul>
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <StatTile label={t('report.sunMin')} edge="sun">
          {pct(result.sunFractionMin * 100)}
        </StatTile>
        <StatTile label={t('report.earthPct')} edge="earth">
          {pct(result.earthVisiblePct)}
        </StatTile>
        {terrain && <StatTile label={t('report.groundHeight')}>{formatNumber(terrain.groundHeightM, 0)} m</StatTile>}
        {longTerm && (
          <>
            <StatTile label={t('report.longTermSun')} edge="sun">
              {formatNumber(longTerm.sunPct, 0)}%
            </StatTile>
            <StatTile label={t('report.longTermEarth')} edge="earth">
              {formatNumber(longTerm.earthPct, 0)}%
            </StatTile>
            <StatTile label={t('report.shadowed')}>{longTerm.shadowed ? t('report.yes') : t('report.no')}</StatTile>
          </>
        )}
      </dl>

      {result.reasons.length > 0 && (
        <ul className="list-disc space-y-1 ps-5 text-sm">
          {result.reasons.map((r) => (
            <ReasonLine key={`${r.code}-${r.atUtc ?? r.detail.missing ?? ''}`} reason={r} />
          ))}
        </ul>
      )}

      <p className="rounded-lg border border-warn/50 bg-warn/8 p-3 text-sm text-warn">
        <span aria-hidden="true">⚠ </span>
        {terrain
          ? t('report.terrainCoarse', { km: formatNumber(terrain.resolutionM / 1000) })
          : terrainError
            ? `${t('report.flatWarning')} (${terrainError})`
            : t('report.offTerrain')}
      </p>

      <div>
        <h3 className="mb-2 text-base">{t('report.events')}</h3>
        <dl className="grid grid-cols-2 gap-2">
          {events.map(([k, at]) => (
            <StatTile key={k} label={t(`report.${k}`)} edge={k.startsWith('sun') ? 'sun' : 'earth'} text>
              {at ? formatUtc(at) : t('report.none')}
            </StatTile>
          ))}
        </dl>
      </div>

      <Timeline series={result.series} />

      <Checks />

      <p className="text-xs text-quiet">
        {t('report.sources')}: {[...result.sources, ...(longTerm ? [longTerm.id] : [])].join(', ')}
      </p>
    </section>
  );
}
