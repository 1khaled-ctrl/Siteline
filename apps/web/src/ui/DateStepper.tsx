import { useTranslation } from 'react-i18next';
import { DAY_MS, HOUR_MS } from '../physics';
import { useApp } from '../store';
import { smallButton } from './Controls';

/** The dates the ephemeris tables cover, the same range the sidebar's date fields allow. */
const FIRST_UTC_MS = Date.parse('2026-01-01T00:00:00Z');
const LAST_UTC_MS = Date.parse('2035-12-31T23:00:00Z');

function setDate(utcMs: number) {
  // A cleared date field gives no time at all; keep the date it had.
  if (!Number.isFinite(utcMs)) return;
  useApp.getState().set({ landingUtc: new Date(Math.min(LAST_UTC_MS, Math.max(FIRST_UTC_MS, utcMs))).toISOString() });
}

/** The header's date: a day back, the date and hour, a day on, and now. Every view is placed and lit for it. */
export function DateStepper() {
  const { t } = useTranslation();
  const landingUtc = useApp((s) => s.landingUtc);
  const atMs = Date.parse(landingUtc);

  return (
    <div className="flex flex-wrap items-center gap-1.5 max-sm:flex-nowrap" data-testid="date-stepper">
      <button
        type="button"
        dir="ltr"
        className={smallButton}
        aria-label={t('header.earlier')}
        onClick={() => setDate(atMs - DAY_MS)}
      >
        {t('header.dayBack')}
      </button>
      <label className="sr-only" htmlFor="header-date">
        {t('header.dateLabel')}
      </label>
      <input
        id="header-date"
        type="datetime-local"
        dir="ltr"
        step={3600}
        min="2026-01-01T00:00"
        max="2035-12-31T23:00"
        value={landingUtc.slice(0, 16)}
        className="min-h-9 min-w-0 rounded-md border border-line bg-panel-raised px-2 text-[13px] text-ink max-sm:flex-1 max-sm:px-1.5 max-sm:text-[12px]"
        onChange={(e) => setDate(Date.parse(`${e.currentTarget.value}:00Z`))}
      />
      <span className="font-mono text-xs text-quiet max-sm:hidden">{t('header.utc')}</span>
      <button
        type="button"
        dir="ltr"
        className={smallButton}
        aria-label={t('header.later')}
        onClick={() => setDate(atMs + DAY_MS)}
      >
        {t('header.dayOn')}
      </button>
      <button type="button" className={smallButton} onClick={() => setDate(Math.floor(Date.now() / HOUR_MS) * HOUR_MS)}>
        {t('header.now')}
      </button>
    </div>
  );
}
