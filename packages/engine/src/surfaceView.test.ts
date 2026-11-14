import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cameraHeadingDeg, exposureFor, LEVEL_GROUND_SHOWN } from './surfaceView';

/** The angle between two headings, degrees, the short way round. */
const gapDeg = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

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

describe('compass heading', () => {
  it('reads the walk’s heading back from the camera, clockwise from north, at any pitch', () => {
    const camera = new THREE.PerspectiveCamera();
    for (const headingDeg of [0, 30, 90, 179, 181, 270, 359, 400, -45]) {
      for (const pitchDeg of [-80, -10, 0, 45, 84]) {
        // As the view turns the camera while walking: pitch about x, then the heading about up, clockwise.
        camera.rotation.set((pitchDeg * Math.PI) / 180, (-headingDeg * Math.PI) / 180, 0, 'YXZ');
        camera.updateMatrixWorld();
        const read = cameraHeadingDeg(camera);
        expect(read).toBeGreaterThanOrEqual(0);
        expect(read).toBeLessThan(360);
        expect(gapDeg(read, headingDeg)).toBeLessThan(1e-9);
      }
    }
  });

  it('faces north along the scene’s −z and east along +x', () => {
    const camera = new THREE.PerspectiveCamera();
    const at = (x: number, z: number) => {
      camera.lookAt(x, 0, z);
      camera.updateMatrixWorld();
      return cameraHeadingDeg(camera);
    };
    expect(gapDeg(at(0, -1), 0)).toBeLessThan(1e-9);
    expect(gapDeg(at(1, 0), 90)).toBeLessThan(1e-9);
    expect(gapDeg(at(0, 1), 180)).toBeLessThan(1e-9);
    expect(gapDeg(at(-1, 0), 270)).toBeLessThan(1e-9);
  });
});
