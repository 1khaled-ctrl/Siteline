/**
 * How far to trust each reading of the site report, from the resolution of the terrain behind it. Matter-of-fact: a
 * reading is either fully supported by the data loaded, a first pass that finer terrain could change, or not measured.
 */

export type Confidence = 'high' | 'firstPass' | 'notMeasured' | 'flatHorizon';
export type Reading = 'sun' | 'earth' | 'slope' | 'zone' | 'height' | 'longTerm';

/** The native resolution of LOLA's LDEM_75S_240M, the product the loaded terrain was resampled from. */
export const FULL_DETAIL_M = 240;
/** The landing-slope rule is over 100 m, so it needs terrain at least that fine. */
export const SLOPE_NEEDS_M = 100;

export interface ConfidenceInputs {
  /** The terrain under the horizon and the ground height; undefined when the spot is off it (flat horizon). */
  terrainM?: number;
  /** The grid of the 19-year maps, when the spot is on them. */
  longTermM?: number;
  /** The grid the slope was measured on, when it was (LOLA's 10 m terrain); otherwise the terrain above decides. */
  slopeM?: number;
}

export function confidenceOf(reading: Reading, { terrainM, longTermM, slopeM }: ConfidenceInputs): Confidence {
  switch (reading) {
    // Only the latitude matters.
    case 'zone':
      return 'high';
    case 'slope': {
      const m = slopeM ?? terrainM;
      return m !== undefined && m <= SLOPE_NEEDS_M ? 'high' : 'notMeasured';
    }
    // The horizon decides when the Sun and the Earth are up.
    case 'sun':
    case 'earth':
      if (terrainM === undefined) return 'flatHorizon';
      return terrainM <= FULL_DETAIL_M ? 'high' : 'firstPass';
    case 'height':
      if (terrainM === undefined) return 'notMeasured';
      return terrainM <= FULL_DETAIL_M ? 'high' : 'firstPass';
    case 'longTerm':
      if (longTermM === undefined) return 'notMeasured';
      return longTermM <= FULL_DETAIL_M ? 'high' : 'firstPass';
  }
}
