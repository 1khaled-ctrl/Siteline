import type { ScreenDisc, ScreenPoint } from '@siteline/engine';
import { useTranslation } from 'react-i18next';
import type { FactBody } from '../bodyFacts';
import { formatNumber } from '../format';
import { useStay } from '../physics';
import { useApp } from '../store';
import { CHECK_KEYS, type Check, checksOf, type Verdict, verdictOf } from '../verdict';
import { useBodyReadings } from './BodyFacts';
import type { CalloutTone } from './Callouts';
import { Spinner } from './ViewStatus';

const ICON: Record<Check, string> = { yes: '✓', no: '✗', unknown: '?' };
const CHECK_TEXT: Record<Check, string> = { yes: 'text-pass', no: 'text-fail', unknown: 'text-warn' };
export const VERDICT_TONE: Record<Verdict, CalloutTone> = { pass: 'pass', fail: 'fail', undecided: 'warn' };

/** Brings a card in the panel into view, puts the keyboard on it, and lights its edge for a moment. */
export function showCard(id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  el.focus({ preventScroll: true });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 700);
}

/**
 * A point on a globe's outline, `angleDeg` round from the right (clockwise on screen), as a callout's anchor. None
 * while the globe fills most of the view (Mars and the Earth open that way), since its card would cover the surface;
 * its facts are in the panel all along, and the card comes in as you zoom out.
 */
export function onOutline(disc: ScreenDisc | null, angleDeg: number): ScreenPoint | null {
  if (!disc || disc.r < 60 || disc.r > 0.36 * window.innerHeight) return null;
  const a = (angleDeg * Math.PI) / 180;
  const x = disc.x + disc.r * 0.97 * Math.cos(a);
  const y = disc.y + disc.r * 0.97 * Math.sin(a);
  return { x, y, depth: 0, visible: x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight };
}

/** A latitude and longitude the way the Earth panel words them: 85.4° S, 31.7° E. */
function useCoordinates() {
  const { t } = useTranslation();
  const side = (v: number, positive: string, negative: string) =>
    `${formatNumber(Math.abs(v), 2)}° ${t(v >= 0 ? positive : negative)}`;
  return (latDeg: number, lonDeg: number) =>
    `${side(latDeg, 'earth.panel.north', 'earth.panel.south')}, ${side(lonDeg, 'earth.panel.east', 'earth.panel.west')}`;
}

/**
 * The picked landing site's card in the scene, beside the spot on the terrain: the verdict and the four checks at a
 * glance, the two percentages behind them, and a way to the full report in the panel. The same stay check as the
 * report, shared, so it runs once.
 */
export function SiteCard() {
  const { t } = useTranslation();
  const { result, error } = useStay();
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const coords = useCoordinates();
  const checks = result && checksOf(result);
  const verdict = checks && verdictOf(checks);
  const pct = (v: number) => (Number.isFinite(v) ? `${formatNumber(v)}%` : '—');

  return (
    <>
      <p className="text-[10.5px] tracking-[0.12em] text-quiet uppercase">{t('callout.site')}</p>
      <p className="mt-0.5 font-mono text-xs text-ink" dir="ltr">
        {coords(latDeg, lonDeg)}
      </p>
      {error ? (
        <p className="mt-2 text-xs text-fail">{t('status.panel.report')}</p>
      ) : !checks || !verdict || !result ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-quiet">
          <Spinner className="size-3.5" />
          {t('callout.checking')}
        </p>
      ) : (
        <>
          <p
            className={`mt-2 font-display text-lg leading-none font-semibold ${CHECK_TEXT[verdict === 'pass' ? 'yes' : verdict === 'fail' ? 'no' : 'unknown']}`}
          >
            <span aria-hidden="true">{ICON[verdict === 'pass' ? 'yes' : verdict === 'fail' ? 'no' : 'unknown']} </span>
            {t(`report.verdict.${verdict}`)}
          </p>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {CHECK_KEYS.map((k) => (
              <li key={k} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`w-3 text-center font-semibold ${CHECK_TEXT[checks[k]]}`}>
                  {ICON[checks[k]]}
                </span>
                <span>{t(`callout.check.${k}`)}</span>
                <span className="sr-only">: {t(`report.${checks[k]}`)}</span>
              </li>
            ))}
          </ul>
          <dl className="callout-readings mt-2 border-t border-line/70 pt-2">
            <dt>{t('report.sunMin')}</dt>
            <dd>{pct(result.sunFractionMin * 100)}</dd>
            <dt>{t('report.earthPct')}</dt>
            <dd>{pct(result.earthVisiblePct)}</dd>
          </dl>
        </>
      )}
      <button type="button" className="callout-go mt-2.5" onClick={() => showCard('site-report')}>
        {t('callout.fullReport')}
      </button>
    </>
  );
}

/** A world's card beside its globe: three readings from its facts card, and a way to the rest of them. */
export function BodyCard({ body }: { body: FactBody }) {
  const { t } = useTranslation();
  const r = useBodyReadings(body);
  return (
    <>
      <h3 className="font-display text-[15px] leading-none">{t(`facts.heading.${body}`)}</h3>
      <dl className="callout-readings mt-2">
        <dt>{t('facts.gravity')}</dt>
        <dd>{r.gravity}</dd>
        <dt>{t('facts.sunlight')}</dt>
        <dd>{r.sunlight}</dd>
        {body === 'Earth' ? (
          <>
            <dt>{t('facts.solarDay')}</dt>
            <dd>{r.solarDay}</dd>
          </>
        ) : (
          <>
            <dt>{t('facts.signal')}</dt>
            <dd>{r.signal}</dd>
          </>
        )}
      </dl>
      <button type="button" className="callout-go mt-2.5" onClick={() => showCard('body-facts')}>
        {t('callout.allFacts')}
      </button>
    </>
  );
}
