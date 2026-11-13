import { describe, expect, it } from 'vitest';
import {
  droneLevel,
  HOME_CHORD,
  OPENING_CHORD,
  pullBackShape,
  SUN_TONE_LOW_HZ,
  sunAt,
  sunTone,
  VERDICT_NOTES,
  whooshShape,
} from './maps';

/** A note name such as G#5 as its pitch in Hz (A4 = 440 Hz, equal temperament). */
function hz(note: string): number {
  const m = /^([A-G])(#?)(-?\d)$/.exec(note);
  if (!m) throw new Error(note);
  const semitone = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 }[m[1] as 'C'] + (m[2] ? 1 : 0);
  return 440 * 2 ** ((semitone + 12 * (Number(m[3]) - 4)) / 12);
}

describe('the sunlight tone', () => {
  it('runs two octaves, from G3 in the dark to G5 in full Sun, getting louder as it rises', () => {
    expect(sunTone(0).hz).toBeCloseTo(SUN_TONE_LOW_HZ, 9);
    expect(sunTone(0).hz).toBeCloseTo(hz('G3'), 0);
    expect(sunTone(1).hz).toBeCloseTo(hz('G5'), 0);
    expect(sunTone(0.5).hz).toBeCloseTo(hz('G4'), 0);
    expect(sunTone(1).db).toBeGreaterThan(sunTone(0).db);
  });

  it('only ever rises as more of the Sun shows, and never gets loud', () => {
    let last = sunTone(0);
    for (let f = 0.05; f <= 1.0001; f += 0.05) {
      const now = sunTone(f);
      expect(now.hz).toBeGreaterThan(last.hz);
      expect(now.db).toBeGreaterThan(last.db);
      expect(now.db).toBeLessThanOrEqual(-18);
      last = now;
    }
  });

  it('treats a reading outside 0 to 1, or none at all, as the nearest it can be', () => {
    expect(sunTone(1.4)).toEqual(sunTone(1));
    expect(sunTone(-0.2)).toEqual(sunTone(0));
    expect(sunTone(Number.NaN)).toEqual(sunTone(0));
  });
});

describe('reading the sunlight at a moment', () => {
  // Three hours of a stay series at 20-minute steps: the Sun rises from 0 to the whole disc and stays up.
  const t0 = Date.parse('2028-03-03T00:00:00Z');
  const step = 20 * 60_000;
  const sun = [0, 0, 0.25, 0.75, 1, 1, 1, 1, 1, 1];
  const series = { tUtcMs: Float64Array.from(sun, (_, i) => t0 + i * step), sun: Float32Array.from(sun) };

  it('gives the sample at a sample, and the straight line between samples in between', () => {
    expect(sunAt(series, t0 + 3 * step)).toBeCloseTo(0.75, 6);
    expect(sunAt(series, t0 + 2.5 * step)).toBeCloseTo(0.5, 6);
    expect(sunAt(series, t0 + 3.25 * step)).toBeCloseTo(0.8125, 6);
  });

  it('knows nothing outside the series', () => {
    expect(sunAt(series, t0 - 1)).toBeNaN();
    expect(sunAt(series, t0 + 10 * step)).toBeNaN();
    expect(sunAt({ tUtcMs: new Float64Array(), sun: new Float32Array() }, t0)).toBeNaN();
  });

  it('turns a sunrise into a rising tone', () => {
    const tones = [0, 1, 2, 3, 4].map((i) => sunTone(sunAt(series, t0 + i * step)).hz);
    for (let i = 1; i < tones.length; i++) expect(tones[i]).toBeGreaterThanOrEqual(tones[i - 1]);
    expect(tones[4]).toBeCloseTo(4 * tones[0], 6);
  });
});

describe('the flight whoosh', () => {
  it('stays silent for a zoom click or a nudge', () => {
    expect(whooshShape({ durationMs: 300, zoom: 1, turnRad: 1 })).toBeNull();
    expect(whooshShape({ durationMs: 0, zoom: 4, turnRad: 0 })).toBeNull();
    expect(whooshShape({ durationMs: 1400, zoom: 0, turnRad: 0.01 })).toBeNull();
  });

  it('lasts as long as the flight', () => {
    expect(whooshShape({ durationMs: 1800, zoom: 3, turnRad: 0.2 })?.seconds).toBeCloseTo(1.8, 9);
  });

  it('is louder and brighter for a faster camera, up to a cap', () => {
    const slow = whooshShape({ durationMs: 2600, zoom: 0.6, turnRad: 0.4 });
    const fast = whooshShape({ durationMs: 1800, zoom: 4, turnRad: 0.3 });
    const wild = whooshShape({ durationMs: 1000, zoom: 20, turnRad: 3 });
    if (!slow || !fast || !wild) throw new Error('expected whooshes');
    expect(fast.peakDb).toBeGreaterThan(slow.peakDb);
    expect(fast.peakHz).toBeGreaterThan(slow.peakHz);
    expect(wild.peakDb).toBeLessThanOrEqual(-22);
  });
});

describe('the pull back out to the solar system', () => {
  // The pull back from the Moon: from 0.7 to about 263 scene units away over 2.6 s, swinging about 0.6 rad.
  const back = { durationMs: 2600, zoom: Math.log(263 / 0.7), turnRad: 0.6 };

  it('is as loud and bright as a whoosh for the same move, and as long as the flight', () => {
    const shape = pullBackShape(back);
    const whoosh = whooshShape(back);
    if (!shape || !whoosh) throw new Error('expected sounds');
    expect(shape.seconds).toBeCloseTo(2.6, 9);
    expect(shape.peakDb).toBe(whoosh.peakDb);
    expect(shape.peakHz).toBe(whoosh.peakHz);
  });

  it('peaks early, before half-way where a dive peaks, and brings the chord in after the peak and before the end', () => {
    const shape = pullBackShape(back);
    if (!shape) throw new Error('expected a sound');
    expect(shape.peakS).toBeLessThan(shape.seconds / 2);
    expect(shape.chordS).toBeGreaterThan(shape.peakS);
    expect(shape.chordS).toBeLessThan(shape.seconds);
  });

  it('stays silent where a whoosh would: a cut with reduced motion', () => {
    expect(pullBackShape({ ...back, durationMs: 0 })).toBeNull();
  });

  it('comes home on the opening chord, an octave down', () => {
    // Equal temperament from A4 = 440 Hz, enough to read the chords' note names.
    const SEMITONE: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
    const hz = (note: string) => {
      const m = /^([A-G])(#?)(\d)$/.exec(note);
      if (!m) throw new Error(`not a note: ${note}`);
      return 440 * 2 ** ((SEMITONE[m[1]] + (m[2] ? 1 : 0) + 12 * (Number(m[3]) - 4)) / 12);
    };
    expect(HOME_CHORD).toHaveLength(OPENING_CHORD.length);
    for (const [i, note] of HOME_CHORD.entries()) expect(hz(note) * 2).toBeCloseTo(hz(OPENING_CHORD[i]), 6);
    expect(hz('E4')).toBeCloseTo(329.628, 3);
  });
});

describe('the opening drone', () => {
  it('opens up and grows with the loading, and stays quiet', () => {
    expect(droneLevel(1).cutoffHz).toBeGreaterThan(droneLevel(0.5).cutoffHz);
    expect(droneLevel(0.5).cutoffHz).toBeGreaterThan(droneLevel(0).cutoffHz);
    expect(droneLevel(1).db).toBeGreaterThan(droneLevel(0).db);
    expect(droneLevel(1).db).toBeLessThanOrEqual(-24);
    expect(droneLevel(Number.NaN)).toEqual(droneLevel(0));
  });
});

describe('the verdict phrases', () => {
  it('rise a major third for a pass', () => {
    const [a, b] = VERDICT_NOTES.pass;
    expect(b.at).toBeGreaterThan(a.at);
    expect(12 * Math.log2(hz(b.note) / hz(a.note))).toBeCloseTo(4, 6);
  });

  it('say a fail with a single note well below the others, and an undecided site with one soft note', () => {
    expect(VERDICT_NOTES.fail).toHaveLength(1);
    expect(VERDICT_NOTES.undecided).toHaveLength(1);
    expect(hz(VERDICT_NOTES.fail[0].note)).toBeLessThan(hz(VERDICT_NOTES.undecided[0].note) / 2);
    expect(VERDICT_NOTES.undecided[0].velocity).toBeLessThan(VERDICT_NOTES.pass[1].velocity);
  });

  it('are all short', () => {
    for (const notes of Object.values(VERDICT_NOTES))
      for (const n of notes) expect(n.at + n.seconds).toBeLessThanOrEqual(0.6);
  });
});
