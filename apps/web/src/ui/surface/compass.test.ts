import { describe, expect, it } from 'vitest';
import { compassMarks, readoutDeg, tapeSpot } from './compass';

describe('compass tape', () => {
  it('ticks every 5° and labels every 15°, naming the eight points', () => {
    const marks = compassMarks(0, 355);
    expect(marks).toHaveLength(72);
    const at = (deg: number) => marks.find((m) => m.deg === deg);
    expect(at(0)).toEqual({ deg: 0, headingDeg: 0, kind: 'cardinal', point: 'north' });
    expect(at(45)?.point).toBe('northEast');
    expect(at(90)).toMatchObject({ kind: 'cardinal', point: 'east' });
    expect(at(225)).toMatchObject({ kind: 'intercardinal', point: 'southWest' });
    expect(at(270)?.point).toBe('west');
    expect(at(30)).toEqual({ deg: 30, headingDeg: 30, kind: 'degrees' });
    expect(at(35)?.kind).toBe('tick');
    expect(marks.filter((m) => m.kind !== 'tick')).toHaveLength(24);
  });

  it('runs on past 0° and 360°, standing for the same headings', () => {
    const marks = compassMarks(-180, 540);
    expect(marks[0]).toEqual({ deg: -180, headingDeg: 180, kind: 'cardinal', point: 'south' });
    expect(marks.at(-1)).toEqual({ deg: 540, headingDeg: 180, kind: 'cardinal', point: 'south' });
    expect(marks.find((m) => m.deg === -45)?.point).toBe('northWest');
    expect(marks.find((m) => m.deg === 405)?.point).toBe('northEast');
    expect(marks.filter((m) => m.point === 'north').map((m) => m.deg)).toEqual([0, 360]);
  });

  it('reads whole degrees from 0 to 359', () => {
    expect(readoutDeg(0)).toBe(0);
    expect(readoutDeg(247.4)).toBe(247);
    expect(readoutDeg(359.6)).toBe(0);
    expect(readoutDeg(359.4)).toBe(359);
    expect(readoutDeg(-0.4)).toBe(0);
  });

  it('keeps marks beyond the tape at its ends, with the way to turn', () => {
    expect(tapeSpot(20, 70)).toEqual({ offsetDeg: 20, beyond: null });
    expect(tapeSpot(-70, 70)).toEqual({ offsetDeg: -70, beyond: null });
    expect(tapeSpot(120, 70)).toEqual({ offsetDeg: 70, beyond: 'cw' });
    expect(tapeSpot(-179, 70)).toEqual({ offsetDeg: -70, beyond: 'ccw' });
  });
});
