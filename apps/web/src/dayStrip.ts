import type { StayQuery } from '@siteline/contracts';
import { type Ephemeris, earthMarginDeg, type HorizonMask, siteFrame, skyAt } from '@siteline/physics';

const DAY_MS = 86_400_000;
/** How often each day is sampled. */
export const STRIP_STEP_MINUTES = 180;

/** For each UTC day the ephemeris covers, the share of that day the Sun and the Earth pass the stay check's tests. */
export interface DayStrip {
  /** Midnight UTC of the first whole day. */
  startUtcMs: number;
  days: number;
  /** 0 to 1 per day: the part of the day at least the stay's share of the Sun's disc is above the horizon. */
  sun: Float32Array;
  /** 0 to 1 per day: the part of the day the Earth passes the stay's Earth rule. */
  earth: Float32Array;
  /** The same over the whole span, as percentages. */
  sunPct: number;
  earthPct: number;
}

/**
 * The stay check's own Sun and Earth tests (the same horizon, disc fraction and Earth rule) run every `stepMinutes`
 * across every whole day the ephemeris covers, and gathered day by day.
 */
export function dayStrip(
  eph: Ephemeris,
  mask: HorizonMask,
  q: Pick<StayQuery, 'site' | 'minSunFraction' | 'earthRule' | 'observerHeightM'>,
  stepMinutes = STRIP_STEP_MINUTES,
): DayStrip {
  const site = siteFrame(q.site.latDeg, q.site.lonDeg, q.site.heightM ?? 0, q.observerHeightM);
  const startUtcMs = Math.ceil(eph.startUtcMs / DAY_MS) * DAY_MS;
  const days = Math.max(0, Math.floor((eph.endUtcMs - startUtcMs) / DAY_MS));
  const perDay = Math.round((24 * 60) / stepMinutes);
  const stepMs = DAY_MS / perDay;
  const sun = new Float32Array(days);
  const earth = new Float32Array(days);
  let sunAll = 0;
  let earthAll = 0;
  for (let d = 0; d < days; d++) {
    let s = 0;
    let e = 0;
    for (let k = 0; k < perDay; k++) {
      const t = startUtcMs + d * DAY_MS + k * stepMs;
      if (skyAt(eph, 'sun', site, mask, t).fraction >= q.minSunFraction) s++;
      if (earthMarginDeg(skyAt(eph, 'earth', site, mask, t), q.earthRule) >= 0) e++;
    }
    sun[d] = s / perDay;
    earth[d] = e / perDay;
    sunAll += s;
    earthAll += e;
  }
  const n = Math.max(1, days * perDay);
  return { startUtcMs, days, sun, earth, sunPct: (100 * sunAll) / n, earthPct: (100 * earthAll) / n };
}
