import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBoot } from '../boot';
import { useStage } from '../stage';

/**
 * Now and then, a small note above the orb that Luna, the AI assistant, lives there: a few seconds after the intro,
 * then every few minutes, a few times a visit, until the visitor opens her. Once they have, it shows at most every few
 * days on that device. A click opens Luna; the × puts it away for the visit.
 */

const FIRST_AFTER_MS = 10_000;
const AGAIN_AFTER_MS = 3 * 60_000;
const SHOWN_FOR_MS = 8_000;
const MAX_PER_VISIT = 3;
const AFTER_OPENED_MS = 3 * 24 * 3_600_000;
const KEY = 'siteline.lunaHint';

interface Memory {
  opened?: boolean;
  lastShownMs?: number;
}

const read = (): Memory => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Memory;
  } catch {
    return {};
  }
};
const write = (m: Memory) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Storage blocked (a private window): the hint just forgets.
  }
};

/** Whether the hint may show now, from what this device remembers. */
export function hintAllowed(memory: Memory, nowMs: number): boolean {
  if (!memory.opened) return true;
  return nowMs - (memory.lastShownMs ?? 0) >= AFTER_OPENED_MS;
}

/** `side` is where the orb sits: the hint opens toward the middle of the screen from it. */
export function LunaHint({ side }: { side: 'start' | 'end' }) {
  const { t } = useTranslation();
  const opened = useBoot((s) => s.opened);
  const copilotOpen = useStage((s) => s.copilotOpen);
  const orbOpen = useStage((s) => s.orbOpen);
  const uiHidden = useStage((s) => s.uiHidden);
  const [shown, setShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [count, setCount] = useState(0);

  // Opening Luna, by any way, is remembered: she has been found.
  useEffect(() => {
    if (copilotOpen) {
      write({ ...read(), opened: true });
      setShown(false);
    }
  }, [copilotOpen]);

  useEffect(() => {
    if (!opened || dismissed || copilotOpen || count >= MAX_PER_VISIT) return;
    const wait = count === 0 ? FIRST_AFTER_MS : AGAIN_AFTER_MS;
    const show = setTimeout(() => {
      if (!hintAllowed(read(), Date.now()) || useStage.getState().copilotOpen) return;
      write({ ...read(), lastShownMs: Date.now() });
      setShown(true);
      setCount((n) => n + 1);
    }, wait);
    return () => clearTimeout(show);
  }, [opened, dismissed, copilotOpen, count]);

  useEffect(() => {
    if (!shown) return;
    const hide = setTimeout(() => setShown(false), SHOWN_FOR_MS);
    return () => clearTimeout(hide);
  }, [shown]);

  if (!shown || orbOpen || uiHidden || copilotOpen) return null;

  const openLuna = () => {
    setShown(false);
    useStage.getState().setOrbOpen(false);
    useStage.getState().setCopilotOpen(true);
  };

  return (
    <div
      role="status"
      className={`luna-hint absolute bottom-full mb-3 w-max max-w-64 ${side === 'start' ? 'start-0' : 'end-0'}`}
      data-testid="luna-hint"
    >
      <div className="flex items-center gap-2 rounded-xl border border-sun/60 bg-panel/95 py-2 ps-3 pe-1.5 text-sm shadow-xl backdrop-blur">
        <button type="button" onClick={openLuna} className="flex min-w-0 items-center gap-2 text-start">
          <span aria-hidden="true">✨</span>
          <span>
            <span className="block font-semibold text-ink">{t('hint.title')}</span>
            <span className="block text-xs text-quiet">{t('hint.text')}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => {
            setShown(false);
            setDismissed(true);
          }}
          aria-label={t('hint.dismiss')}
          className="grid size-7 shrink-0 place-items-center rounded-full text-quiet hover:bg-panel-raised hover:text-ink"
        >
          ×
        </button>
      </div>
      {/* The arrow, pointing down at the middle of the orb. */}
      <span
        aria-hidden="true"
        className={`absolute top-full -mt-1.5 size-3 rotate-45 border-e border-b border-sun/60 bg-panel ${
          side === 'start' ? 'start-[22px]' : 'end-[22px]'
        }`}
      />
    </div>
  );
}
