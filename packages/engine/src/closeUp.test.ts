import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CLOSE_UP_FILL, closeUpDistance, closeUpLimits, fitRadius, poseFrom, RING_OUTER } from './closeUp';

/** The solar view's camera: 42° from top to bottom. */
const FOV = 42;
const PANEL = { left: 0, right: 422 };
const NONE = { left: 0, right: 0 };

/** How big a sphere looks from `d`: its silhouette's radius on the image plane, against the half-height there. */
const projected = (r: number, d: number) => r / Math.sqrt(d * d - r * r);

describe('closeUpDistance', () => {
  it('stops about 5.3 radii away on a wide screen with the panel open, close to the dive into the Earth views', () => {
    expect(closeUpDistance(1, FOV, 1600, 900, PANEL)).toBeCloseTo(5.305, 3);
  });

  it('stands about twice as far back on an upright phone, whose narrower side is its width', () => {
    const phone = closeUpDistance(1, FOV, 390, 844, NONE);
    expect(phone).toBeCloseTo(11.32, 2);
    expect(phone / closeUpDistance(1, FOV, 1600, 900, PANEL)).toBeGreaterThan(2);
  });

  it('fills exactly `fill` of the narrower half of the free view', () => {
    const halfHeight = Math.tan((FOV * Math.PI) / 360);
    const wide = closeUpDistance(1.75, FOV, 1600, 900, PANEL);
    expect(projected(1.75, wide)).toBeCloseTo(CLOSE_UP_FILL * halfHeight, 12);
    // On the phone the width is the narrower side: half of it, at the same scale as the height.
    const phone = closeUpDistance(1.75, FOV, 390, 844, NONE);
    expect(projected(1.75, phone)).toBeCloseTo(CLOSE_UP_FILL * halfHeight * (390 / 844), 12);
  });

  it('counts the panel: the narrower the free part, the further back', () => {
    const half = closeUpDistance(1, FOV, 1200, 900, { left: 0, right: 600 });
    expect(half).toBeGreaterThan(closeUpDistance(1, FOV, 1200, 900, NONE));
    // A panel on the start edge narrows the free part just the same.
    expect(closeUpDistance(1, FOV, 1200, 900, { left: 600, right: 0 })).toBeCloseTo(half, 12);
  });

  it("keeps Saturn's ring in view, not just its disc, and takes a view with no size yet as square", () => {
    expect(fitRadius(1.5, RING_OUTER)).toBeCloseTo(3.3, 12);
    expect(fitRadius(1.5)).toBe(1.5);
    expect(closeUpDistance(fitRadius(1.5, RING_OUTER), FOV, 390, 844, NONE)).toBeGreaterThan(
      closeUpDistance(1.5, FOV, 390, 844, NONE),
    );
    const unsized = closeUpDistance(1, FOV, 0, 0, NONE);
    expect(Number.isFinite(unsized)).toBe(true);
    expect(unsized).toBeCloseTo(closeUpDistance(1, FOV, 900, 900, NONE), 12);
  });
});

describe('closeUpLimits', () => {
  it('never lets the camera inside the body or its ring, and keeps the stop between the limits', () => {
    const fit = fitRadius(1.5, RING_OUTER);
    const stop = closeUpDistance(fit, FOV, 1600, 900, PANEL);
    const { min, max } = closeUpLimits(fit, stop);
    expect(min).toBeGreaterThan(fit);
    expect(min).toBeLessThan(stop);
    expect(max).toBeGreaterThan(stop);
  });
});

describe('poseFrom', () => {
  it("gives the camera's distance and its direction from the body, so the way back starts exactly there", () => {
    const { distance, dir } = poseFrom(new THREE.Vector3(13, 4, 0), new THREE.Vector3(10, 0, 0));
    expect(distance).toBeCloseTo(5, 12);
    expect(dir.x).toBeCloseTo(0.6, 12);
    expect(dir.y).toBeCloseTo(0.8, 12);
    expect(dir.length()).toBeCloseTo(1, 12);
    // A camera exactly at the body still gets a direction.
    expect(poseFrom(new THREE.Vector3(1, 2, 3), new THREE.Vector3(1, 2, 3)).dir.length()).toBe(1);
  });
});
