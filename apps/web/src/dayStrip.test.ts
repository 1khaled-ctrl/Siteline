import { type Ephemeris, flatHorizon, type Vec3 } from '@siteline/physics';
import { describe, expect, it } from 'vitest';
import { dayStrip } from './dayStrip';

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 0, 1);

/** A sky that turns once a day around the Moon's polar axis, tilted so a body skims the horizon of the pole. */
function sky(sunTiltDeg: number, earthTiltDeg: number, days: number): Ephemeris {
  const at = (tiltDeg: number, distKm: number, t: number): Vec3 => {
    const a = (2 * Math.PI * (t - START)) / DAY_MS;
    const tilt = (tiltDeg * Math.PI) / 180;
    return [distKm * Math.cos(tilt) * Math.cos(a), distKm * Math.cos(tilt) * Math.sin(a), distKm * Math.sin(tilt)];
  };
  return {
    startUtcMs: START,
    endUtcMs: START + days * DAY_MS,
    positionKm: (body, t) => (body === 'sun' ? at(sunTiltDeg, 1.496e8, t) : at(earthTiltDeg, 384_400, t)),
  };
}

const query = {
  site: { id: 'test', body: 'moon' as const, latDeg: -90, lonDeg: 0 },
  minSunFraction: 0.5,
  earthRule: 'centre' as const,
  observerHeightM: 2,
};

describe('dayStrip', () => {
  it('has one value a day for every whole day the ephemeris covers', () => {
    const s = dayStrip(sky(-10, -10, 30), flatHorizon(), query);
    expect(s.startUtcMs).toBe(START);
    expect(s.days).toBe(30);
    expect(s.sun.length).toBe(30);
  });

  it('sees a body high over the south pole all day, and one under the horizon never', () => {
    // From the south pole, a body 10° below the sky's equator (z < 0) stands 10° above the horizon.
    const up = dayStrip(sky(-10, 10, 5), flatHorizon(), query);
    expect([...up.sun]).toEqual([1, 1, 1, 1, 1]);
    expect([...up.earth]).toEqual([0, 0, 0, 0, 0]);
    expect(up.sunPct).toBe(100);
    expect(up.earthPct).toBe(0);
  });
});
