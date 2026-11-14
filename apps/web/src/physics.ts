import { DEFAULT_STAY, type StayQuery, type StayResult } from '@siteline/contracts';
import type { SolarBodyKey, Vec3 } from '@siteline/physics';
import * as Comlink from 'comlink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataUrls, PhysicsApi, StayResponse } from './physics.worker';
import { type MoonView, type Pin, useApp } from './store';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
export const URLS: DataUrls = {
  data: import.meta.env.VITE_DATA_URL ?? '/data',
  terrain: `${ASSETS}/data/terrain.json`,
  maps: `${ASSETS}/data/maps.json`,
  /*
   * LOLA's 30 m south pole terrain (PGDA product 90), read by byte ranges from the project's R2 copy: a tiled GeoTIFF
   * with overviews, which the worker reads around each site. The skyline every site is judged against: on the three
   * points we validate, the sunlight it gives agrees with NASA's own long-term maps (PGDA product 69) within a point
   * (horizon30m.validation.test.ts). Where it cannot be read, the worker falls back to the 1.2 km grid.
   */
  horizonTerrain:
    import.meta.env.VITE_TERRAIN_30M_URL ??
    'https://pub-950982926f534224a9e16061b39f6217.r2.dev/raw/lola/LDEM_75S_30MPP_ADJ.TIF',
  // LOLA's 10 m south pole terrain, for the slope. NASA's server lets no other site's page read it (no CORS), so the
  // reads go through the site's own `/pgda`: the dev and preview servers' proxy (vite.config.ts), and on the deployed
  // site a Pages Function (the repository's functions/pgda). A host without either names a copy that allows cross-site
  // reads in VITE_TERRAIN_10M_URL; if the reads fail, the slope says it needs finer terrain.
  fine: import.meta.env.VITE_TERRAIN_10M_URL ?? '/pgda/data/LOLA_20mpp/LDEM_83S_10MPP_ADJ.TIF',
};
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export const physics = Comlink.wrap<PhysicsApi>(
  new Worker(new URL('./physics.worker.ts', import.meta.url), { type: 'module' }),
);

export interface StayState extends Partial<StayResponse> {
  query?: StayQuery;
  error?: string;
  loading: boolean;
  /** Runs the check again, as after a failed fetch. */
  retry: () => void;
}

export function queryFor(site: Pin, landingUtc: string, slipDays: number): StayQuery {
  return {
    ...DEFAULT_STAY,
    site: { id: `moon:${site.latDeg},${site.lonDeg}`, body: 'moon', latDeg: site.latDeg, lonDeg: site.lonDeg },
    landingUtc: new Date(Date.parse(landingUtc) + slipDays * DAY_MS).toISOString(),
  };
}

/**
 * One stay check per question, shared by everything that shows it (the site report, the site's callout, the compare
 * table), so asking twice costs one run in the worker. A failed run is forgotten, so asking again tries again.
 */
/**
 * How long a stay check waits, once the rest is worked out, for the slope's tiles from the 10 m terrain: hardly at all
 * the first time, so the report shows at once, and then patiently, for the second ask that brings the slope.
 */
const SLOPE_QUICK_MS = 150;
const SLOPE_PATIENT_MS = 45_000;

const stays = new Map<string, Promise<StayResponse>>();
function stayOnce(query: StayQuery, fresh = false, slopeWaitMs = SLOPE_QUICK_MS): Promise<StayResponse> {
  const key = `${slopeWaitMs}|${JSON.stringify(query)}`;
  if (fresh) stays.delete(key);
  const known = stays.get(key);
  if (known) return known;
  const run = physics.stay(query, URLS, slopeWaitMs);
  stays.set(key, run);
  run.catch(() => stays.delete(key));
  // A day's worth of questions is plenty; drop the oldest beyond that.
  for (const old of stays.keys()) {
    if (stays.size <= 32) break;
    stays.delete(old);
  }
  return run;
}

/**
 * A stay check, and if its slope or its 30 m skyline was still on the way (a site's first read of either takes a few
 * seconds), the same check again once they are in: `use` gets each answer as it comes.
 */
async function stayThenSlope(query: StayQuery, fresh: boolean, use: (r: StayResponse) => void): Promise<void> {
  const first = await stayOnce(query, fresh);
  use(first);
  if (!first.slopePending && !first.terrainPending) return;
  use(
    await stayOnce(query, fresh, SLOPE_PATIENT_MS).catch(() => ({
      ...first,
      slopePending: false,
      terrainPending: false,
    })),
  );
}

export function useStay(): StayState {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const [state, setState] = useState<Omit<StayState, 'retry'>>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const asked = useRef(0);

  useEffect(() => {
    let live = true;
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    setState((s) => ({ ...s, error: undefined, loading: true }));
    // A retry asks the worker again rather than reuse what failed or what is cached.
    const fresh = attempt !== asked.current;
    asked.current = attempt;
    stayThenSlope(query, fresh, (response) => {
      if (live) setState({ query, ...response, loading: false });
    }).catch((e: unknown) => {
      if (live) setState({ query, error: e instanceof Error ? e.message : String(e), loading: false });
    });
    return () => {
      live = false;
    };
  }, [landingUtc, slipDays, latDeg, lonDeg, attempt]);

  return { ...state, retry };
}

/** The time-lapse loops over 30 days; its sunlight track runs a little longer, so an hour-rounded start still covers it. */
const TRACK_DAYS = 30.1;

/**
 * The share of the Sun's disc above the selected site's horizon across the time-lapse's 30 days: the same stay check as
 * the site report (the SPICE ephemeris against the LOLA terrain's horizon), run over 30 days instead of the stay's 6.5.
 * It starts at the landing hour, so the live clock's minutes do not ask again. Undefined until it arrives, and not
 * asked for at all until `wanted`.
 */
export function useSunTrack(wanted: boolean): StayResult['series'] | undefined {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const hourUtc = new Date(Math.floor(Date.parse(landingUtc) / HOUR_MS) * HOUR_MS).toISOString();
  const key = `${latDeg},${lonDeg},${hourUtc},${slipDays}`;
  const [track, setTrack] = useState<{ key: string; series: StayResult['series'] }>();

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    const query = { ...queryFor({ latDeg, lonDeg }, hourUtc, slipDays), stayDays: TRACK_DAYS };
    stayOnce(query).then(
      (r) => live && setTrack({ key, series: r.result.series }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [wanted, key, latDeg, lonDeg, hourUtc, slipDays]);

  return track?.key === key ? track.series : undefined;
}

/** Stay results for several sites at once, in the same order; entries are undefined until they arrive. */
export function useStayMany(pins: Pin[]): (StayResponse | undefined)[] {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  // The store hands out a fresh array on every change, so key the effect on the pins' values.
  const key = pins.map((s) => `${s.latDeg},${s.lonDeg}`).join(';');
  const sites = useMemo(
    () =>
      key
        .split(';')
        .filter(Boolean)
        .map((s) => s.split(',').map(Number))
        .map(([latDeg, lonDeg]) => ({ latDeg, lonDeg })),
    [key],
  );
  const [rows, setRows] = useState<(StayResponse | undefined)[]>([]);

  useEffect(() => {
    let live = true;
    // Keep the rows on screen while new ones are worked out (the live clock asks again each minute), unless the sites
    // themselves changed.
    setRows((old) => (old.length === sites.length ? old : sites.map(() => undefined)));
    const queries = sites.map((s) => queryFor(s, landingUtc, slipDays));
    Promise.all(queries.map((q) => stayOnce(q).catch(() => undefined))).then((all) => {
      if (!live) return;
      setRows(all);
      // A site whose slope was still on the way gets its row again once the slope is in.
      all.forEach((row, i) => {
        if (!row?.slopePending && !row?.terrainPending) return;
        stayOnce(queries[i], false, SLOPE_PATIENT_MS).then(
          (later) => live && setRows((rows) => rows.map((old, j) => (j === i ? later : old))),
          () => {},
        );
      });
    });
    return () => {
      live = false;
    };
  }, [sites, landingUtc, slipDays]);

  return rows;
}

/** The Moon's views, the only ones its launch slip moves. */
const SLIPPED_VIEWS: ReadonlySet<MoonView> = new Set<MoonView>(['globe', 'pole']);

/**
 * The time a view is lit for: the header's date plus the time-lapse offset, and on the Moon's views the launch slip
 * as well. The slip is the Moon's what-if, so the solar system, the Earth and Mars stay on the header's date with it.
 */
export function lightingUtcMsOf(
  s: Pick<ReturnType<typeof useApp.getState>, 'landingUtc' | 'slipDays' | 'playOffsetH' | 'view'>,
): number {
  const slipMs = SLIPPED_VIEWS.has(s.view) ? s.slipDays * DAY_MS : 0;
  return Date.parse(s.landingUtc) + slipMs + s.playOffsetH * HOUR_MS;
}

/** The time the current 3D view is lit for (`lightingUtcMsOf`). */
export function useLightingUtcMs(): number {
  return useApp(lightingUtcMsOf);
}

/**
 * Follows the time the current view is lit for without re-rendering anything: `ask` turns a time into what the view
 * needs (from the physics worker) and `apply` hands the answer to the view, now and after every change. The time-lapse
 * changes the time on every frame, and a 3D view that re-rendered its React tree that often made the page stutter, so
 * the views follow the store directly. At most one ask is in flight; when it returns, the next one takes the newest
 * time. Returns the function that stops following.
 */
export function followLighting<T>(
  ask: (tUtcMs: number) => Promise<T>,
  apply: (value: T) => void,
  onError?: (e: unknown) => void,
): () => void {
  let stopped = false;
  let busy = false;
  let askedMs = Number.NaN;
  const next = () => {
    if (stopped || busy) return;
    const tUtcMs = lightingUtcMsOf(useApp.getState());
    if (tUtcMs === askedMs) return;
    busy = true;
    askedMs = tUtcMs;
    ask(tUtcMs).then(
      (value) => {
        busy = false;
        if (stopped) return;
        apply(value);
        next();
      },
      (e: unknown) => {
        busy = false;
        if (stopped) return;
        onError?.(e);
        next();
      },
    );
  };
  const unsubscribe = useApp.subscribe(next);
  next();
  return () => {
    stopped = true;
    unsubscribe();
  };
}

/**
 * Where every planet and the Moon are (km, from the planets table) at the whole hour the views are lit for; undefined
 * until they arrive or if the table cannot be read. Whole hours: in one the Moon moves about 270 km, 0.001 s of signal,
 * so the time-lapse need not ask the worker on every frame; while it plays, whole days.
 */
export function usePlanetsAtHour(): Readonly<Record<SolarBodyKey, Vec3>> | undefined {
  return usePlanetsAtHourState().positions;
}

export interface PlanetsState {
  positions?: Readonly<Record<SolarBodyKey, Vec3>>;
  /** Why the table could not be read, if it could not. */
  error?: string;
  retry: () => void;
}

/** `usePlanetsAtHour`, with the failure and a way to ask again. */
export function usePlanetsAtHourState(): PlanetsState {
  // The whole hour itself is what the component follows, not the time, so the clock does not re-render it every frame.
  // While the time-lapse plays, the whole day: the distances and delays shown barely move in a day, and asking 24 times
  // a second (at a day a second) kept the panel re-rendering. Pausing lands back on the hour.
  const hourMs = useApp((s) => {
    const stepMs = s.playing ? DAY_MS : HOUR_MS;
    return Math.floor(lightingUtcMsOf(s) / stepMs) * stepMs;
  });
  const [state, setState] = useState<Omit<PlanetsState, 'retry'>>({});
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `attempt` is what asks again.
  useEffect(() => {
    let live = true;
    physics.planetsAt(hourMs, URLS.data).then(
      (positions) => live && setState({ positions }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [hourMs, attempt]);
  return { ...state, retry };
}
