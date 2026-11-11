import { DEFAULT_STAY } from '@siteline/contracts';
import type { Region } from '@siteline/engine';
import type { BestSpot } from '@siteline/physics';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { DAY_MS, physics, URLS } from '../physics';
import { useApp } from '../store';

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function BestSpots({ region }: { region: Region }) {
  const { t } = useTranslation();
  const [spots, setSpots] = useState<BestSpot[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    const { landingUtc, slipDays } = useApp.getState();
    setBusy(true);
    setError(undefined);
    try {
      const found = await physics.best(
        { centreLatDeg: region.lat, centreLonDeg: region.lon, sizeKm: region.sizeKm, grid: 9, top: 5 },
        { ...DEFAULT_STAY, landingUtc: new Date(Date.parse(landingUtc) + slipDays * DAY_MS).toISOString() },
        URLS,
      );
      setSpots(found);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        aria-label={t('best.find', { region: region.name })}
        title={t('best.find', { region: region.name })}
        className="min-h-9 rounded-md border border-line bg-panel-raised px-2.5 text-xs hover:border-line-hover disabled:opacity-60"
        onClick={() => (spots ? setSpots(undefined) : void run())}
      >
        {busy ? '…' : spots ? '×' : t('best.button')}
      </button>
      {(spots || error) && (
        <ol className="absolute inset-e-0 top-10 z-10 w-72 rounded-lg border border-line bg-panel p-2 text-sm shadow-xl">
          {error && <li className="text-fail">{error}</li>}
          {spots?.map((s, i) => (
            <li key={`${s.latDeg},${s.lonDeg}`}>
              <button
                type="button"
                className="flex min-h-9 w-full items-center justify-between gap-2 rounded px-2 text-start hover:bg-panel-raised"
                onClick={() => {
                  useApp.getState().focusSite(round4(s.latDeg), round4(s.lonDeg));
                  setSpots(undefined);
                }}
              >
                <span>
                  {i + 1}. {formatNumber(s.latDeg, 2)}°, {formatNumber(s.lonDeg, 2)}°
                </span>
                <span className={s.result.pass ? 'text-pass' : 'text-quiet'}>
                  {t('best.sun', { pct: formatNumber(s.result.sunFractionMin * 100, 0) })}
                </span>
              </button>
            </li>
          ))}
          {spots?.length === 0 && <li className="px-2 text-quiet">{t('best.none')}</li>}
        </ol>
      )}
    </div>
  );
}
