export type Body = 'moon' | 'mars' | 'earth';

export interface Site {
  id: string;
  body: Body;
  latDeg: number;
  /** East-positive, -180..180. */
  lonDeg: number;
  heightM?: number;
  regionId?: string;
  name?: { en: string; ar: string };
}

export type EarthRule = 'rim' | 'centre' | 'margin2deg';

export interface StayQuery {
  site: Site;
  /** ISO 8601, UTC. */
  landingUtc: string;
  stayDays: number;
  minSunFraction: number;
  earthRule: EarthRule;
  observerHeightM: number;
}

export const DEFAULT_STAY: Omit<StayQuery, 'site' | 'landingUtc'> = {
  stayDays: 6.5,
  minSunFraction: 0.5,
  earthRule: 'centre',
  observerHeightM: 2,
};

export type ReasonCode = 'SUN_BELOW_HORIZON' | 'EARTH_BELOW_HORIZON' | 'SLOPE_TOO_STEEP' | 'OUTSIDE_ZONE' | 'NO_DATA';

export interface Reason {
  code: ReasonCode;
  atUtc?: string;
  detail: Record<string, number | string>;
}

export interface StayResult {
  pass: boolean;
  uncertain: boolean;
  reasons: Reason[];
  sunFractionMin: number;
  earthVisiblePct: number;
  nextSunsetUtc?: string;
  nextSunriseUtc?: string;
  nextEarthsetUtc?: string;
  nextEarthriseUtc?: string;
  slope100mDeg: number;
  slope2kmPctUnder20: number;
  iceDistanceKm?: number;
  series: { tUtcMs: Float64Array; sun: Float32Array; earth: Float32Array };
  /** Dataset ids from CREDITS.md. */
  sources: string[];
}
