import type { StayQuery } from '@siteline/contracts';
import { type FitCheck, type FitStatus, moonDistanceKm, robotFit } from '@siteline/physics';
import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { MISSIONS } from '../landers';
import { DAY_MS } from '../physics';
import type { StayResponse } from '../physics.worker';
import { LANDING_RADII_M, ROBOT_IDS, ROBOTS, type RobotId } from '../robots';
import { useApp } from '../store';
import { box, chipButton } from './Controls';

const MARK: Record<FitStatus, { icon: string; color: string }> = {
  pass: { icon: '✅', color: 'text-pass' },
  fail: { icon: '❌', color: 'text-fail' },
  unknown: { icon: '⚠️', color: 'text-warn' },
  info: { icon: 'ℹ️', color: 'text-quiet' },
  not_evaluated: { icon: 'ℹ️', color: 'text-quiet' },
};
const OVERALL_BOX = {
  fits: 'border-pass/60 bg-pass/8 text-pass',
  does_not_fit: 'border-fail/60 bg-fail/7 text-fail',
  not_enough_data: 'border-warn/60 bg-warn/8 text-warn',
} as const;

/** Checks that do not apply and say nothing useful are left off the list; the lander with no surface power is kept. */
const shown = (c: FitCheck) => c.status !== 'not_evaluated' || c.id === 'darkness';

/** The nearest other landed or planned Moon mission, for the plume note. */
function nearestLander(latDeg: number, lonDeg: number) {
  let best: { name: string; km: number; approximate: boolean } | undefined;
  for (const m of MISSIONS) {
    if (m.body !== 'Moon' || m.latDeg === undefined || m.lonDeg === undefined) continue;
    const km = moonDistanceKm(latDeg, lonDeg, m.latDeg, m.lonDeg);
    // The site may be the mission's own spot, opened from its card.
    if (km < 0.01) continue;
    if (!best || km < best.km) best = { name: m.name, km, approximate: m.approximate };
  }
  return best;
}

interface Props extends StayResponse {
  query: StayQuery;
}

/**
 * The site read against one robot's published needs: a short list of what helps and what hurts, each line's numbers
 * from the same check the report above runs. It never changes the report's own verdict.
 */
export function RobotFit({ query, result, slope, longTerm, slopePending }: Props) {
  const { t } = useTranslation();
  const robotId = useApp((s) => s.robot);
  const radiusM = useApp((s) => s.landingRadiusM);
  const robot = robotId ? ROBOTS[robotId] : undefined;

  const fit = useMemo(() => {
    if (!robot) return undefined;
    const stayStartMs = Date.parse(query.landingUtc);
    return robotFit(robot.needs, {
      stayStartMs,
      stayEndMs: stayStartMs + query.stayDays * DAY_MS,
      series: result.series,
      earthVisiblePct: result.earthVisiblePct,
      circle: slope?.circles.find((c) => c.radiusM === radiusM),
      walkablePct: slope?.slope2kmPctUnder20 ?? Number.NaN,
      shadowDistanceKm: longTerm?.shadowDistanceKm ?? result.iceDistanceKm,
    });
  }, [robot, query, result, slope, longTerm, radiusM]);
  const near = useMemo(() => nearestLander(query.site.latDeg, query.site.lonDeg), [query.site]);

  const n = (v: number | undefined, digits = 1) => (v === undefined ? '—' : formatNumber(v, digits));
  const line = (c: FitCheck) => {
    const v = c.values;
    return t(`robot.check.${c.id}.${c.reason}`, {
      radius: n(v.radiusM, 0),
      limit: n(v.limitDeg, 0),
      worst: n(v.worstDeg),
      steep: n(v.steepPct, 0),
      sun: n(v.sunPct, 0),
      dark: n(v.darkH),
      days: formatNumber(query.stayDays),
      pct: n(v.pct, 0),
      walk: n(v.walkablePct, 0),
      km: n(v.shadowKm),
    });
  };

  return (
    <section className={`${box} flex flex-col gap-3`} aria-labelledby="robot-fit-heading">
      <div>
        <h3 id="robot-fit-heading" className="text-base">
          {t('robot.heading')}
        </h3>
        <p className="text-xs text-quiet">{t('robot.intro')}</p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span>{t('robot.pick')}</span>
        <select
          className="min-h-9 rounded-md border border-line bg-panel px-2"
          value={robotId ?? ''}
          onChange={(e) => useApp.getState().set({ robot: (e.target.value || null) as RobotId | null })}
        >
          <option value="">{t('robot.none')}</option>
          {ROBOT_IDS.map((id) => (
            <option key={id} value={id}>
              {t(`robot.name.${id}`)}
            </option>
          ))}
        </select>
      </label>

      {robot && fit && (
        <>
          <p className="text-xs text-quiet">{t(`robot.blurb.${robot.id}`)}</p>

          <fieldset className="flex flex-wrap items-center gap-1.5 text-xs">
            <legend className="float-start me-1.5">{t('robot.ring')}:</legend>
            {LANDING_RADII_M.map((r) => (
              <button
                key={r}
                type="button"
                className={chipButton}
                aria-pressed={radiusM === r}
                onClick={() => useApp.getState().set({ landingRadiusM: r })}
              >
                {t('robot.ringOption', { m: r })}
              </button>
            ))}
            <span className="text-quiet">
              {robot.landingRadiusM ? t('robot.ringOwn', { m: robot.landingRadiusM }) : t('robot.ringNasa')}
            </span>
          </fieldset>

          <p
            className={`rounded-lg border px-3 py-2 font-display font-semibold ${OVERALL_BOX[fit.overall]}`}
            aria-live="polite"
          >
            {t(`robot.overall.${fit.overall}`)}
          </p>

          <ul className="space-y-1.5 text-sm">
            {fit.checks.filter(shown).map((c) => (
              <li key={c.id} className="flex gap-2">
                <span aria-hidden="true">{MARK[c.status].icon}</span>
                <span>
                  <span className="sr-only">{t(`robot.status.${c.status}`)}: </span>
                  {c.id === 'landingCircle' && c.reason === 'not_measured' && slopePending
                    ? t('report.measuringSlope')
                    : line(c)}
                  {c.id === 'landingCircle' && c.reason !== 'not_measured' && (
                    <span className="text-quiet"> {t('robot.limitNote')}</span>
                  )}
                </span>
              </li>
            ))}
            {robot.id === 'artemis4' && (
              <li className="flex gap-2">
                <span aria-hidden="true">ℹ️</span>
                <span>{t('robot.stayNote', { days: formatNumber(query.stayDays) })}</span>
              </li>
            )}
            {near && (
              <li className="flex gap-2">
                <span aria-hidden="true">ℹ️</span>
                <span>
                  {t(near.approximate ? 'robot.neighbourApprox' : 'robot.neighbour', {
                    name: near.name,
                    km: formatNumber(near.km, near.km < 10 ? 1 : 0),
                  })}
                </span>
              </li>
            )}
          </ul>

          <details className="text-xs">
            <summary className="cursor-pointer text-sm">{t('robot.about')}</summary>
            <ul className="mt-2 space-y-1">
              {(['pro1', 'pro2', 'con1', 'con2', 'con3'] as const).map((k) => (
                <li key={k} className="flex gap-2">
                  <span aria-hidden="true">{k.startsWith('pro') ? '＋' : '−'}</span>
                  <span>{t(`robot.${k}`)}</span>
                </li>
              ))}
            </ul>
          </details>

          <p className="text-xs text-quiet">
            {t('report.sources')}:{' '}
            {[...new Set([...robot.sources, 'nasa-m2m-landing-2023'])].map((id, i) => (
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
            ))}
          </p>
        </>
      )}
    </section>
  );
}
