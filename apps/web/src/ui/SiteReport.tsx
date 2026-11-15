import type { Reason, StayQuery, StayResult } from '@siteline/contracts';
import { Fragment, type ReactNode, useEffect } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { confidenceOf, type Reading } from '../confidence';
import { formatNumber, formatUtc } from '../format';
import { touchdownFromQuery } from '../land';
import { DAY_MS, useStay } from '../physics';
import { sound } from '../sound';
import { MAX_PINS, samePin, useApp } from '../store';
import {
  type Check,
  COLD_TRAP,
  checksOf,
  ICE_OUTLINE,
  ICE_SOURCES,
  iceDetectedLineOf,
  iceLineOf,
  verdictOf,
} from '../verdict';
import { StatTile } from './BodyFacts';
import { Checks } from './Checks';
import { ConfidenceBadge, ConfidenceKey } from './ConfidenceBadge';
import { panel, smallButton } from './Controls';
import { DayStripPanel } from './DayStrip';
import { JourneyButton } from './Journey';
import { LandHereButton } from './LandHere';
import { RobotFit } from './RobotFit';
import { ShareReport } from './ShareReport';
import { Timeline } from './Timeline';
import { PanelError, Spinner } from './ViewStatus';

/** The verdict's box and the check chips, tinted like the demo's pass and fail boxes. */
const VERDICT_BOX = {
  pass: 'border-pass/60 bg-pass/8',
  fail: 'border-fail/60 bg-fail/7',
  undecided: 'border-warn/60 bg-warn/8',
} as const;
/** A link to a page outside SiteLine, with its words from the translation it sits in. */
function SourceLink({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">
      {children}
    </a>
  );
}

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

/** The report's shape in grey while the first check runs, so the panel does not jump when it lands. */
function ReportSkeleton() {
  const { t } = useTranslation();
  const bar = 'rounded-lg bg-panel-raised motion-safe:animate-pulse';
  return (
    <section className={`${panel} flex flex-col gap-4`} aria-busy="true">
      <h2 className="text-2xl">{t('report.heading')}</h2>
      <p role="status" className="flex items-center gap-2 text-sm text-quiet">
        <Spinner />
        {t('report.loading')}
      </p>
      <div className={`h-20 ${bar}`} />
      <div className="grid grid-cols-2 gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-16 ${bar}`} />
        ))}
      </div>
    </section>
  );
}

/** The last verdict sounded, by site and moment, kept across the report closing and opening again. */
let lastSounded = '';

/**
 * Plays the verdict's short phrase when a verdict is new: a site picked, the date or slip changed, Now pressed. Not for
 * the live clock moving on a minute, and not again for a site and moment already heard, as when the report reopens.
 * Nothing plays at all before the first tap or key press, nor while the slope is still being measured (it can turn the
 * verdict). The verdict's icon and word stay on screen; the sound only goes with them.
 */
function useVerdictSound(query: StayQuery | undefined, result: StayResult | undefined, slopePending?: boolean) {
  useEffect(() => {
    if (!query || !result || slopePending) return;
    const { live, slipDays } = useApp.getState();
    const key = `${query.site.latDeg},${query.site.lonDeg}|${live ? `live${slipDays}` : query.landingUtc}`;
    if (key === lastSounded) return;
    lastSounded = key;
    sound.verdict(verdictOf(checksOf(result)));
  }, [query, result, slopePending]);
}

export function SiteReport() {
  const { t } = useTranslation();
  const { query, result, terrain, terrainError, longTerm, slope, slopePending, iceDetected, error, loading, retry } =
    useStay();
  useVerdictSound(query, result, slopePending);
  const pins = useApp((s) => s.pins);
  const pinned = query ? pins.some((p) => samePin(p, query.site)) : false;

  if (error)
    return (
      <section className={panel}>
        <h2 className="mb-2 text-2xl">{t('report.heading')}</h2>
        <PanelError title={t('status.panel.report')} reason={error} onRetry={retry} />
      </section>
    );
  if (!result || !query) return <ReportSkeleton />;

  const c = checksOf(result);
  const verdict = verdictOf(c);
  const ice = iceLineOf(result);
  const detected = iceDetectedLineOf(iceDetected);
  const verdictStyle = STYLE[verdict === 'pass' ? 'yes' : verdict === 'fail' ? 'no' : 'unknown'];
  const events = [
    ['sunset', result.nextSunsetUtc],
    ['sunrise', result.nextSunriseUtc],
    ['earthset', result.nextEarthsetUtc],
    ['earthrise', result.nextEarthriseUtc],
  ] as const;
  const pct = (v: number) => (Number.isFinite(v) ? `${formatNumber(v)}%` : '—');
  const slopeText = slopePending
    ? t('report.measuringSlope')
    : terrain
      ? t('report.needsFinerTerrain')
      : t('report.noTerrain');
  const sure = { terrainM: terrain?.resolutionM, longTermM: longTerm?.resolutionM, slopeM: slope?.resolutionM };
  const mark = (reading: Reading) => (
    <ConfidenceBadge level={confidenceOf(reading, sure)} terrainM={sure.terrainM} compact />
  );
  const terrainNote = terrain
    ? t('report.terrainCoarse', { km: formatNumber(terrain.resolutionM / 1000) })
    : terrainError
      ? `${t('report.flatWarning')} (${terrainError})`
      : t('report.offTerrain');

  return (
    <section className={`${panel} flex flex-col gap-4`} aria-busy={loading} id="site-report" tabIndex={-1}>
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
          <div className="flex flex-wrap gap-2">
            <ShareReport
              query={query}
              result={result}
              terrain={terrain}
              longTerm={longTerm}
              slope={slope}
              slopePending={slopePending}
              checks={c}
              verdict={verdict}
              note={terrainNote}
            />
            <button
              type="button"
              className={smallButton}
              disabled={!pinned && pins.length >= MAX_PINS}
              onClick={() => useApp.getState().togglePin({ latDeg: query.site.latDeg, lonDeg: query.site.lonDeg })}
            >
              {pinned ? t('report.unpin') : t('report.pin', { max: MAX_PINS })}
            </button>
          </div>
        </div>
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {(Object.keys(c) as (keyof typeof c)[]).map((k) => (
            <li key={k} className={`rounded-pill border px-2.5 py-0.5 text-[12.5px] ${CHIP[c[k]]}`}>
              <span aria-hidden="true">{STYLE[c[k]].icon} </span>
              {t(`report.${k}`)}:{' '}
              <strong className="font-semibold">
                {c[k] === 'unknown' && k === 'slope' ? slopeText : t(`report.${c[k]}`)}
              </strong>
              {/* An unmeasured slope already says why in its own words. */}
              {!(k === 'slope' && c[k] === 'unknown') && (
                <>
                  {' '}
                  <ConfidenceBadge level={confidenceOf(k, sure)} terrainM={sure.terrainM} />
                </>
              )}
            </li>
          ))}
        </ul>
        {(ice || detected) && (
          // The fifth line: information beside the four checks, never one of them, so it has no tick or cross.
          <div className="mt-2 border-t border-line/70 pt-2 text-[12.5px]" data-testid="ice-line">
            {ice && (
              <p>
                <span aria-hidden="true">◇ </span>
                {t('report.ice')}:{' '}
                <strong className="font-semibold">
                  {ice.atSite ? t('report.iceAtSite') : t('report.iceKm', { km: formatNumber(ice.distanceKm, 1) })}
                </strong>{' '}
                <span
                  className="rounded-pill border border-line px-1.5 py-px text-[11px] text-quiet whitespace-nowrap"
                  data-testid="ice-level"
                >
                  {t('report.iceLevel', { level: t(`report.iceLevels.${ice.level}`) })}
                </span>{' '}
                <ConfidenceBadge level={confidenceOf('longTerm', sure)} terrainM={sure.terrainM} />
              </p>
            )}
            {detected && (
              <>
                <p className={ice ? 'mt-1' : undefined} data-testid="ice-detected">
                  <span aria-hidden="true">◇ </span>
                  {t('report.iceDetected')}:{' '}
                  <strong className="font-semibold">
                    <Trans
                      i18nKey={detected.withinOutline ? 'report.iceDetectedWithin' : 'report.iceDetectedKm'}
                      values={{ km: formatNumber(detected.distanceKm, 1) }}
                      components={{ link: <SourceLink href={ICE_SOURCES.detectedNearby} /> }}
                    />
                  </strong>{' '}
                  <span
                    className="rounded-pill border border-line px-1.5 py-px text-[11px] text-quiet whitespace-nowrap"
                    data-testid="ice-detected-level"
                  >
                    {t('report.iceLevel', { level: t(`report.iceLevels.${detected.level}`) })}
                  </span>
                </p>
                <p className="mt-1 text-quiet">
                  <Trans
                    i18nKey="report.iceDetectedNote"
                    values={{ m: formatNumber(ICE_OUTLINE.beyondShadowM, 0) }}
                    components={{ m3: <SourceLink href={ICE_SOURCES.m3} /> }}
                  />
                </p>
              </>
            )}
            <p className="mt-1 text-quiet">
              <Trans
                i18nKey="report.iceEvidence"
                components={{
                  b: <strong className="font-semibold text-ink" />,
                  fisher: <SourceLink href={ICE_SOURCES.consistent} />,
                  lcross: <SourceLink href={ICE_SOURCES.lcross} />,
                  m3: <SourceLink href={ICE_SOURCES.m3} />,
                }}
              />
            </p>
            <p className="mt-1 text-quiet">
              <Trans
                i18nKey="report.iceColdTrap"
                values={{
                  c: formatNumber(COLD_TRAP.belowC, 0).replace('-', '−'),
                  f: formatNumber(COLD_TRAP.belowF, 0).replace('-', '−'),
                }}
                components={{ nasa: <SourceLink href={COLD_TRAP.source} /> }}
              />
            </p>
            <p className="mt-1 text-quiet">
              <Trans i18nKey="report.iceUses" components={{ link: <SourceLink href={ICE_SOURCES.uses} /> }} />
            </p>
          </div>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-2">
        <StatTile label={t('report.sunMin')} edge="sun" badge={mark('sun')}>
          {pct(result.sunFractionMin * 100)}
        </StatTile>
        <StatTile label={t('report.earthPct')} edge="earth" badge={mark('earth')}>
          {pct(result.earthVisiblePct)}
        </StatTile>
        {terrain && (
          <StatTile label={t('report.groundHeight')} badge={mark('height')}>
            {formatNumber(terrain.groundHeightM, 0)} m
          </StatTile>
        )}
        {slope && (
          <>
            <StatTile label={t('report.landingSlope')} badge={mark('slope')}>
              {formatNumber(slope.slope100mDeg)}°
            </StatTile>
            <StatTile label={t('report.walkable')} badge={mark('slope')}>
              {pct(slope.slope2kmPctUnder20)}
            </StatTile>
          </>
        )}
        {longTerm && (
          <>
            <StatTile label={t('report.longTermSun')} edge="sun" badge={mark('longTerm')}>
              {formatNumber(longTerm.sunPct, 0)}%
            </StatTile>
            <StatTile label={t('report.longTermEarth')} edge="earth" badge={mark('longTerm')}>
              {formatNumber(longTerm.earthPct, 0)}%
            </StatTile>
            {longTerm.shadowDistanceKm !== undefined && (
              <StatTile label={t('report.coldTrap')} badge={mark('longTerm')}>
                {formatNumber(longTerm.shadowDistanceKm, 1)} km
              </StatTile>
            )}
            <StatTile label={t('report.shadowed')} badge={mark('longTerm')}>
              {longTerm.shadowed ? t('report.yes') : t('report.no')}
            </StatTile>
          </>
        )}
      </dl>

      <RobotFit
        query={query}
        result={result}
        terrain={terrain}
        longTerm={longTerm}
        slope={slope}
        slopePending={slopePending}
      />

      <DayStripPanel
        latDeg={query.site.latDeg}
        lonDeg={query.site.lonDeg}
        fromMs={Date.parse(query.landingUtc)}
        toMs={Date.parse(query.landingUtc) + query.stayDays * DAY_MS}
      />

      <div className="flex flex-col gap-2">
        <JourneyButton target={{ body: 'Moon', latDeg: query.site.latDeg, lonDeg: query.site.lonDeg }} />
        <LandHereButton
          latDeg={query.site.latDeg}
          lonDeg={query.site.lonDeg}
          touchdownUtcMs={touchdownFromQuery(query)}
          source={{ kind: 'report' }}
        />
      </div>

      {result.reasons.length > 0 && (
        <ul className="list-disc space-y-1 ps-5 text-sm">
          {result.reasons.map((r) => (
            <ReasonLine key={`${r.code}-${r.atUtc ?? r.detail.missing ?? ''}`} reason={r} />
          ))}
        </ul>
      )}

      <ConfidenceKey terrainM={sure.terrainM} note={terrainNote} />

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
        {t('report.sources')}:{' '}
        {/* Each dataset once: the long-term maps can be among the check's own sources (the cold trap) too. */}
        {[...new Set([...result.sources, ...(longTerm ? [longTerm.id] : []), ...(detected ? [detected.id] : [])])].map(
          (id, i) => (
            <Fragment key={id}>
              {i > 0 && ', '}
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 hover:text-ink"
                onClick={() => useApp.getState().setSources(id)}
              >
                {id}
              </button>
            </Fragment>
          ),
        )}
      </p>
    </section>
  );
}
