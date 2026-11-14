import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { coverageAt, gridReachLatDeg, type LandingSource, TERRAIN_EXTENT } from '../land';
import { useApp } from '../store';
import { smallButton } from './Controls';
import { Spinner } from './ViewStatus';

interface Props {
  latDeg: number;
  lonDeg: number;
  /** The touchdown moment, with the launch slip already in it (see `land.ts`). */
  touchdownUtcMs: number;
  source: LandingSource;
  name?: string;
  /** The small form for a row in a list. */
  compact?: boolean;
  /** Runs just before landing, as selecting the point on the map so it is there on the way back. */
  onLand?: () => void;
}

/** A small "landing" glyph: a lander's legs over the ground. */
function LanderGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M5 3.5h6l1 3.5H4z" fill="currentColor" fillOpacity="0.2" />
      <path d="M4.5 7 2.5 12M11.5 7l2 5M8 7v2.5M1.5 13.5h13" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Land Here: opens the surface view at exactly this point and moment. Offered only where the south-pole terrain
 * reaches; elsewhere it says why, rather than landing somewhere else.
 */
export function LandHereButton({ latDeg, lonDeg, touchdownUtcMs, source, name, compact = false, onLand }: Props) {
  const { t } = useTranslation();
  const coverage = coverageAt(latDeg, lonDeg);
  const place = `${formatNumber(Math.abs(latDeg), 4)}° ${latDeg < 0 ? t('landers.south') : t('landers.north')}, ${formatNumber(Math.abs(lonDeg), 4)}° ${lonDeg < 0 ? t('landers.west') : t('landers.east')}`;
  const land = () => {
    onLand?.();
    useApp.getState().setLanding({ latDeg, lonDeg, touchdownUtcMs, source, name });
  };
  const reach = formatNumber(Math.abs(gridReachLatDeg(TERRAIN_EXTENT.coarse.halfM)), 0);

  if (compact)
    return (
      <button
        type="button"
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-line bg-panel-raised px-2.5 text-xs text-sun-ink hover:border-sun disabled:opacity-50"
        disabled={coverage === 'none'}
        aria-label={t('land.buttonLabel', { place })}
        title={coverage === 'none' ? t('land.outsideHint', { lat: reach }) : t('land.buttonLabel', { place })}
        onClick={land}
        data-testid="land-here-row"
      >
        <LanderGlyph />
        {t('land.buttonShort')}
      </button>
    );

  return (
    <div>
      <button
        type="button"
        className={`${smallButton} inline-flex w-full items-center justify-center gap-1.5 border-sun/60 text-sun-ink hover:border-sun disabled:border-line disabled:text-quiet`}
        disabled={coverage === 'none'}
        aria-describedby={coverage === 'fine' ? undefined : 'land-here-note'}
        onClick={land}
        data-testid="land-here"
      >
        <LanderGlyph />
        {t('land.button')}
      </button>
      {coverage !== 'fine' && (
        <p id="land-here-note" className="mt-1 text-xs text-quiet">
          {coverage === 'none' ? t('land.outsideHint', { lat: reach }) : t('land.coarseHint')}
        </p>
      )}
    </div>
  );
}

/** What shows while the surface view's code itself loads, the first time. */
export function SurfaceLoading() {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black text-ink" role="status">
      <p className="flex items-center gap-2 text-sm">
        <Spinner />
        {t('land.loadingTitle')}
      </p>
    </div>
  );
}
