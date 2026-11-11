import { DEFAULT_STAY, type StayQuery } from '@siteline/contracts';
import { describe, expect, it } from 'vitest';
import type { Ephemeris } from './ephemeris';
import { siteFrame } from './frames';
import { flatHorizon, HORIZON_BINS, type HorizonMask } from './horizon';
import { type StayInputs, stayTest } from './stay';
import { add, DEG, scale, type Vec3 } from './vec';

// At the south pole the Sun circles the sky once per synodic month at a nearly constant height.
const SYNODIC_MS = 29.530589 * 86_400_000;
const T0 = Date.UTC(2028, 2, 3);
const SUN_ELEV_DEG = 1.5;
const EARTH_ELEV_DEG = 5;
const pole = siteFrame(-90, 0);

function direction(elevDeg: number, azDeg: number): Vec3 {
  const el = elevDeg * DEG;
  const az = azDeg * DEG;
  return add(
    scale(pole.u, Math.sin(el)),
    add(scale(pole.n, Math.cos(el) * Math.cos(az)), scale(pole.e, Math.cos(el) * Math.sin(az))),
  );
}

const sunAzAt = (t: number) => (360 * (t - T0)) / SYNODIC_MS;
const tAtSunAz = (azDeg: number) => T0 + (azDeg / 360) * SYNODIC_MS;

const ephemeris: Ephemeris = {
  startUtcMs: T0 - 86_400_000,
  endUtcMs: T0 + 40 * 86_400_000,
  positionKm: (body, t) =>
    body === 'sun'
      ? add(pole.pKm, scale(direction(SUN_ELEV_DEG, sunAzAt(t)), 1.496e8))
      : add(pole.pKm, scale(direction(EARTH_ELEV_DEG, 180), 384_400)),
};

function wall(fromAzDeg: number, toAzDeg: number, heightDeg: number, base: HorizonMask = flatHorizon()): HorizonMask {
  const mask = Float32Array.from(base);
  for (let i = fromAzDeg * 2; i <= toAzDeg * 2; i++) mask[i % HORIZON_BINS] = heightDeg;
  return mask;
}

const query = (over: Partial<StayQuery> = {}): StayQuery => ({
  ...DEFAULT_STAY,
  observerHeightM: 0,
  site: { id: 'test', body: 'moon', latDeg: -90, lonDeg: 0 },
  landingUtc: new Date(T0).toISOString(),
  ...over,
});

const inputs = (over: Partial<StayInputs> = {}): StayInputs => ({
  ephemeris,
  horizon: flatHorizon(),
  slope100mDeg: 5,
  slope2kmPctUnder20: 90,
  sources: ['test'],
  ...over,
});

const minutesBetween = (iso: string | undefined, t: number) => Math.abs(Date.parse(iso ?? '') - t) / 60_000;

describe('stayTest', () => {
  it('passes when the Sun and Earth stay up over flat ground', () => {
    const r = stayTest(query(), inputs());
    expect(r.reasons).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.sunFractionMin).toBe(1);
    expect(r.earthVisiblePct).toBe(100);
    expect(r.series.tUtcMs.length).toBe(30 * 72 + 1);
  });

  it('fails when a ridge hides the Sun, at the moment the Sun is half covered', () => {
    // A 10° wall from azimuth 30° to 40°. The skyline climbs from 0° at 29.5° to 10° at 30°,
    // so it reaches the Sun's 1.5° height at azimuth 29.575°.
    const r = stayTest(query(), inputs({ horizon: wall(30, 40, 10) }));
    expect(r.pass).toBe(false);
    const sun = r.reasons.find((x) => x.code === 'SUN_BELOW_HORIZON');
    expect(minutesBetween(sun?.atUtc, tAtSunAz(29.575))).toBeLessThan(2);
    expect(minutesBetween(r.nextSunsetUtc, tAtSunAz(29.575))).toBeLessThan(2);
    expect(minutesBetween(r.nextSunriseUtc, tAtSunAz(40.425))).toBeLessThan(2);
  });

  it('fails a launch slip that moves the stay onto the ridge, and passes one that does not', () => {
    const horizon = wall(100, 110, 10);
    expect(stayTest(query(), inputs({ horizon })).pass).toBe(true);
    const slipped = new Date(T0 + 5 * 86_400_000).toISOString();
    expect(stayTest(query({ landingUtc: slipped }), inputs({ horizon })).pass).toBe(false);
  });

  it('applies the Earth rule', () => {
    const horizon = wall(179.5, 180.5, 4.5);
    expect(stayTest(query({ earthRule: 'centre' }), inputs({ horizon })).pass).toBe(true);
    const r = stayTest(query({ earthRule: 'margin2deg' }), inputs({ horizon }));
    expect(r.reasons.map((x) => x.code)).toEqual(['EARTH_BELOW_HORIZON']);
    expect(r.reasons[0].atUtc).toBe(new Date(T0).toISOString());
  });

  it('reports slope, zone and missing data separately', () => {
    expect(stayTest(query(), inputs({ slope100mDeg: 12 })).reasons.map((x) => x.code)).toEqual(['SLOPE_TOO_STEEP']);
    expect(stayTest(query(), inputs({ slope100mDeg: Number.NaN })).reasons[0].detail.missing).toBe('slope');
    const north = query({ site: { id: 'n', body: 'moon', latDeg: -80, lonDeg: 0 } });
    expect(stayTest(north, inputs()).reasons.map((x) => x.code)).toContain('OUTSIDE_ZONE');
    const late = stayTest(query({ landingUtc: '2040-01-01T00:00:00Z' }), inputs());
    expect(late.reasons[0]).toMatchObject({ code: 'NO_DATA', detail: { missing: 'ephemeris' } });
  });

  it('marks a result uncertain when the terrain error could flip it', () => {
    const r = stayTest(
      query(),
      inputs({ horizonBounds: { optimistic: flatHorizon(), pessimistic: wall(30, 40, 10) } }),
    );
    expect(r.pass).toBe(true);
    expect(r.uncertain).toBe(true);
  });
});
