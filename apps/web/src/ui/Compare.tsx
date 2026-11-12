import { MAX_LANDING_SLOPE_DEG } from '@siteline/physics';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber, formatUtcShort } from '../format';
import { DAY_MS, useStayMany } from '../physics';
import type { StayResponse } from '../physics.worker';
import { type Pin, useApp } from '../store';
import { bestOf, type Check, checksOf, firstProblem, rankSites, type Verdict, verdictOf } from '../verdict';
import { panel } from './Controls';

interface Judged {
  r: StayResponse;
  checks: Record<'sun' | 'earth' | 'slope' | 'zone', Check>;
  verdict: Verdict;
}

const VERDICT_STYLE: Record<Verdict, { icon: string; className: string }> = {
  pass: { icon: '✓', className: 'border-pass/55 bg-pass/10 text-pass' },
  fail: { icon: '✗', className: 'border-fail/55 bg-fail/10 text-fail' },
  undecided: { icon: '?', className: 'border-warn/55 bg-warn/10 text-warn' },
};

const finite = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : undefined);

/** One reading across the pinned sites: how to show it and, where higher is better, the number to compare. */
interface Line {
  key: string;
  label: string;
  show: (j: Judged) => ReactNode;
  value?: (j: Judged) => number | undefined;
}

/**
 * Every pinned site re-checked for the current landing date and slip, side by side: one column a site, one row a
 * reading, the best value in each row starred, and the best site named by a rule stated under the table.
 */
export function Compare() {
  const { t } = useTranslation();
  const pins = useApp((s) => s.pins);
  const landingMs = useApp((s) => Date.parse(s.landingUtc) + s.slipDays * DAY_MS);
  const rows = useStayMany(pins);
  if (pins.length === 0) return null;

  const judged: (Judged | undefined)[] = pins.map((_, i) => {
    const r = rows[i];
    if (!r) return undefined;
    const checks = checksOf(r.result);
    return { r, checks, verdict: verdictOf(checks) };
  });
  const order = rankSites(
    judged.map(
      (j) =>
        j && { verdict: j.verdict, earthVisiblePct: j.r.result.earthVisiblePct, longTermSunPct: j.r.longTerm?.sunPct },
    ),
  );
  const allIn = judged.every(Boolean);
  const winner = allIn && pins.length > 1 ? order[0] : undefined;
  const pct = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : `${formatNumber(v, 0)}%`);
  const word = (c: Check) => t(`report.${c}`);

  const lines: Line[] = [
    {
      key: 'verdict',
      label: t('compare.verdict'),
      show: (j) => (
        <span
          className={`inline-block rounded-pill border px-2 py-0.5 font-sans text-xs whitespace-nowrap ${VERDICT_STYLE[j.verdict].className}`}
        >
          <span aria-hidden="true">{VERDICT_STYLE[j.verdict].icon}</span>
          {/* Four columns leave no room for the word on a phone; the mark and colour carry it there. */}
          <span className="max-sm:sr-only">
            {' '}
            {j.verdict === 'undecided' ? t('compare.undecided') : t(`report.verdict.${j.verdict}`)}
          </span>
        </span>
      ),
    },
    {
      key: 'sun',
      label: t('report.sunMin'),
      show: (j) => pct(j.r.result.sunFractionMin * 100),
      value: (j) => finite(j.r.result.sunFractionMin),
    },
    {
      key: 'earth',
      label: t('report.earthPct'),
      show: (j) => pct(j.r.result.earthVisiblePct),
      value: (j) => finite(j.r.result.earthVisiblePct),
    },
    {
      key: 'slope',
      label: t('compare.slope', { deg: formatNumber(MAX_LANDING_SLOPE_DEG, 0) }),
      show: (j) => word(j.checks.slope),
    },
    {
      key: 'height',
      label: t('report.groundHeight'),
      show: (j) => (j.r.terrain ? `${formatNumber(j.r.terrain.groundHeightM, 0)} m` : '—'),
    },
    {
      key: 'longSun',
      label: t('report.longTermSun'),
      show: (j) => pct(j.r.longTerm?.sunPct),
      value: (j) => finite(j.r.longTerm?.sunPct),
    },
    {
      key: 'longEarth',
      label: t('report.longTermEarth'),
      show: (j) => pct(j.r.longTerm?.earthPct),
      value: (j) => finite(j.r.longTerm?.earthPct),
    },
    {
      key: 'problem',
      label: t('compare.firstProblem'),
      show: (j) => {
        const p = firstProblem(j.r.result.reasons, landingMs);
        if (!p) return t('compare.noProblem');
        if (p.atLanding) return t(`compare.atLanding.${p.key}`);
        return p.atUtc ? `${t(`compare.problem.${p.key}`)} ${formatUtcShort(p.atUtc)}` : t(`compare.problem.${p.key}`);
      },
    },
  ];

  return (
    <section className={panel} data-testid="compare">
      <h2 className="mb-1 text-lg">{t('compare.heading', { count: pins.length })}</h2>
      <p className="mb-2 text-xs text-quiet">{t('compare.intro')}</p>
      <table className="w-full table-fixed border-collapse text-[13px]">
        <caption className="sr-only">{t('compare.caption')}</caption>
        <thead>
          <tr className="align-bottom">
            <th scope="col" className="w-26 pb-1.5 text-start text-xs font-normal text-quiet">
              {t('compare.site')}
            </th>
            {pins.map((p, i) => (
              <th key={`${p.latDeg},${p.lonDeg}`} scope="col" className="px-1 pb-1.5 text-end font-normal">
                {winner === i && (
                  <span className="mb-1 inline-block rounded-pill border border-accent/60 bg-accent/12 px-1.5 text-[11px] text-accent">
                    {t('compare.bestBadge')}
                  </span>
                )}
                <button
                  type="button"
                  title={t('compare.open')}
                  className="block w-full rounded px-0.5 text-end font-mono text-[12px] leading-tight hover:bg-panel-raised"
                  dir="ltr"
                  onClick={() => useApp.getState().focusSite(p.latDeg, p.lonDeg)}
                >
                  <SiteName pin={p} />
                </button>
                <button
                  type="button"
                  aria-label={t('compare.unpinSite', { site: siteText(p, t) })}
                  className="mt-0.5 min-h-6 rounded px-1.5 text-xs text-quiet hover:bg-panel-raised hover:text-ink"
                  onClick={() => useApp.getState().togglePin(p)}
                >
                  {t('compare.unpin')}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => {
            const best = line.value ? bestOf(judged.map((j) => j && line.value?.(j))) : new Set<number>();
            return (
              <tr key={line.key} className="border-t border-line">
                <th scope="row" className="py-1.5 pe-1 text-start text-xs font-normal text-quiet">
                  {line.label}
                </th>
                {judged.map((j, i) => (
                  <td
                    key={`${pins[i].latDeg},${pins[i].lonDeg}`}
                    className={`px-1 py-1.5 text-end font-mono wrap-break-word ${best.has(i) ? 'text-accent' : ''} ${line.key === 'problem' ? 'font-sans text-xs' : ''}`}
                  >
                    {j ? line.show(j) : <span className="text-quiet">…</span>}
                    {best.has(i) && (
                      <>
                        <span aria-hidden="true"> ★</span>
                        <span className="sr-only"> {t('compare.bestValue')}</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {winner !== undefined && (
        <p className="mt-3 rounded-lg border border-accent/40 bg-accent/8 p-2.5 text-sm">
          {t('compare.winner', { site: siteText(pins[winner], t) })}
        </p>
      )}
      <p className="mt-2 text-xs text-quiet">{t('compare.rule')}</p>
    </section>
  );
}

function siteText(p: Pin, t: (key: string) => string): string {
  const ns = p.latDeg < 0 ? t('landers.south') : t('landers.north');
  const ew = p.lonDeg < 0 ? t('landers.west') : t('landers.east');
  return `${formatNumber(Math.abs(p.latDeg), 2)}° ${ns}, ${formatNumber(Math.abs(p.lonDeg), 2)}° ${ew}`;
}

function SiteName({ pin }: { pin: Pin }) {
  const { t } = useTranslation();
  return (
    <>
      <span className="block">
        {formatNumber(Math.abs(pin.latDeg), 2)}° {pin.latDeg < 0 ? t('landers.south') : t('landers.north')}
      </span>
      <span className="block">
        {formatNumber(Math.abs(pin.lonDeg), 2)}° {pin.lonDeg < 0 ? t('landers.west') : t('landers.east')}
      </span>
    </>
  );
}
