import { MOON_RADIUS_M } from './dem';
import { type HeightWindow, LANDING_RADIUS_M, planeFitSlopeDeg, polarScaleFactor } from './slope';
import { DEG } from './vec';

/**
 * Robot fit: whether a site suits a particular lander or robot, as far as its published needs say. It sits beside the
 * site's own four checks and never changes them. Every check answers pass, fail, unknown (the robot's need is known
 * but a number it hangs on is not published, or the site was not measured), not evaluated (the check does not apply
 * to this robot), or info (a fact shown with no verdict). Missing data is never a pass.
 */

/** How the robot gets about once down: it decides which terrain fact matters. */
export type Mobility = 'stationary' | 'rover' | 'hopper' | 'crew';
/** Whether landing needs the site in sunlight (camera navigation, a lit corridor), as the robot's sources say. */
export type LitLanding = 'required' | 'not_required' | 'unknown';
/** Where the robot's power comes from on the surface. */
export type SurfacePower = 'solar' | 'none' | 'unknown';
/** How it gets through darkness on the surface. */
export type NightPlan = 'battery' | 'none' | 'unknown';
/** How it talks home. */
export type Comms = 'direct_to_earth' | 'unknown';

export interface RobotNeeds {
  litLanding: LitLanding;
  power: SurfacePower;
  night: NightPlan;
  comms: Comms;
  mobility: Mobility;
}

/** What the site check already worked out, read for one robot. */
export interface SiteFacts {
  /** The stay, UTC ms. */
  stayStartMs: number;
  stayEndMs: number;
  /** The stay check's own timeline: share of the Sun's disc above the skyline, 0 to 1, per sample. */
  series: { tUtcMs: ArrayLike<number>; sun: ArrayLike<number> };
  earthVisiblePct: number;
  /** The landing circle on the 10 m terrain; undefined where it was not measured. */
  circle?: LandingCircle;
  /** Share (%) of ground within 1 km gentler than 20°; NaN if not measured. */
  walkablePct: number;
  /** Distance to the nearest never-sunlit ground, km; undefined if not known. */
  shadowDistanceKm?: number;
}

export type FitStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluated' | 'info';
export type FitCheckId = 'landingCircle' | 'litLanding' | 'darkness' | 'earth' | 'ground';

export interface FitCheck {
  id: FitCheckId;
  status: FitStatus;
  /** Why, as a short code the interface turns into words. */
  reason: string;
  /** The numbers behind it, each name carrying its unit. */
  values: Record<string, number>;
}

export type FitOverall = 'fits' | 'does_not_fit' | 'not_enough_data';

export interface RobotFit {
  checks: FitCheck[];
  overall: FitOverall;
}

/**
 * The landing circle: everywhere the robot might touch down when it aims at the site and can miss by up to
 * `radiusM`. At each 10 m cell centre inside the circle, the same rule as the site's own landing slope is applied (a
 * plane fitted to the heights within `LANDING_RADIUS_M`), so a circle whose every point passes is one the site check
 * would pass wherever the robot came down.
 */
export interface LandingCircle {
  radiusM: number;
  limitDeg: number;
  /** Touchdown points checked (cell centres in the circle with enough heights around them). */
  points: number;
  /** The steepest local landing slope in the circle, degrees. */
  worstDeg: number;
  /** Share (%) of the points whose landing slope is at or over `limitDeg`. */
  steepPct: number;
}

/**
 * The landing slope at every cell centre within `radiusM` of the site, from the same window of heights the site's own
 * slope is read from. Distances in the polar stereographic plane are taken back to the ground by the scale factor, as
 * in `siteSlopes`. Undefined when under half of the circle's points have enough heights to fit a plane.
 */
export function landingCircle(
  w: HeightWindow,
  latDeg: number,
  radiusM: number,
  limitDeg: number,
): LandingCircle | undefined {
  if (!(radiusM >= 0) || !Number.isFinite(radiusM)) throw new Error('landing circle radius must be a finite length');
  const groundM = w.pixM / polarScaleFactor(latDeg);
  const at = (r: number, c: number) => w.heightsM[r * w.n + c];
  const reach = Math.ceil(LANDING_RADIUS_M / groundM);
  const centres: [number, number][] = [];
  const span = Math.ceil(radiusM / groundM) + 1;
  const c0 = Math.round(w.col);
  const r0 = Math.round(w.row);
  for (let r = r0 - span; r <= r0 + span; r++) {
    for (let c = c0 - span; c <= c0 + span; c++) {
      if (Math.hypot((c - w.col) * groundM, (r - w.row) * groundM) <= radiusM) centres.push([r, c]);
    }
  }
  // A circle smaller than a cell still holds the cell the site is in.
  if (centres.length === 0) centres.push([r0, c0]);
  let points = 0;
  let steep = 0;
  let worstDeg = 0;
  for (const [rc, cc] of centres) {
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let r = rc - reach; r <= rc + reach; r++) {
      for (let c = cc - reach; c <= cc + reach; c++) {
        if (r < 0 || c < 0 || r >= w.n || c >= w.n) continue;
        const xM = (c - cc) * groundM;
        const yM = (rc - r) * groundM;
        const h = at(r, c);
        if (Math.hypot(xM, yM) <= LANDING_RADIUS_M && Number.isFinite(h)) {
          xs.push(xM);
          ys.push(yM);
          zs.push(h);
        }
      }
    }
    if (zs.length < 3) continue;
    let s: number;
    try {
      s = planeFitSlopeDeg(xs, ys, zs);
    } catch {
      continue;
    }
    points++;
    if (s >= limitDeg) steep++;
    if (s > worstDeg) worstDeg = s;
  }
  if (points < centres.length / 2) return undefined;
  return { radiusM, limitDeg, points, worstDeg, steepPct: (100 * steep) / points };
}

/**
 * The longest stretch of the stay with none of the Sun's disc above the skyline, in hours, from the stay check's own
 * samples. A dark run is timed from its first dark sample to the first lit one after it (or the stay's end), so it is
 * good to one sample step. Zero when the Sun is never fully hidden; NaN when the timeline does not cover the stay.
 */
export function longestDarkHours(series: SiteFacts['series'], fromMs: number, toMs: number): number {
  const t = series.tUtcMs;
  const n = t.length;
  if (n === 0 || !(toMs > fromMs) || t[0] > fromMs || t[n - 1] < toMs - (n > 1 ? t[1] - t[0] : 0)) return Number.NaN;
  let longestMs = 0;
  let darkFrom: number | undefined;
  for (let k = 0; k < n && t[k] <= toMs; k++) {
    if (t[k] < fromMs) continue;
    const dark = series.sun[k] <= 0;
    if (dark && darkFrom === undefined) darkFrom = t[k];
    if (!dark && darkFrom !== undefined) {
      longestMs = Math.max(longestMs, t[k] - darkFrom);
      darkFrom = undefined;
    }
  }
  if (darkFrom !== undefined) longestMs = Math.max(longestMs, toMs - darkFrom);
  return longestMs / 3_600_000;
}

/** The share of the Sun's disc above the skyline at the sample nearest `tUtcMs`; NaN outside the timeline. */
export function sunFractionAt(series: SiteFacts['series'], tUtcMs: number): number {
  const t = series.tUtcMs;
  if (t.length === 0) return Number.NaN;
  let best = -1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let k = 0; k < t.length; k++) {
    const gap = Math.abs(t[k] - tUtcMs);
    if (gap < bestGap) {
      best = k;
      bestGap = gap;
    }
  }
  const step = t.length > 1 ? t[1] - t[0] : 0;
  return bestGap <= step ? series.sun[best] : Number.NaN;
}

/** Great-circle distance between two points on the Moon's 1737.4 km reference sphere, km. */
export function moonDistanceKm(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const p1 = lat1Deg * DEG;
  const p2 = lat2Deg * DEG;
  const dp = p2 - p1;
  const dl = (lon2Deg - lon1Deg) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a))) * MOON_RADIUS_M) / 1000;
}

function circleCheck(circle: LandingCircle | undefined): FitCheck {
  if (!circle) return { id: 'landingCircle', status: 'unknown', reason: 'not_measured', values: {} };
  const values = {
    radiusM: circle.radiusM,
    limitDeg: circle.limitDeg,
    worstDeg: circle.worstDeg,
    steepPct: circle.steepPct,
  };
  return circle.steepPct > 0
    ? { id: 'landingCircle', status: 'fail', reason: 'steep_inside', values }
    : { id: 'landingCircle', status: 'pass', reason: 'all_gentle', values };
}

function litCheck(needs: RobotNeeds, facts: SiteFacts): FitCheck {
  if (needs.litLanding === 'not_required')
    return { id: 'litLanding', status: 'not_evaluated', reason: 'not_required', values: {} };
  const fraction = sunFractionAt(facts.series, facts.stayStartMs);
  if (needs.litLanding === 'unknown')
    return { id: 'litLanding', status: 'info', reason: 'need_unknown', values: { sunPct: 100 * fraction } };
  if (!Number.isFinite(fraction)) return { id: 'litLanding', status: 'unknown', reason: 'not_measured', values: {} };
  return fraction > 0
    ? { id: 'litLanding', status: 'pass', reason: 'lit', values: { sunPct: 100 * fraction } }
    : { id: 'litLanding', status: 'fail', reason: 'dark', values: { sunPct: 0 } };
}

function darknessCheck(needs: RobotNeeds, facts: SiteFacts): FitCheck {
  if (needs.power === 'none')
    return { id: 'darkness', status: 'not_evaluated', reason: 'no_surface_power', values: {} };
  const darkH = longestDarkHours(facts.series, facts.stayStartMs, facts.stayEndMs);
  if (!Number.isFinite(darkH)) return { id: 'darkness', status: 'unknown', reason: 'not_measured', values: {} };
  if (darkH === 0) return { id: 'darkness', status: 'pass', reason: 'never_dark', values: { darkH } };
  if (needs.night === 'none') return { id: 'darkness', status: 'fail', reason: 'no_night_plan', values: { darkH } };
  if (needs.night === 'battery')
    return { id: 'darkness', status: 'unknown', reason: 'battery_size_unknown', values: { darkH } };
  return { id: 'darkness', status: 'unknown', reason: 'night_plan_unknown', values: { darkH } };
}

function earthCheck(needs: RobotNeeds, facts: SiteFacts): FitCheck {
  const pct = facts.earthVisiblePct;
  if (needs.comms !== 'direct_to_earth')
    return { id: 'earth', status: 'info', reason: 'need_unknown', values: Number.isFinite(pct) ? { pct } : {} };
  if (!Number.isFinite(pct)) return { id: 'earth', status: 'unknown', reason: 'not_measured', values: {} };
  if (pct >= 100) return { id: 'earth', status: 'pass', reason: 'always_in_view', values: { pct } };
  if (pct <= 0) return { id: 'earth', status: 'fail', reason: 'never_in_view', values: { pct } };
  // Geometry says Earth is in view part of the time; whether that is enough depends on a continuity need no source gives.
  return { id: 'earth', status: 'unknown', reason: 'partly_in_view', values: { pct } };
}

function groundCheck(needs: RobotNeeds, facts: SiteFacts): FitCheck {
  if (needs.mobility === 'rover' || needs.mobility === 'crew') {
    return Number.isFinite(facts.walkablePct)
      ? { id: 'ground', status: 'info', reason: needs.mobility, values: { walkablePct: facts.walkablePct } }
      : { id: 'ground', status: 'info', reason: 'not_measured', values: {} };
  }
  if (needs.mobility === 'hopper') {
    return facts.shadowDistanceKm !== undefined
      ? { id: 'ground', status: 'info', reason: 'hopper', values: { shadowKm: facts.shadowDistanceKm } }
      : { id: 'ground', status: 'info', reason: 'not_measured', values: {} };
  }
  return { id: 'ground', status: 'not_evaluated', reason: 'stationary', values: {} };
}

/**
 * Reads the site's facts against one robot's needs. Overall: does not fit if any check fails; not enough data if any
 * is unknown; fits only when every check that applies passes. Info and not-evaluated checks never move the overall.
 */
export function robotFit(needs: RobotNeeds, facts: SiteFacts): RobotFit {
  const checks = [
    circleCheck(facts.circle),
    litCheck(needs, facts),
    darknessCheck(needs, facts),
    earthCheck(needs, facts),
    groundCheck(needs, facts),
  ];
  const overall: FitOverall = checks.some((c) => c.status === 'fail')
    ? 'does_not_fit'
    : checks.some((c) => c.status === 'unknown')
      ? 'not_enough_data'
      : 'fits';
  return { checks, overall };
}
