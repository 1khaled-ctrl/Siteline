import { describe, expect, it } from 'vitest';
import { exposureFor, LEVEL_GROUND_SHOWN } from './surfaceView';

describe('surface exposure', () => {
  it('brightens the picture as the Sun nears the horizon, within a cap', () => {
    expect(exposureFor(1)).toBeGreaterThan(exposureFor(5));
    expect(exposureFor(5)).toBeGreaterThan(exposureFor(30));
    expect(exposureFor(-3)).toBe(6);
    expect(exposureFor(0.01)).toBeLessThanOrEqual(6);
  });

  it('shows level ground under a 1° Sun as it would show under a higher one', () => {
    // Level ground seen a few metres ahead (μ = 0.1): Lommel-Seeliger brightness 2μ₀/(μ₀ + μ), times the exposure.
    const shown = (elevDeg: number) => {
      const mu0 = Math.sin((elevDeg * Math.PI) / 180);
      return ((2 * mu0) / (mu0 + 0.1)) * exposureFor(elevDeg);
    };
    expect(shown(1)).toBeCloseTo(LEVEL_GROUND_SHOWN, 6);
    expect(shown(10)).toBeCloseTo(LEVEL_GROUND_SHOWN, 6);
  });
});
