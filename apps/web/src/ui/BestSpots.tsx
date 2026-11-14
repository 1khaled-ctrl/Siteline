import { DEFAULT_STAY } from '@siteline/contracts';
import type { BestSearch } from '@siteline/physics';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { DAY_MS, physics, URLS } from '../physics';
import type { PassingSearch, PassingSite } from '../physics.worker';
import { useApp } from '../store';
import { PanelError } from './ViewStatus';

/** A region to search: where it is and how wide. */
export interface SearchArea {
  name: string;
  lat: number;
  lon: number;
  sizeKm: number;
}

/** The landing date the site report checks, with the slip: the search checks the same stay. */
function stayQuery() {
  const { landingUtc, slipDays } = useApp.getState();
  return { ...DEFAULT_STAY, landingUtc: new Date(Date.parse(landingUtc) + slipDays * DAY_MS).toISOString() };
}

/** Sites in one area that pass all four checks, by the site report's own verdict. */
export function searchArea(area: SearchArea, top = 3): Promise<PassingSearch> {
  const search: BestSearch = { centreLatDeg: area.lat, centreLonDeg: area.lon, sizeKm: area.sizeKm, top };
  return physics.passing(search, stayQuery(), URLS);
}

/** One passing site, as a row that flies to it and opens its report. */
export function PassingRow({ site, label, onPick }: { site: PassingSite; label: string; onPick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="flex min-h-11 w-full flex-col items-start gap-0.5 rounded px-2 py-1 text-start hover:bg-panel-raised"
      onClick={() => {
        useApp.getState().focusSite(site.latDeg, site.lonDeg);
        onPick();
      }}
    >
      <span>
        <span className="text-pass">✓ </span>
        {label} {formatNumber(Math.abs(site.latDeg), 2)}° S, {formatNumber(site.lonDeg, 2)}°
      </span>
      <span className="font-mono text-xs text-quiet">
        {t('best.readings', {
          sun: formatNumber(site.sunFractionMin * 100, 0),
          earth: formatNumber(site.earthVisiblePct, 0),
          slope: formatNumber(site.slope100mDeg, 1),
        })}
      </span>
    </button>
  );
}

/**
 * A region's search for landing sites that pass all four checks for the landing date: Sun up for the whole stay,
 * Earth in view, a landing slope under 10° and within 6° of the pole. Every site it lists has been through the site
 * report's own check, so picking one opens a report that passes.
 */
export function BestSpots({ region }: { region: SearchArea }) {
  const { t } = useTranslation();
  const [found, setFound] = useState<PassingSearch>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setFound(await searchArea(region));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const open = Boolean(found || error);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        aria-expanded={open}
        aria-label={open ? t('best.close', { region: region.name }) : t('best.find', { region: region.name })}
        title={open ? t('best.close', { region: region.name }) : t('best.find', { region: region.name })}
        className="min-h-9 rounded-md border border-line bg-panel-raised px-2.5 text-xs hover:border-line-hover disabled:opacity-60"
        onClick={() => {
          if (open) {
            setFound(undefined);
            setError(undefined);
          } else void run();
        }}
      >
        {busy ? t('best.searching') : open ? '×' : t('best.button')}
      </button>
      {open && (
        <ol className="absolute inset-e-0 top-10 z-10 w-72 rounded-lg border border-line bg-panel p-2 text-sm shadow-xl">
          {error && (
            <li>
              <PanelError title={t('status.panel.best')} reason={error} onRetry={() => void run()} />
            </li>
          )}
          {found?.sites.map((s, i) => (
            <li key={`${s.latDeg},${s.lonDeg}`}>
              <PassingRow site={s} label={`${i + 1}.`} onPick={() => setFound(undefined)} />
            </li>
          ))}
          {found && found.sites.length === 0 && (
            <li className="px-2 py-1 text-quiet">{t('best.none', { region: region.name, checked: found.checked })}</li>
          )}
        </ol>
      )}
    </div>
  );
}

/**
 * The same search over every region, one after another: the best passing sites across all of them, each with its
 * region, and a count while it works.
 */
export function SearchAll({ regions }: { regions: readonly SearchArea[] }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ done: number; sites: (PassingSite & { region: string })[]; checked: number }>();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    const all: (PassingSite & { region: string })[] = [];
    let checked = 0;
    setState({ done: 0, sites: [], checked: 0 });
    for (const [i, r] of regions.entries()) {
      const found = await searchArea(r, 2).catch(() => undefined);
      checked += found?.checked ?? 0;
      all.push(...(found?.sites ?? []).map((s) => ({ ...s, region: r.name })));
      all.sort((a, b) => b.sunFractionMin - a.sunFractionMin || b.earthVisiblePct - a.earthVisiblePct);
      setState({ done: i + 1, sites: all.slice(0, 5), checked });
    }
    setBusy(false);
  };

  return (
    <div className="mb-3 flex flex-col gap-2">
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        className="min-h-11 rounded-md border border-pass/50 bg-panel-raised px-3 text-sm hover:border-pass disabled:opacity-70"
        onClick={() => void run()}
      >
        {busy ? t('best.allSearching', { done: state?.done ?? 0, of: regions.length }) : t('best.all')}
      </button>
      {state && (
        <ol className="rounded-lg border border-line bg-panel-sunk p-1.5 text-sm" aria-live="polite">
          {state.sites.map((s) => (
            <li key={`${s.latDeg},${s.lonDeg}`}>
              <PassingRow site={s} label={`${s.region},`} onPick={() => {}} />
            </li>
          ))}
          {!busy && state.sites.length === 0 && (
            <li className="px-2 py-1 text-quiet">{t('best.allNone', { checked: state.checked })}</li>
          )}
        </ol>
      )}
    </div>
  );
}
