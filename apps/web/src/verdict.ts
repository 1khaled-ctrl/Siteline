import type { Reason, StayResult } from '@siteline/contracts';

export type Check = 'yes' | 'no' | 'unknown';
export type CheckKey = 'sun' | 'earth' | 'slope' | 'zone';
export type Verdict = 'pass' | 'fail' | 'undecided';
export const CHECK_KEYS: readonly CheckKey[] = ['sun', 'earth', 'slope', 'zone'];

/**
 * The four checks of a stay. Sun and Earth are unknown without the ephemeris for the dates; the slope is unknown when
 * the terrain is too coarse to measure it.
 */
export function checksOf(r: StayResult): Record<CheckKey, Check> {
  const has = (code: Reason['code']) => r.reasons.some((x) => x.code === code);
  const noEphemeris = r.reasons.some((x) => x.code === 'NO_DATA' && x.detail.missing === 'ephemeris');
  const light = (code: Reason['code']): Check => (noEphemeris ? 'unknown' : has(code) ? 'no' : 'yes');
  return {
    sun: light('SUN_BELOW_HORIZON'),
    earth: light('EARTH_BELOW_HORIZON'),
    slope: Number.isFinite(r.slope100mDeg) ? (has('SLOPE_TOO_STEEP') ? 'no' : 'yes') : 'unknown',
    zone: has('OUTSIDE_ZONE') ? 'no' : 'yes',
  };
}

/**
 * How strong the evidence for ice at a place is, weakest first: ice can last there (permanent shadow), the ground is
 * consistent with ice (brighter LOLA reflectance in the coldest places, Fisher et al. 2017), ice was detected in a
 * shadowed region near it (M3 surface ice, Lemelin et al. 2021), or ice was detected there by a direct measurement
 * (LCROSS at Cabeus, Colaprete et al. 2010; M3, Li et al. 2018). A level is shown for a place only where we hold a
 * sourced map or outline for it: today the first and the third.
 */
export const ICE_LEVELS = ['canLast', 'consistent', 'detectedNearby', 'detected'] as const;
export type IceLevel = (typeof ICE_LEVELS)[number];

/** The stay's fifth line: how far it is to the nearest permanent shadow, where ice can last. */
export interface IceLine {
  distanceKm: number;
  /** The site itself is in permanent shadow, by the map the distance comes from. */
  atSite: boolean;
  /**
   * The only level this line can show: the distance is to permanent shadow, so ice can last there. A stronger level
   * needs its own sourced data first, so the type allows nothing else.
   */
  level: Extract<IceLevel, 'canLast'>;
}

/** The pages the ice line's words come from, each opened and read before it was linked (2026-11-15). */
export const ICE_SOURCES = {
  /** The Planetary Society's guide, for what ice near a site could be used for. */
  uses: 'https://www.planetary.org/articles/water-on-the-moon-guide',
  /** NASA's article on LRO's frost evidence (31 May 2017), for what a cold trap is. */
  coldTraps: 'https://www.nasa.gov/missions/nasa-orbiter-finds-new-evidence-of-frost-on-moons-surface/',
  /** Fisher et al. 2017, Icarus 292, 74-85, on PubMed Central: reflectance consistent with ice. */
  consistent: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7197374/',
  /** Colaprete et al. 2010, Science 330, 463-468: water detected in the LCROSS plume at Cabeus. */
  lcross: 'https://doi.org/10.1126/science.1186986',
  /** Li et al. 2018, PNAS 115, 8907-8912: patchy surface ice seen by M3. */
  m3: 'https://doi.org/10.1073/pnas.1802345115',
  /** Lemelin et al. 2021, PSJ 2, 103: the shadowed regions where M3 detected surface ice, and how they are outlined. */
  detectedNearby: 'https://doi.org/10.3847/PSJ/abf3c5',
} as const;

/**
 * NASA's description of a lunar cold trap, as its page prints it: permanently dark ground "where temperatures remain
 * below minus 260 degrees Fahrenheit (minus 163 degrees Celsius)", where "water ice can persist for millions or billions
 * of years". Both figures are NASA's own, shown as printed; neither is worked out from the other. SiteLine maps
 * permanent shadow, not its temperature, so this describes cold traps in general, never the shadow nearest a site.
 */
export const COLD_TRAP = { belowF: -260, belowC: -163, source: ICE_SOURCES.coldTraps } as const;

/**
 * How far beyond its shadow each of Lemelin et al. 2021's ice-bearing regions is outlined: one M3 pixel, 280 m, the
 * paper's rule for counting a detection as the shadow's ("inside or within one M3-sized pixel (280 m)"). Each outline in
 * the published file is exactly that much bigger than its shadow (iceRegions.data.test.ts checks it).
 */
export const ICE_OUTLINE = { beyondShadowM: 280, source: ICE_SOURCES.detectedNearby } as const;

/**
 * The ice line, from the stay's `iceDistanceKm` (the nearest permanent shadow on NASA's long-term maps): a proxy, since
 * permanent shadow means ice can last there, not that ice has been found. It is information, never a check, and never
 * changes the verdict: no source we cite gives a distance that counts as near enough. Undefined where the maps carry
 * no distance for the site, or the nearest shadow is beyond their reach.
 */
export function iceLineOf(r: StayResult): IceLine | undefined {
  const km = r.iceDistanceKm;
  if (km === undefined || !Number.isFinite(km) || km < 0) return undefined;
  return { distanceKm: km, atSite: km === 0, level: 'canLast' };
}

/**
 * The ice line's second reading: how far it is to the nearest shadowed region where M3 detected surface ice (Lemelin et
 * al. 2021). That is evidence near the site, never at it, so its level is "detected nearby"; like the first reading it is
 * information, never a check.
 */
export interface IceDetectedLine {
  /** Straight over the Moon's surface to the region's outline, km; 0 within the outline. */
  distanceKm: number;
  /** Within the outline, which extends 280 m beyond the shadow: in the shadow or beside it, the data cannot say which. */
  withinOutline: boolean;
  level: Extract<IceLevel, 'detectedNearby'>;
  /** The dataset the distance comes from (CREDITS.md). */
  id: string;
}

/** The second reading, from the worker's nearest ice-bearing region: undefined without one, never a made-up distance. */
export function iceDetectedLineOf(
  d: { id: string; distanceKm: number; inside: boolean } | undefined,
): IceDetectedLine | undefined {
  if (!d || !Number.isFinite(d.distanceKm) || d.distanceKm < 0) return undefined;
  return { distanceKm: d.distanceKm, withinOutline: d.inside, level: 'detectedNearby', id: d.id };
}

/** Any failed check fails the site; otherwise any unknown one leaves it undecided. */
export function verdictOf(checks: Readonly<Record<CheckKey, Check>>): Verdict {
  const all = Object.values(checks);
  return all.includes('no') ? 'fail' : all.includes('unknown') ? 'undecided' : 'pass';
}

export interface RankInput {
  verdict: Verdict;
  earthVisiblePct: number;
  /** Sunlight over the 19-year cycle, where the long-term maps cover the spot. */
  longTermSunPct?: number;
}

const VERDICT_ORDER: Record<Verdict, number> = { pass: 0, undecided: 1, fail: 2 };
const orLow = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY);

/**
 * The sites best first, by a rule simple enough to state on screen: the stay's verdict, then sunlight over 19 years,
 * then the time Earth is in view. Sites still being checked (undefined) are left out.
 */
export function rankSites(rows: readonly (RankInput | undefined)[]): number[] {
  return rows
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: RankInput; i: number } => x.r !== undefined)
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.r.verdict] - VERDICT_ORDER[b.r.verdict] ||
        orLow(b.r.longTermSunPct) - orLow(a.r.longTermSunPct) ||
        orLow(b.r.earthVisiblePct) - orLow(a.r.earthVisiblePct) ||
        a.i - b.i,
    )
    .map((x) => x.i);
}

/** Which entries hold the highest value, when at least two values can be compared and they are not all equal. */
export function bestOf(values: readonly (number | undefined)[]): Set<number> {
  const known = values.map((v, i) => ({ v, i })).filter((x) => x.v !== undefined && Number.isFinite(x.v));
  if (known.length < 2) return new Set();
  const top = Math.max(...known.map((x) => x.v as number));
  const winners = known.filter((x) => x.v === top);
  return winners.length === known.length ? new Set() : new Set(winners.map((x) => x.i));
}

export interface Problem {
  /** The reason's code, with what is missing for NO_DATA (`NO_DATA_ephemeris`). */
  key: string;
  atUtc?: string;
  /** Already true at the landing moment, rather than something that happens later in the stay. */
  atLanding: boolean;
}

/**
 * The first thing that goes wrong in a stay. The note that the slope is not measured is skipped: every site carries it
 * until finer terrain is loaded, so it would hide the problem that differs between sites.
 */
export function firstProblem(reasons: readonly Reason[], landingMs: number): Problem | undefined {
  const first = reasons.find((r) => !(r.code === 'NO_DATA' && r.detail.missing === 'slope'));
  if (!first) return undefined;
  return {
    key: first.code === 'NO_DATA' ? `NO_DATA_${first.detail.missing}` : first.code,
    atUtc: first.atUtc,
    atLanding: first.atUtc !== undefined && Date.parse(first.atUtc) <= landingMs,
  };
}

/** The share card's file name: place and landing day, readable and safe in any file system. */
export function cardFileName(latDeg: number, lonDeg: number, landingUtc: string): string {
  const place = `${Math.abs(latDeg)}${latDeg < 0 ? 'S' : 'N'}_${Math.abs(lonDeg)}${lonDeg < 0 ? 'W' : 'E'}`;
  return `siteline-${place}-${landingUtc.slice(0, 10)}.png`;
}

export interface ShareState {
  landingUtc: string;
  slipDays: number;
  latDeg: number;
  lonDeg: number;
  /** The robot the site is read against, and its landing circle; left out of the link when none is chosen. */
  robot?: string | null;
  landingRadiusM?: number;
}

/** A link that opens the south-pole check on this spot, landing date and slip, and the robot if one is chosen. */
export function shareLink(base: string, s: ShareState): string {
  const p = new URLSearchParams({
    open: 'pole',
    t: s.landingUtc,
    slip: String(s.slipDays),
    lat: String(s.latDeg),
    lon: String(s.lonDeg),
  });
  if (s.robot) {
    p.set('robot', s.robot);
    if (s.landingRadiusM !== undefined) p.set('ring', String(s.landingRadiusM));
  }
  return `${base}?${p}`;
}
