import { DEFAULT_STAY, type StayQuery } from '@siteline/contracts';
import type { SolarBodyKey, Vec3 } from '@siteline/physics';
import * as Comlink from 'comlink';
import { useEffect, useMemo, useState } from 'react';
import type { DataUrls, PhysicsApi, StayResponse } from './physics.worker';
import { type Pin, useApp } from './store';

const ASSETS = import.meta.env.VITE_ASSETS_URL ?? '/landfall';
export const URLS: DataUrls = {
  data: import.meta.env.VITE_DATA_URL ?? '/data',
  terrain: `${ASSETS}/data/terrain.json`,
  maps: `${ASSETS}/data/maps.json`,
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
}

function queryFor(site: Pin, landingUtc: string, slipDays: number): StayQuery {
  return {
    ...DEFAULT_STAY,
    site: { id: `moon:${site.latDeg},${site.lonDeg}`, body: 'moon', latDeg: site.latDeg, lonDeg: site.lonDeg },
    landingUtc: new Date(Date.parse(landingUtc) + slipDays * DAY_MS).toISOString(),
  };
}

export function useStay(): StayState {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  const latDeg = useApp((s) => s.latDeg);
  const lonDeg = useApp((s) => s.lonDeg);
  const [state, setState] = useState<StayState>({ loading: true });

  useEffect(() => {
    let live = true;
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    setState((s) => ({ ...s, loading: true }));
    physics.stay(query, URLS).then(
      (response) => {
        if (live) setState({ query, ...response, loading: false });
      },
      (e: unknown) => {
        if (live) setState({ query, error: e instanceof Error ? e.message : String(e), loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [landingUtc, slipDays, latDeg, lonDeg]);

  return state;
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
    setRows(sites.map(() => undefined));
    Promise.all(sites.map((s) => physics.stay(queryFor(s, landingUtc, slipDays), URLS).catch(() => undefined))).then(
      (all) => {
        if (live) setRows(all);
      },
    );
    return () => {
      live = false;
    };
  }, [sites, landingUtc, slipDays]);

  return rows;
}

/** The time the 3D views are lit for: landing plus slip, plus the time-lapse offset. */
export function useLightingUtcMs(): number {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  const playOffsetH = useApp((s) => s.playOffsetH);
  return Date.parse(landingUtc) + slipDays * DAY_MS + playOffsetH * HOUR_MS;
}

/**
 * Where every planet and the Moon are (km, from the planets table) at the whole hour the views are lit for; undefined
 * until they arrive or if the table cannot be read. Whole hours: in one the Moon moves about 270 km, 0.001 s of signal,
 * so the time-lapse need not ask the worker on every frame.
 */
export function usePlanetsAtHour(): Readonly<Record<SolarBodyKey, Vec3>> | undefined {
  const hourMs = Math.floor(useLightingUtcMs() / HOUR_MS) * HOUR_MS;
  const [positions, setPositions] = useState<Readonly<Record<SolarBodyKey, Vec3>>>();
  useEffect(() => {
    let live = true;
    physics.planetsAt(hourMs, URLS.data).then(
      (p) => live && setPositions(p),
      () => live && setPositions(undefined),
    );
    return () => {
      live = false;
    };
  }, [hourMs]);
  return positions;
}
