import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { pressedGold } from './Controls';

/** A button over the 3D view, as in the demo's layer bar: small and square-cornered, gold while it is on. */
export const viewButton = `min-h-8 rounded-md border border-line bg-panel-raised/92 px-2.5 text-[12.5px] hover:border-line-hover ${pressedGold}`;

/**
 * The view's display toggles, floating over its top-start corner. The top-end corner keeps the view's search or back
 * button, so the row stops short of it (`wide` leaves room for a search box) and drops below it on narrow screens.
 * Only the pills catch clicks; the gaps between them still reach the 3D view.
 */
export function ViewPills({ wide, below, children }: { wide?: boolean; below?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div
      className={`pointer-events-none absolute inset-s-3 inset-e-3 top-14 flex flex-col items-start gap-1.5 sm:top-3 ${wide ? 'sm:inset-e-72' : 'sm:inset-e-48'}`}
    >
      <fieldset
        aria-label={t('map.display')}
        className="flex flex-wrap items-center gap-1.5 *:pointer-events-auto"
        data-avoid
      >
        {children}
      </fieldset>
      {below && <div data-avoid>{below}</div>}
    </div>
  );
}

/** A short note over the 3D view. */
export const hintBox = 'max-w-2xl rounded-md bg-bar/80 px-2.5 py-1 text-center text-[12.5px] text-quiet';

/** How to use the view, centred along its bottom edge as in the demo, which also leaves it off a phone screen. */
export function ViewHint({ children }: { children: ReactNode }) {
  return (
    <p
      className={`pointer-events-none absolute inset-x-3 bottom-3.5 mx-auto w-fit max-sm:hidden ${hintBox}`}
      data-avoid
    >
      {children}
    </p>
  );
}
