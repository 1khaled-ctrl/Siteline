import { describe, expect, it } from 'vitest';
import { regionOf } from './pinned';

const regions = [
  { name: 'Haworth', lat: -86.8, lon: -22.8, sizeKm: 17 },
  { name: 'Next door', lat: -86.85, lon: -22.8, sizeKm: 17 },
  { name: 'Far', lat: -84, lon: 100, sizeKm: 10 },
];

describe('the region a pinned spot lies in', () => {
  it('names the region whose centre is within half its size, the nearest where two overlap', () => {
    expect(regionOf(-86.8, -22.8, regions)).toBe('Haworth');
    expect(regionOf(-86.86, -22.8, regions)).toBe('Next door');
  });

  it('leaves a spot outside every region, or in the north, unnamed', () => {
    // 0.3° of latitude is about 9 km: past half of 17 km from both centres.
    expect(regionOf(-86.4, -22.8, regions)).toBeUndefined();
    expect(regionOf(86.8, -22.8, regions)).toBeUndefined();
  });
});
