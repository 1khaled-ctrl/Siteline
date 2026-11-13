import { AnimatePresence, motion, type Variants } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DAY_MS } from '../physics';
import { FIRST_UTC_MS, LAST_UTC_MS, nowUtc, useApp } from '../store';

function setDate(utcMs: number) {
  // A cleared date field gives no time at all; keep the date it had.
  if (!Number.isFinite(utcMs)) return;
  useApp.getState().set({ landingUtc: new Date(Math.min(LAST_UTC_MS, Math.max(FIRST_UTC_MS, utcMs))).toISOString() });
}

/** Each wheel rolls up to its new figure when time goes forward, and down when it goes back. */
const ROLL: Variants = {
  enter: (dir: number) => ({ y: dir >= 0 ? '95%' : '-95%', opacity: 0 }),
  show: { y: '0%', opacity: 1 },
  leave: (dir: number) => ({ y: dir >= 0 ? '-95%' : '95%', opacity: 0 }),
};
const SPRING = { type: 'spring', stiffness: 420, damping: 34, mass: 0.7 } as const;

/** Text on rolling wheels, one per character, like a mission clock. Read out by the button around it, not here. */
function Roll({ text, dir }: { text: string; dir: number }) {
  return (
    <span className="inline-flex" aria-hidden="true">
      {[...text].map((ch, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: each place in the clock keeps its own wheel.
        <span key={i} className="roll-cell">
          <AnimatePresence initial={false} custom={dir} mode="popLayout">
            <motion.span
              key={ch}
              className="inline-block"
              custom={dir}
              variants={ROLL}
              initial="enter"
              animate="show"
              exit="leave"
              transition={SPRING}
            >
              {ch === ' ' ? ' ' : ch}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}

/** The date and the time of day the way the clock shows them, always in UTC, with Western digits. */
function useClockText(utcMs: number) {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith('ar') ? 'ar-LB-u-nu-latn' : 'en-GB';
  const formats = useMemo(
    () => ({
      day: new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      time: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }),
    }),
    [locale],
  );
  return { day: formats.day.format(utcMs), time: formats.time.format(utcMs) };
}

/**
 * The header's mission clock: a day back, the date and time on rolling wheels (click them to pick another), a day on,
 * and Live, which pulses while the date follows the real clock (as it does when the app opens) and turns back into
 * Now once you pick a date. Every view is placed and lit for this moment. A gold pulse runs along the header's edge
 * each time you change it.
 */
export function DateStepper() {
  const { t } = useTranslation();
  const landingUtc = useApp((s) => s.landingUtc);
  const live = useApp((s) => s.live);
  const atMs = Date.parse(landingUtc);
  const { day, time } = useClockText(atMs);
  const before = useRef(atMs);
  const dir = atMs >= before.current ? 1 : -1;
  useEffect(() => {
    before.current = atMs;
  }, [atMs]);

  const [pulse, setPulse] = useState(0);
  const change = (utcMs: number) => {
    setDate(utcMs);
    setPulse((p) => p + 1);
  };

  // The wheels open the browser's own date picker; where it cannot, the field itself takes their place for a moment.
  const input = useRef<HTMLInputElement>(null);
  const [typing, setTyping] = useState(false);
  const pick = () => {
    try {
      input.current?.showPicker();
    } catch {
      setTyping(true);
    }
  };
  const field = {
    id: 'header-date',
    type: 'datetime-local',
    dir: 'ltr',
    step: 60,
    min: '2026-01-01T00:00',
    max: '2035-12-31T23:00',
    value: landingUtc.slice(0, 16),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => change(Date.parse(`${e.currentTarget.value}:00Z`)),
  } as const;

  return (
    <div className="flex items-center gap-1.5 max-sm:w-full" data-testid="date-stepper">
      <div className="clock max-sm:flex-1">
        <button
          type="button"
          dir="ltr"
          className="clock-step"
          aria-label={t('header.earlier')}
          onClick={() => change(atMs - DAY_MS)}
        >
          {t('header.dayBack')}
        </button>
        <div className="relative flex flex-1">
          {typing ? (
            <>
              <label className="sr-only" htmlFor="header-date">
                {t('header.dateLabel')}
              </label>
              <input
                {...field}
                // biome-ignore lint/a11y/noAutofocus: the field appears because its wheels were just clicked.
                autoFocus
                onBlur={() => setTyping(false)}
                className="min-h-9 min-w-0 flex-1 bg-transparent px-2 font-mono text-[13px] text-ink"
              />
            </>
          ) : (
            <>
              <button
                type="button"
                dir="ltr"
                className="clock-face"
                aria-label={t('header.changeDate', { date: day, time })}
                onClick={pick}
              >
                <Roll text={day} dir={dir} />
                <span className="clock-sep" aria-hidden="true">
                  ·
                </span>
                <Roll text={time} dir={dir} />
                <span className="clock-utc">{t('header.utc')}</span>
              </button>
              {/* Holds the value for the picker the wheels open; the wheels are what you see and reach. */}
              <input
                {...field}
                ref={input}
                tabIndex={-1}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-0"
              />
            </>
          )}
        </div>
        <button
          type="button"
          dir="ltr"
          className="clock-step"
          aria-label={t('header.later')}
          onClick={() => change(atMs + DAY_MS)}
        >
          {t('header.dayOn')}
        </button>
      </div>
      <motion.button
        layout
        type="button"
        transition={SPRING}
        className={`clock-now ${live ? 'is-live' : ''}`}
        aria-pressed={live}
        title={t(live ? 'header.liveHint' : 'header.nowHint')}
        onClick={() => {
          if (live) return;
          useApp.getState().set({ landingUtc: nowUtc(), live: true });
          setPulse((p) => p + 1);
        }}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={live ? 'live' : 'now'}
            className="flex items-center gap-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={SPRING}
          >
            {live && <span className="live-dot" aria-hidden="true" />}
            {t(live ? 'header.live' : 'header.now')}
          </motion.span>
        </AnimatePresence>
      </motion.button>
      {pulse > 0 && <span key={pulse} className="bar-pulse" aria-hidden="true" />}
    </div>
  );
}
