import { describe, expect, it } from 'vitest';
import { confidenceOf, FULL_DETAIL_M, SLOPE_NEEDS_M } from './confidence';

describe('confidenceOf', () => {
  const loaded = { terrainM: 1200, longTermM: 2400 };

  it("calls the horizon readings a first pass on today's 1.2 km terrain, and high at LOLA's full 240 m", () => {
    expect(confidenceOf('sun', loaded)).toBe('firstPass');
    expect(confidenceOf('earth', loaded)).toBe('firstPass');
    expect(confidenceOf('sun', { terrainM: FULL_DETAIL_M })).toBe('high');
    expect(confidenceOf('height', { terrainM: 60 })).toBe('high');
  });

  it('says the horizon was taken as flat when the spot is off the terrain', () => {
    expect(confidenceOf('sun', {})).toBe('flatHorizon');
    expect(confidenceOf('height', {})).toBe('notMeasured');
  });

  it('measures the slope only on terrain at least as fine as its 100 m baseline', () => {
    expect(confidenceOf('slope', loaded)).toBe('notMeasured');
    expect(confidenceOf('slope', { terrainM: FULL_DETAIL_M })).toBe('notMeasured');
    expect(confidenceOf('slope', { terrainM: SLOPE_NEEDS_M })).toBe('high');
  });

  it('trusts a slope measured on the 10 m terrain, whatever the coarser terrain under the horizon', () => {
    expect(confidenceOf('slope', { ...loaded, slopeM: 10 })).toBe('high');
    expect(confidenceOf('slope', { terrainM: 60, slopeM: 240 })).toBe('notMeasured');
  });

  it('trusts the Artemis zone whatever the terrain, since only the latitude matters', () => {
    expect(confidenceOf('zone', {})).toBe('high');
    expect(confidenceOf('zone', loaded)).toBe('high');
  });

  it('rates the 19-year readings by the grid of their own map', () => {
    expect(confidenceOf('longTerm', loaded)).toBe('firstPass');
    expect(confidenceOf('longTerm', {})).toBe('notMeasured');
  });
});
