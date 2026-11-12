import {
  directionToLatLon,
  type LanderBody,
  missionPlace,
  parseSites,
  parseTracks,
  type SitePatchMeta,
  type SitesJson,
  type Tracks,
  type TracksJson,
} from '@siteline/engine';
import { useEffect, useRef, useState } from 'react';
import { findLander, MISSIONS, SITES_URL, TRACKS_URL } from './landers';
import { DAY_MS, physics, URLS, useLightingUtcMs } from './physics';
import { useApp } from './store';

interface LanderFiles {
  tracks?: Tracks;
  sites?: Record<string, SitePatchMeta>;
}

let files: Promise<LanderFiles> | undefined;

async function read<T>(url: string): Promise<T | undefined> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

function loadFiles(): Promise<LanderFiles> {
  files ??= Promise.all([read<TracksJson>(TRACKS_URL), read<SitesJson>(SITES_URL)]).then(([tracks, sites]) => {
    // A file that did not arrive is asked for again by the next view that wants it, not given up on for good.
    if (!tracks || !sites) files = undefined;
    return { tracks: tracks && parseTracks(tracks), sites: sites && parseSites(sites) };
  });
  return files;
}

/** The rover routes and the close-up headers, once they have arrived; each stays undefined if its file is missing. */
export function useLanderFiles(): LanderFiles {
  const [loaded, setLoaded] = useState<LanderFiles>({});
  useEffect(() => {
    let live = true;
    void loadFiles().then((f) => {
      if (live) setLoaded(f);
    });
    return () => {
      live = false;
    };
  }, []);
  return loaded;
}

export interface Subsolar {
  latDeg: number;
  lonDeg: number;
}

/**
 * The point on the Moon or Mars the Sun is straight above, at the time the map is lit for. While the time-lapse plays
 * it is refreshed at most every 200 ms, so the cards keep up without asking the physics worker on every frame.
 */
export function useSubsolar(body: LanderBody): Subsolar | undefined {
  const tUtcMs = useLightingUtcMs();
  const [point, setPoint] = useState<Subsolar>();
  const last = useRef(0);
  useEffect(() => {
    let live = true;
    const wait = Math.max(0, last.current + 200 - performance.now());
    const timer = setTimeout(() => {
      last.current = performance.now();
      const ask =
        body === 'Moon' ? physics.sunKm(tUtcMs, URLS.data).then(directionToLatLon) : physics.marsSun(tUtcMs, URLS.data);
      ask.then(
        (p) => live && setPoint(p),
        () => live && setPoint(undefined),
      );
    }, wait);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [body, tUtcMs]);
  return point;
}

/**
 * The date the landers are judged against: the landing date picked, with any slip. A lander that lands after it is
 * drawn dashed. The time-lapse does not move it, so the pins stay put while the Sun moves.
 */
export function useShownUtcMs(): number {
  const landingUtc = useApp((s) => s.landingUtc);
  const slipDays = useApp((s) => s.slipDays);
  return Date.parse(landingUtc) + slipDays * DAY_MS;
}

/**
 * Fly a 3D view to the open lander whenever the list, a pin or the card's button asks (the store counts the asks), and
 * once the view exists if the ask came first, as when a lander is picked from the solar-system view.
 */
export function useFlyToMission(body: LanderBody, fly: ((latDeg: number, lonDeg: number) => void) | undefined): void {
  const seq = useApp((s) => s.missionFlySeq);
  const missionId = useApp((s) => s.missionId);
  const { tracks } = useLanderFiles();
  const shownMs = useShownUtcMs();
  const mission = missionId ? findLander(missionId) : undefined;
  const target = useRef<Subsolar | undefined>(undefined);
  const flight = useRef(fly);
  target.current = mission?.body === body ? missionPlace(MISSIONS, mission, tracks, shownMs) : undefined;
  flight.current = fly;
  const ready = fly !== undefined;
  useEffect(() => {
    if (ready && seq > 0 && target.current) flight.current?.(target.current.latDeg, target.current.lonDeg);
  }, [ready, seq]);
}
