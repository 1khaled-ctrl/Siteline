import { DEFAULT_STAY } from '@siteline/contracts';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { REGIONS } from '../regions';
import { MAX_SLIP_DAYS, PLAY_SPEEDS_H_PER_S, useApp } from '../store';
import { BestSpots } from './BestSpots';
import { Compare } from './Compare';

export const panel = 'rounded-xl border border-white/10 bg-panel/72 p-4 backdrop-blur-md';
const input = 'mt-1 block w-full min-h-11 rounded-lg border border-white/15 bg-space/60 px-3';
export const smallButton = 'min-h-9 rounded-lg border border-white/15 px-3 text-sm hover:border-accent';

function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const commit = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v)) onCommit(v);
  };
  return (
    <label className="block text-sm text-quiet">
      {label}
      <input
        key={value}
        dir="ltr"
        inputMode="decimal"
        defaultValue={value}
        className={`${input} text-ink`}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
        }}
      />
    </label>
  );
}

export function Controls() {
  const { t } = useTranslation();
  const { landingUtc, slipDays, latDeg, lonDeg, set, focusSite, playing, speedHPerS, playOffsetH, setPlay } = useApp();
  const slipId = useId();

  return (
    <aside className="flex flex-col gap-4">
      <section className={`${panel} flex flex-col gap-4`}>
        <label className="block text-sm text-quiet">
          {t('time.landing')}
          <input
            type="datetime-local"
            dir="ltr"
            min="2026-01-01T00:00"
            max="2035-12-31T23:59"
            value={landingUtc.slice(0, 16)}
            className={`${input} text-ink`}
            onChange={(e) => set({ landingUtc: `${e.currentTarget.value}:00Z` })}
          />
        </label>
        <div>
          <label htmlFor={slipId} className="flex justify-between text-sm text-quiet">
            <span>{t('time.slip')}</span>
            <span className="text-ink">{t('time.slipDays', { count: slipDays })}</span>
          </label>
          <input
            id={slipId}
            type="range"
            dir="ltr"
            min={-MAX_SLIP_DAYS}
            max={MAX_SLIP_DAYS}
            step={1}
            value={slipDays}
            aria-valuetext={t('time.slipDays', { count: slipDays })}
            className="mt-2 w-full accent-accent"
            onChange={(e) => set({ slipDays: e.currentTarget.valueAsNumber })}
          />
        </div>
        <p className="text-sm text-quiet">{t('time.stay', { days: formatNumber(DEFAULT_STAY.stayDays) })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={smallButton} onClick={() => setPlay({ playing: !playing })}>
            {playing ? t('time.pause') : t('time.play')}
          </button>
          <select
            aria-label={t('time.speed')}
            value={speedHPerS}
            className="min-h-9 rounded-lg border border-white/15 bg-space/60 px-2 text-sm"
            onChange={(e) => setPlay({ speedHPerS: Number(e.currentTarget.value) })}
          >
            {PLAY_SPEEDS_H_PER_S.map((s) => (
              <option key={s} value={s}>
                {t('time.speedOption', { hours: s })}
              </option>
            ))}
          </select>
          {playOffsetH > 0 && (
            <button type="button" className={smallButton} onClick={() => setPlay({ playing: false, playOffsetH: 0 })}>
              {t('time.reset')}
            </button>
          )}
        </div>
        <p className="text-xs text-quiet">
          {playOffsetH > 0
            ? t('time.lightingAt', { days: formatNumber(playOffsetH / 24, 1) })
            : t('time.lightingLanding')}
        </p>
      </section>

      <section className={panel}>
        <h2 className="mb-3 font-semibold">{t('site.heading')}</h2>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label={t('site.lat')} value={latDeg} onCommit={(v) => set({ latDeg: v })} />
          <NumberField label={t('site.lon')} value={lonDeg} onCommit={(v) => set({ lonDeg: v })} />
        </div>
        <p className="mt-2 text-xs text-quiet">{t('site.hint')}</p>
      </section>

      <Compare />

      <section className={panel}>
        <h2 className="mb-2 font-semibold">{t('regions.heading')}</h2>
        <ul className="grid gap-1">
          {REGIONS.map((r) => (
            <li key={r.name} className="flex items-center gap-1">
              <button
                type="button"
                className="min-h-11 flex-1 rounded-lg px-3 text-start hover:bg-white/5 focus-visible:bg-white/5"
                onClick={() => focusSite(r.lat, r.lon)}
              >
                {r.name}
              </button>
              <BestSpots region={r} />
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
