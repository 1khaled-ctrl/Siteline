import type { StayQuery } from '@siteline/contracts';
import { moonDistanceKm, type RobotFit, type RobotNeeds, robotFit } from '@siteline/physics';
import { MISSIONS } from './landers';
import type { StayResponse } from './physics.worker';

/**
 * The robots a site can be read against. Each need is set only as far as a source says it: a field the source does
 * not give is 'unknown', and the fit then answers "not enough data" rather than a pass. Each `why` names the source
 * (its id in CREDITS.md) and where in it, so the card can show it. These are published concepts and mission criteria,
 * not flight hardware specifications, and the three sources are never merged into one vehicle.
 */
export type RobotId = 'rlldpTripod' | 'rlldpPallet' | 'im2' | 'artemis4';
export const ROBOT_IDS: RobotId[] = ['rlldpTripod', 'rlldpPallet', 'im2', 'artemis4'];

export interface Robot {
  id: RobotId;
  needs: RobotNeeds;
  /** The landing accuracy its source gives, metres; undefined if none (NASA's 50 to 100 m range is used instead). */
  landingRadiusM?: number;
  /** For each need set from a source: the source's id in CREDITS.md and where in it. */
  why: Partial<Record<keyof RobotNeeds | 'landingRadiusM', { id: string; where: string }>>;
  /** The source the robot is described from, first; the card links it. */
  sources: string[];
}

const RLLDP = 'nasa-rlldp-2012';
const M2M = 'nasa-m2m-landing-2023';
const IM2 = 'nasa-im2-tech-2025';
const ART4 = 'nasa-artemis-iv';

export const ROBOTS: Record<RobotId, Robot> = {
  // The Solar Array Battery tripod: Table 1 of the RLLDP paper. A concept, sized for an equatorial site.
  rlldpTripod: {
    id: 'rlldpTripod',
    needs: {
      litLanding: 'required',
      power: 'solar',
      night: 'battery',
      comms: 'direct_to_earth',
      mobility: 'stationary',
    },
    landingRadiusM: 100,
    why: {
      litLanding: { id: M2M, where: '§5: camera navigation needs sunlight (RLLDP Table 1: two landing cameras)' },
      power: { id: RLLDP, where: 'Table 1: solar array for cruise and lunar day' },
      night: { id: RLLDP, where: 'Table 1: secondary batteries for lunar night' },
      comms: { id: RLLDP, where: 'Table 1: S-band, antenna coverage for nearside operations' },
      mobility: { id: RLLDP, where: '§3: one stationary location' },
      landingRadiusM: { id: RLLDP, where: '§5.3: about 100 m landing accuracy required' },
    },
    sources: [RLLDP, M2M],
  },
  // The medium pallet that carries a rover of about 400 kg: Table 2. Its solar panel is jettisoned during landing.
  rlldpPallet: {
    id: 'rlldpPallet',
    needs: { litLanding: 'unknown', power: 'none', night: 'unknown', comms: 'direct_to_earth', mobility: 'rover' },
    landingRadiusM: 100,
    why: {
      power: {
        id: RLLDP,
        where: 'Table 2: solar panel jettisoned at SRM burnout; battery for cruise and landing only',
      },
      comms: { id: RLLDP, where: 'Table 2: X-band uplink and downlink, low-gain antenna on the lander' },
      mobility: { id: RLLDP, where: '§3: delivers a rover of about 400 kg' },
      landingRadiusM: { id: RLLDP, where: '§5.3: about 100 m landing accuracy required' },
    },
    sources: [RLLDP],
  },
  // IM-2's site criteria as NASA reported them, and its hopper. No vehicle numbers are published there.
  im2: {
    id: 'im2',
    needs: { litLanding: 'required', power: 'unknown', night: 'unknown', comms: 'unknown', mobility: 'hopper' },
    why: {
      litLanding: { id: IM2, where: 'Fact 1: a lit landing corridor and acceptable terrain slope' },
      mobility: { id: IM2, where: 'Fact 3: the Grace hopper surveys permanently shadowed craters' },
    },
    sources: [IM2],
  },
  // Artemis IV's crew: two astronauts for about a week near the South Pole. The lander's needs are not published.
  artemis4: {
    id: 'artemis4',
    needs: { litLanding: 'unknown', power: 'unknown', night: 'unknown', comms: 'unknown', mobility: 'crew' },
    why: {
      mobility: { id: ART4, where: 'Mission overview: two crew on the surface for about a week' },
    },
    sources: [ART4],
  },
};

/** NASA's precision-landing range (Moon to Mars white paper, §2 and Figure 3): touch down within 50 to 100 m. */
export const LANDING_RADII_M = [50, 100] as const;
export type LandingRadius = (typeof LANDING_RADII_M)[number];

export const isRobotId = (v: unknown): v is RobotId => typeof v === 'string' && (ROBOT_IDS as string[]).includes(v);

const DAY_MS = 86_400_000;

/**
 * One robot read against a site check: the card and the copilot both call this, on the same check, so they cannot
 * disagree.
 */
export function fitAt(robot: Robot, query: StayQuery, r: StayResponse, radiusM: number): RobotFit {
  const stayStartMs = Date.parse(query.landingUtc);
  return robotFit(robot.needs, {
    stayStartMs,
    stayEndMs: stayStartMs + query.stayDays * DAY_MS,
    series: r.result.series,
    earthVisiblePct: r.result.earthVisiblePct,
    circle: r.slope?.circles.find((c) => c.radiusM === radiusM),
    walkablePct: r.slope?.slope2kmPctUnder20 ?? Number.NaN,
    shadowDistanceKm: r.longTerm?.shadowDistanceKm ?? r.result.iceDistanceKm,
  });
}

/** The nearest other landed or planned Moon mission, for the plume note; undefined if none has a place. */
export function nearestLander(latDeg: number, lonDeg: number) {
  let best: { id: string; name: string; km: number; approximate: boolean } | undefined;
  for (const m of MISSIONS) {
    if (m.body !== 'Moon' || m.latDeg === undefined || m.lonDeg === undefined) continue;
    const km = moonDistanceKm(latDeg, lonDeg, m.latDeg, m.lonDeg);
    // The site may be the mission's own spot, opened from its card.
    if (km < 0.01) continue;
    if (!best || km < best.km) best = { id: m.id, name: m.name, km, approximate: m.approximate };
  }
  return best;
}
