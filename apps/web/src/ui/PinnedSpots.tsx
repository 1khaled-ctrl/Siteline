import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { fineRegionAt } from '../land';
import { useStayMany } from '../physics';
import { regionOf } from '../pinned';
import { MAX_PINS, type Pin, samePin, useApp } from '../store';
import { checksOf, type Verdict, verdictOf } from '../verdict';
import { Compare } from './Compare';
import { smallButton } from './Controls';

const VERDICT: Record<Verdict, { icon: string; className: string }> = {
  pass: { icon: '✓', className: 'text-pass' },
  fail: { icon: '✗', className: 'text-fail' },
  undecided: { icon: '?', className: 'text-warn' },
};

/** A pinned spot's latitude and longitude as the app writes them. */
function coordinates(p: Pin, t: (key: string) => string): string {
  const ns = p.latDeg < 0 ? t('landers.south') : t('landers.north');
  const ew = p.lonDeg < 0 ? t('landers.west') : t('landers.east');
  return `${formatNumber(Math.abs(p.latDeg), 2)}° ${ns}, ${formatNumber(Math.abs(p.lonDeg), 2)}° ${ew}`;
}

/**
 * The pinned spots, at the top of the Moon's panel: each one's name (its Artemis region, where it lies in one), its
 * stay verdict for the date shown, a way back to it and a way to unpin it, and the side-by-side comparison of them all
 * one button away.
 */
export function PinnedSpots() {
  const { t } = useTranslation();
  const pins = useApp((s) => s.pins);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const rows = useStayMany(pins);
  const [comparing, setComparing] = useState(false);
  if (pins.length === 0) return null;
  // A named candidate region (2024), else one of the Artemis III regions with NASA's 5 m terrain.
  const names = pins.map((p) => regionOf(p.latDeg, p.lonDeg) ?? fineRegionAt(p.latDeg, p.lonDeg)?.name);
  const canCompare = pins.length > 1;

  return (
    <section className="min-w-0" aria-labelledby="pinned-heading" data-testid="pinned">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="pinned-heading" className="font-semibold">
          {t('pinned.heading', { count: pins.length })}
        </h2>
        {canCompare && (
          <button
            type="button"
            className={smallButton}
            aria-expanded={comparing}
            aria-pressed={comparing}
            aria-controls="pinned-compare"
            onClick={() => setComparing((v) => !v)}
            data-testid="pinned-compare"
          >
            {comparing ? t('pinned.hideCompare') : t('pinned.compare', { count: pins.length })}
          </button>
        )}
      </div>
      <ul className="grid gap-1.5">
        {pins.map((p, i) => {
          const r = rows[i];
          const verdict = r ? verdictOf(checksOf(r.result)) : undefined;
          const here = samePin(p, { latDeg, lonDeg });
          const name = names[i];
          const where = coordinates(p, t);
          return (
            <li
              key={`${p.latDeg},${p.lonDeg}`}
              className={`flex items-center gap-1 rounded-lg border bg-panel-raised ${here ? 'border-sun/60' : 'border-line'}`}
            >
              <button
                type="button"
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-1.5 text-start hover:bg-panel-sunk/60"
                aria-current={here ? 'location' : undefined}
                aria-label={t('pinned.go', { site: name ? `${name}, ${where}` : where })}
                onClick={() => useApp.getState().focusSite(p.latDeg, p.lonDeg)}
                data-testid="pinned-go"
              >
                <span
                  className={`w-4 shrink-0 text-center text-base ${verdict ? VERDICT[verdict].className : 'text-quiet'}`}
                  aria-hidden="true"
                >
                  {verdict ? VERDICT[verdict].icon : '…'}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{name ?? t('pinned.unnamed', { n: i + 1 })}</span>
                  <span className="block font-mono text-xs text-quiet" dir="ltr">
                    {where}
                  </span>
                </span>
                <span className="shrink-0 text-xs">
                  {verdict && (
                    <span className={VERDICT[verdict].className}>
                      {verdict === 'undecided' ? t('compare.undecided') : t(`report.verdict.${verdict}`)}
                    </span>
                  )}
                  {here && <span className="block text-sun-ink">{t('pinned.here')}</span>}
                </span>
              </button>
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center rounded-lg text-lg text-quiet hover:text-ink"
                aria-label={t('compare.unpinSite', { site: name ?? where })}
                onClick={() => useApp.getState().togglePin(p)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-quiet">
        {!canCompare
          ? t('pinned.oneMore')
          : pins.length >= MAX_PINS
            ? t('pinned.full', { max: MAX_PINS })
            : t('pinned.hint')}
      </p>
      {canCompare && comparing && (
        <div id="pinned-compare" className="mt-3">
          <Compare rows={rows} names={names} />
        </div>
      )}
    </section>
  );
}
