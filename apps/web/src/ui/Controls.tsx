import { DEFAULT_STAY } from '@siteline/contracts';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { DAY_MS, HOUR_MS, useSunTrack } from '../physics';
import { REGIONS } from '../regions';
import { sunAt } from '../sound/maps';
import { MAX_SLIP_DAYS, PLAY_SPEEDS_H_PER_S, useApp } from '../store';
import { BestSpots } from './BestSpots';
import { Compare } from './Compare';

/** One section of the floating panel: unboxed, as in the demo, so only its heading and spacing set it apart. */
export const panel = 'min-w-0';
/** A raised box inside the panel, for a group of controls or one reading. */
export const box = 'rounded-lg border border-line bg-panel-raised p-3';
const input = 'mt-1 block w-full min-h-11 rounded-md border border-line bg-panel-sunk px-3';
/** The gold that marks a toggle that is on, here and on the buttons over the 3D view. */
export const pressedGold = 'aria-pressed:border-sun aria-pressed:bg-sun-wash aria-pressed:text-sun-ink';
export const smallButton = `min-h-9 rounded-md border border-line bg-panel-raised px-3 text-sm hover:border-line-hover ${pressedGold}`;
/** A filter in a row of filters: a small pill. */
export const chipButton = `min-h-8 rounded-pill border border-line bg-panel-raised px-2.5 text-xs hover:border-line-hover ${pressedGold}`;

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

/** The landing date, the launch slip and the time-lapse, boxed together as in the demo's launch-delay box. */
export function LandingTime() {
  const { t } = useTranslation();
  const { landingUtc, slipDays, set, playing, speedHPerS, playOffsetH, setPlay } = useApp();
  const slipId = useId();
  const lapse = playing || playOffsetH > 0;
  const track = useSunTrack(lapse);
  // The share of the Sun's disc above the site's horizon at the time-lapse's moment, shown beside Play.
  const sunNow = track ? sunAt(track, Date.parse(landingUtc) + slipDays * DAY_MS + playOffsetH * HOUR_MS) : Number.NaN;

  return (
    <section className={`${box} flex flex-col gap-4`}>
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
          className="mt-2 w-full accent-sun"
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
          className="min-h-9 rounded-md border border-line bg-panel-sunk px-3 text-sm"
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
      {lapse && Number.isFinite(sunNow) && (
        <div className="flex flex-col gap-1.5">
          <p className="flex flex-wrap justify-between gap-x-2 text-sm">
            <span>{t('time.sunNow')}</span>
            <span className="font-mono text-sun">{formatNumber(sunNow * 100, 0)}%</span>
          </p>
          <div className="h-1.5 overflow-hidden rounded-pill bg-panel-sunk" aria-hidden="true">
            <div className="h-full rounded-pill bg-sun" style={{ width: `${Math.round(sunNow * 100)}%` }} />
          </div>
        </div>
      )}
      <p className="text-xs text-quiet">
        {playOffsetH > 0
          ? t('time.lightingAt', { days: formatNumber(playOffsetH / 24, 1) })
          : t('time.lightingLanding')}
      </p>
    </section>
  );
}

/** The Moon's site picker: the latitude and longitude, the comparison and the named regions. */
export function Controls() {
  const { t } = useTranslation();
  const { latDeg, lonDeg, set, focusSite } = useApp();

  return (
    <div className="flex flex-col gap-5">
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
                className="min-h-10 flex-1 rounded-md border border-line bg-panel-raised px-3 text-start hover:border-line-hover"
                onClick={() => focusSite(r.lat, r.lon)}
              >
                {r.name}
              </button>
              <BestSpots region={r} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
