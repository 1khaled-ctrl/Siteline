/**
 * The compass along the top of the surface view, as plain maths: the marks its tape carries, where a bearing sits on
 * it, and how its readout rounds. Headings are degrees clockwise from local north where the eye is.
 */

/** The eight points the compass names, clockwise from north. */
export const COMPASS_POINTS = [
  'north',
  'northEast',
  'east',
  'southEast',
  'south',
  'southWest',
  'west',
  'northWest',
] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

export interface CompassMark {
  /** Where along the tape, degrees: the tape runs on past 0° and 360°, repeating. */
  deg: number;
  /** The heading it stands for, 0 to 355. */
  headingDeg: number;
  /** One of the four cardinal points, one of the four between them, the degrees on the other 15° marks, or a 5° tick. */
  kind: 'cardinal' | 'intercardinal' | 'degrees' | 'tick';
  point?: CompassPoint;
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** The tape's marks from `fromDeg` to `toDeg`: a tick every 5°, and a label every 15° (a point's name, or degrees). */
export function compassMarks(fromDeg: number, toDeg: number): CompassMark[] {
  const marks: CompassMark[] = [];
  for (let deg = Math.ceil(fromDeg / 5) * 5; deg <= toDeg; deg += 5) {
    const headingDeg = wrap(deg);
    if (headingDeg % 45 === 0) {
      marks.push({
        deg,
        headingDeg,
        kind: headingDeg % 90 === 0 ? 'cardinal' : 'intercardinal',
        point: COMPASS_POINTS[headingDeg / 45],
      });
    } else marks.push({ deg, headingDeg, kind: headingDeg % 15 === 0 ? 'degrees' : 'tick' });
  }
  return marks;
}

/** The heading as the readout shows it, whole degrees from 0 to 359: 359.6° reads 0°, never 360°. */
export function readoutDeg(headingDeg: number): number {
  return wrap(Math.round(headingDeg));
}

/**
 * Where a mark `relDeg` from the heading sits on a tape that shows `halfSpanDeg` either side of it: its offset from the
 * middle, degrees, held at the tape's end when it lies beyond, with the way to turn to bring it in.
 */
export function tapeSpot(relDeg: number, halfSpanDeg: number): { offsetDeg: number; beyond: 'ccw' | 'cw' | null } {
  if (relDeg > halfSpanDeg) return { offsetDeg: halfSpanDeg, beyond: 'cw' };
  if (relDeg < -halfSpanDeg) return { offsetDeg: -halfSpanDeg, beyond: 'ccw' };
  return { offsetDeg: relDeg, beyond: null };
}
