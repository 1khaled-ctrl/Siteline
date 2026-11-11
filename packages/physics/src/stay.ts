import type { EarthRule, Reason, ReasonCode, StayQuery, StayResult } from '@siteline/contracts';
import { angularRadiusDeg, discFraction, EARTH_RADIUS_KM, SUN_RADIUS_KM } from './disc';
import type { EphemBody, Ephemeris } from './ephemeris';
import { elevAz, type SiteFrame, siteFrame } from './frames';
import { type HorizonMask, horizonAt } from './horizon';

export const ARTEMIS_ZONE_LAT_DEG = -84;
export const MAX_LANDING_SLOPE_DEG = 10;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface Sky {
  elevDeg: number;
  azDeg: number;
  horizonDeg: number;
  radiusDeg: number;
  fraction: number;
}

export function skyAt(eph: Ephemeris, body: EphemBody, site: SiteFrame, mask: HorizonMask, tUtcMs: number): Sky {
  const { elevDeg, azDeg, distKm } = elevAz(eph.positionKm(body, tUtcMs), site);
  const horizonDeg = horizonAt(mask, azDeg);
  const radiusDeg = angularRadiusDeg(body === 'sun' ? SUN_RADIUS_KM : EARTH_RADIUS_KM, distKm);
  return { elevDeg, azDeg, horizonDeg, radiusDeg, fraction: discFraction(elevDeg, horizonDeg, radiusDeg) };
}

/** Degrees by which the Earth rule is met; negative means it fails. */
export function earthMarginDeg(sky: Sky, rule: EarthRule): number {
  const above = sky.elevDeg - sky.horizonDeg;
  if (rule === 'rim') return above + sky.radiusDeg;
  if (rule === 'margin2deg') return above - 2;
  return above;
}

/** First time within (a, b] where the margin's sign differs from its sign at a, to the minute. */
function crossing(margin: (t: number) => number, a: number, b: number): number {
  const startsOk = margin(a) >= 0;
  let lo = a;
  let hi = b;
  while (hi - lo > MINUTE_MS) {
    const mid = (lo + hi) / 2;
    if (margin(mid) >= 0 === startsOk) lo = mid;
    else hi = mid;
  }
  return hi;
}

interface Ctx {
  q: StayQuery;
  site: SiteFrame;
  eph: Ephemeris;
}

function lightReason(ctx: Ctx, code: ReasonCode, body: EphemBody, mask: HorizonMask, t: number): Reason {
  const s = skyAt(ctx.eph, body, ctx.site, mask, t);
  return {
    code,
    atUtc: new Date(t).toISOString(),
    detail: { elevDeg: s.elevDeg, horizonDeg: s.horizonDeg, azDeg: s.azDeg, visibleFraction: s.fraction },
  };
}

interface LightCheck {
  pass: boolean;
  reasons: Reason[];
  sunFractionMin: number;
  earthVisiblePct: number;
}

function checkLight(ctx: Ctx, mask: HorizonMask, t0: number, tEnd: number, stepMs: number): LightCheck {
  const { q, site, eph } = ctx;
  const sunMargin = (t: number) => skyAt(eph, 'sun', site, mask, t).fraction - q.minSunFraction;
  const earthMargin = (t: number) => earthMarginDeg(skyAt(eph, 'earth', site, mask, t), q.earthRule);
  const reasons: Reason[] = [];
  let sunFractionMin = 1;
  let earthOk = 0;
  let samples = 0;
  let sunFailed = false;
  let earthFailed = false;
  let prev = t0;
  for (let t = t0; ; t = Math.min(t + stepMs, tEnd)) {
    const sun = sunMargin(t) + q.minSunFraction;
    const earth = earthMargin(t);
    sunFractionMin = Math.min(sunFractionMin, sun);
    samples++;
    if (earth >= 0) earthOk++;
    if (!sunFailed && sun < q.minSunFraction) {
      sunFailed = true;
      const at = t === t0 ? t0 : crossing(sunMargin, prev, t);
      reasons.push(lightReason(ctx, 'SUN_BELOW_HORIZON', 'sun', mask, at));
    }
    if (!earthFailed && earth < 0) {
      earthFailed = true;
      const at = t === t0 ? t0 : crossing(earthMargin, prev, t);
      reasons.push(lightReason(ctx, 'EARTH_BELOW_HORIZON', 'earth', mask, at));
    }
    if (t >= tEnd) break;
    prev = t;
  }
  return { pass: reasons.length === 0, reasons, sunFractionMin, earthVisiblePct: (100 * earthOk) / samples };
}

interface Events {
  sunset?: number;
  sunrise?: number;
  earthset?: number;
  earthrise?: number;
}

function timeline(ctx: Ctx, mask: HorizonMask, t0: number, stepMs: number, days: number) {
  const { q, site, eph } = ctx;
  const tLast = Math.min(t0 + days * DAY_MS, eph.endUtcMs);
  const n = t0 > tLast ? 0 : Math.floor((tLast - t0) / stepMs) + 1;
  const tUtcMs = new Float64Array(n);
  const sun = new Float32Array(n);
  const earth = new Float32Array(n);
  const sunAbove = (t: number) => {
    const s = skyAt(eph, 'sun', site, mask, t);
    return s.elevDeg - s.horizonDeg;
  };
  const earthMargin = (t: number) => earthMarginDeg(skyAt(eph, 'earth', site, mask, t), q.earthRule);
  const events: Events = {};
  let prevSun = 0;
  let prevEarth = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * stepMs;
    const s = skyAt(eph, 'sun', site, mask, t);
    const e = skyAt(eph, 'earth', site, mask, t);
    tUtcMs[k] = t;
    sun[k] = s.fraction;
    earth[k] = e.fraction;
    const sm = s.elevDeg - s.horizonDeg;
    const em = earthMarginDeg(e, q.earthRule);
    if (k > 0) {
      const tp = t - stepMs;
      if (prevSun >= 0 && sm < 0) events.sunset ??= crossing(sunAbove, tp, t);
      if (prevSun < 0 && sm >= 0) events.sunrise ??= crossing(sunAbove, tp, t);
      if (prevEarth >= 0 && em < 0) events.earthset ??= crossing(earthMargin, tp, t);
      if (prevEarth < 0 && em >= 0) events.earthrise ??= crossing(earthMargin, tp, t);
    }
    prevSun = sm;
    prevEarth = em;
  }
  return { series: { tUtcMs, sun, earth }, events };
}

export interface StayInputs {
  ephemeris: Ephemeris;
  horizon: HorizonMask;
  /** Skylines with the terrain lowered and raised by its height error; enables the `uncertain` flag. */
  horizonBounds?: { optimistic: HorizonMask; pessimistic: HorizonMask };
  /** NaN when no terrain is loaded. */
  slope100mDeg: number;
  slope2kmPctUnder20: number;
  iceDistanceKm?: number;
  sources: string[];
  /** Sample spacing; an hour can miss the Sun dipping behind a narrow peak. */
  stepMinutes?: number;
  timelineDays?: number;
}

const iso = (t: number | undefined) => (t === undefined ? undefined : new Date(t).toISOString());

export function stayTest(q: StayQuery, inp: StayInputs): StayResult {
  const eph = inp.ephemeris;
  const ctx: Ctx = { q, eph, site: siteFrame(q.site.latDeg, q.site.lonDeg, q.site.heightM ?? 0, q.observerHeightM) };
  const stepMs = (inp.stepMinutes ?? 20) * MINUTE_MS;
  const t0 = Date.parse(q.landingUtc);
  const tEnd = t0 + q.stayDays * DAY_MS;
  const covered = Number.isFinite(t0) && t0 >= eph.startUtcMs && tEnd <= eph.endUtcMs;

  const reasons: Reason[] = [];
  const light = covered ? checkLight(ctx, inp.horizon, t0, tEnd, stepMs) : undefined;
  if (light) reasons.push(...light.reasons);
  else {
    reasons.push({
      code: 'NO_DATA',
      detail: {
        missing: 'ephemeris',
        fromUtc: new Date(eph.startUtcMs).toISOString(),
        toUtc: new Date(eph.endUtcMs).toISOString(),
      },
    });
  }
  if (q.site.latDeg > ARTEMIS_ZONE_LAT_DEG) {
    reasons.push({ code: 'OUTSIDE_ZONE', detail: { latDeg: q.site.latDeg, limitLatDeg: ARTEMIS_ZONE_LAT_DEG } });
  }
  if (!Number.isFinite(inp.slope100mDeg)) {
    reasons.push({ code: 'NO_DATA', detail: { missing: 'slope' } });
  } else if (inp.slope100mDeg >= MAX_LANDING_SLOPE_DEG) {
    reasons.push({
      code: 'SLOPE_TOO_STEEP',
      detail: { slope100mDeg: inp.slope100mDeg, limitDeg: MAX_LANDING_SLOPE_DEG },
    });
  }

  let uncertain = false;
  const onlyLight = reasons.every((r) => r.code === 'SUN_BELOW_HORIZON' || r.code === 'EARTH_BELOW_HORIZON');
  if (covered && inp.horizonBounds && onlyLight) {
    const optimistic = checkLight(ctx, inp.horizonBounds.optimistic, t0, tEnd, stepMs).pass;
    const pessimistic = checkLight(ctx, inp.horizonBounds.pessimistic, t0, tEnd, stepMs).pass;
    uncertain = optimistic !== pessimistic;
  }

  const { series, events } =
    Number.isFinite(t0) && t0 >= eph.startUtcMs
      ? timeline(ctx, inp.horizon, t0, stepMs, inp.timelineDays ?? 30)
      : {
          series: { tUtcMs: new Float64Array(), sun: new Float32Array(), earth: new Float32Array() },
          events: {} as Events,
        };

  return {
    pass: reasons.length === 0,
    uncertain,
    reasons,
    sunFractionMin: light?.sunFractionMin ?? Number.NaN,
    earthVisiblePct: light?.earthVisiblePct ?? Number.NaN,
    nextSunsetUtc: iso(events.sunset),
    nextSunriseUtc: iso(events.sunrise),
    nextEarthsetUtc: iso(events.earthset),
    nextEarthriseUtc: iso(events.earthrise),
    slope100mDeg: inp.slope100mDeg,
    slope2kmPctUnder20: inp.slope2kmPctUnder20,
    iceDistanceKm: inp.iceDistanceKm,
    series,
    sources: inp.sources,
  };
}
