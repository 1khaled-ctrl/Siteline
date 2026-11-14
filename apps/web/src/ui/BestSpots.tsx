import { DEFAULT_STAY } from '@siteline/contracts';
import type { BestSearch } from '@siteline/physics';
import * as Comlink from 'comlink';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { touchdownUtcMsOf } from '../land';
import { physics, URLS } from '../physics';
import type { PassingSearch, PassingSite } from '../physics.worker';
import { useApp } from '../store';
import { LandHereButton } from './LandHere';
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
  return { ...DEFAULT_STAY, landingUtc: new Date(touchdownUtcMsOf(landingUtc, slipDays)).toISOString() };
}

/**
 * Sites in one area that pass all four checks, by the site report's own verdict. `onSite` hears of each the moment it
 * is confirmed.
 */
export function searchArea(area: SearchArea, top = 3, onSite?: (site: PassingSite) => void): Promise<PassingSearch> {
  const search: BestSearch = { centreLatDeg: area.lat, centreLonDeg: area.lon, sizeKm: area.sizeKm, top };
  return physics.passing(search, stayQuery(), URLS, onSite && Comlink.proxy(onSite));
}

/** Searched first: the regions where passing sites turn up most, so the first one shows within seconds. */
const LIKELIEST = ['Mons Mouton', 'Mons Mouton Plateau', 'Nobile Rim 2'];

type FoundSite = PassingSite & { region: string; regionIndex: number };

/**
 * Best first: the most sunlight, then the most Earth. Ties keep the regions' own order, then the flatter site, so the
 * list does not depend on which region was searched first or which answer arrived first.
 */
const byBest = (a: FoundSite, b: FoundSite) =>
  b.sunFractionMin - a.sunFractionMin ||
  b.earthVisiblePct - a.earthVisiblePct ||
  a.regionIndex - b.regionIndex ||
  a.slope100mDeg - b.slope100mDeg;

/**
 * One passing site, as a row that flies to it and opens its report, with Land Here beside it: the search's exact point,
 * at the moment the search checked.
 */
export function PassingRow({
  site,
  label,
  onPick,
  name,
}: {
  site: PassingSite;
  label: string;
  onPick: () => void;
  /** The search region's name, for the surface view's title. */
  name?: string;
}) {
  const { t } = useTranslation();
  const { landingUtc, slipDays } = useApp.getState();
  const pick = () => {
    useApp.getState().focusSite(site.latDeg, site.lonDeg);
    onPick();
  };
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="flex min-h-11 min-w-0 flex-1 flex-col items-start gap-0.5 rounded px-2 py-1 text-start hover:bg-panel-raised"
        onClick={pick}
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
      <LandHereButton
        compact
        latDeg={site.latDeg}
        lonDeg={site.lonDeg}
        touchdownUtcMs={touchdownUtcMsOf(landingUtc, slipDays)}
        name={name}
        source={{
          kind: 'passing',
          sunFractionMin: site.sunFractionMin,
          earthVisiblePct: site.earthVisiblePct,
          slope100mDeg: site.slope100mDeg,
        }}
        onLand={pick}
      />
    </div>
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
              <PassingRow site={s} label={`${i + 1}.`} name={region.name} onPick={() => setFound(undefined)} />
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
 * The same search over every region, likeliest first: the best passing sites across all of them, each with its region,
 * listed the moment each is confirmed, and a count of regions while it works.
 */
export function SearchAll({ regions }: { regions: readonly SearchArea[] }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ done: number; sites: FoundSite[]; checked: number }>();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    let all: FoundSite[] = [];
    let checked = 0;
    let done = 0;
    const show = () => setState({ done, sites: [...all].sort(byBest).slice(0, 5), checked });
    show();
    const rank = (name: string) => {
      const i = LIKELIEST.indexOf(name);
      return i < 0 ? LIKELIEST.length : i;
    };
    const order = regions.map((r, regionIndex) => ({ r, regionIndex })).sort((a, b) => rank(a.r.name) - rank(b.r.name));
    for (const { r, regionIndex } of order) {
      const tag = (s: PassingSite): FoundSite => ({ ...s, region: r.name, regionIndex });
      const found = await searchArea(r, 2, (s) => {
        all.push(tag(s));
        show();
      }).catch(() => undefined);
      // The region's reply is the word on it: the sites it streamed, or none if it failed part way.
      all = [...all.filter((s) => s.regionIndex !== regionIndex), ...(found?.sites ?? []).map(tag)];
      checked += found?.checked ?? 0;
      done++;
      show();
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
              <PassingRow site={s} label={`${s.region},`} name={s.region} onPick={() => {}} />
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
