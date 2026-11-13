import { animate, motion, useDragControls, useMotionValue } from 'motion/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBoot } from '../boot';
import { useShort, useStage } from '../stage';

/** How much of the sheet shows when it is down: its handle and the one line about the view (less on a short screen). */
export const PEEK_PX = 104;
const SHORT_PEEK_PX = 76;

type Stop = 'peek' | 'half' | 'open';
const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The panel on a phone: a glass sheet over the 3D view that peeks up from the bottom with one key number for the view,
 * opens halfway or all the way with a swipe up (or a tap on the handle), and goes back down with a swipe down. Only
 * the handle drags it, so the cards inside scroll as usual. Moving the keyboard into it opens it.
 */
export function Sheet({ peek, label, children }: { peek: ReactNode; label: string; children: ReactNode }) {
  const { t } = useTranslation();
  const sheet = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const [stop, setStop] = useState<Stop>('peek');
  const y = useMotionValue(10_000);
  const drag = useDragControls();
  const setSheetOpen = useStage((s) => s.setSheetOpen);
  const peekPx = useShort() ? SHORT_PEEK_PX : PEEK_PX;

  const yOf = useCallback(
    (s: Stop) => (s === 'open' ? 0 : s === 'half' ? Math.round(height * 0.48) : Math.max(0, height - peekPx)),
    [height, peekPx],
  );

  const go = useCallback(
    (s: Stop) => {
      setStop(s);
      setSheetOpen(s !== 'peek');
      animate(y, yOf(s), calm() ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 42 });
    },
    [y, yOf, setSheetOpen],
  );

  // Keep the sheet's size, and its place, as the phone turns or the address bar comes and goes.
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const opened = useBoot((s) => s.opened);
  // The stop, for the size effect below to read without re-running on every stop change (go() animates those).
  const at = useRef<Stop>('peek');
  at.current = stop;
  useEffect(() => {
    if (!height) return;
    // Below the screen until the opening hands over, then up into place; after that, a new size keeps the stop.
    if (!opened) y.set(height);
    else if (y.get() >= height - 1 && !calm())
      animate(y, yOf(at.current), { type: 'spring', stiffness: 260, damping: 30 });
    else y.set(yOf(at.current));
  }, [height, y, yOf, opened]);
  useEffect(() => () => setSheetOpen(false), [setSheetOpen]);

  /** Where a flick ends: the stop nearest to where the sheet would coast to. */
  const settle = (velocityY: number) => {
    const aim = y.get() + velocityY * 0.2;
    const stops: Stop[] = ['open', 'half', 'peek'];
    go(stops.reduce((best, s) => (Math.abs(yOf(s) - aim) < Math.abs(yOf(best) - aim) ? s : best)));
  };

  return (
    <motion.div
      ref={sheet}
      className="sheet glass absolute inset-x-0 top-10 bottom-0 z-20 flex flex-col rounded-b-none"
      style={{ y }}
      drag="y"
      dragListener={false}
      dragControls={drag}
      dragConstraints={{ top: 0, bottom: yOf('peek') }}
      dragElastic={0.08}
      dragMomentum={false}
      onDragEnd={(_, info) => settle(info.velocity.y)}
      data-testid="sheet"
      data-stop={stop}
    >
      {/* The handle: drag it, or tap it to open and close. */}
      <div
        className="sheet-handle shrink-0 cursor-grab touch-none px-4 pt-2 pb-3 active:cursor-grabbing"
        onPointerDown={(e) => drag.start(e)}
      >
        <button
          type="button"
          className="mx-auto mb-2 block h-5 w-16 rounded-pill"
          aria-expanded={stop !== 'peek'}
          aria-controls="panel"
          aria-label={stop === 'peek' ? t('sheet.open') : t('sheet.close')}
          onClick={() => go(stop === 'peek' ? 'half' : 'peek')}
        >
          <span className="mx-auto block h-1 w-10 rounded-pill bg-quiet/60" />
        </button>
        {peek}
      </div>
      <aside
        id="panel"
        tabIndex={-1}
        aria-label={label}
        className="hud-sheet flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3"
        // The part below the screen's edge stays reachable: pad the end by however far down the sheet sits.
        style={{ paddingBottom: yOf(stop) + 16 }}
        onFocus={() => stop === 'peek' && go('half')}
      >
        {children}
      </aside>
    </motion.div>
  );
}
