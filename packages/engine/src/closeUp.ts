import * as THREE from 'three';
import type { Insets } from './screen';

/** Saturn's ring, as multiples of the planet's own size: drawn with these, and kept in view by a close-up. */
export const RING_INNER = 1.35;
export const RING_OUTER = 2.2;

/**
 * How much of the narrower half of the free view a close-up fills: about half, as the dive into the Earth, Moon and
 * Mars views does on a wide screen.
 */
export const CLOSE_UP_FILL = 0.5;

/** The radius a close-up keeps in view: the body, or the ring around it where it has one. */
export function fitRadius(size: number, ringOuter?: number): number {
  return ringOuter === undefined ? size : Math.max(size, size * ringOuter);
}

/**
 * How far from a body's centre the camera stops so that a sphere of `radius` fills `fill` of the narrower half of the
 * part of the view the app's panels leave free. A sphere at distance d projects to r / √(d² − r²) on the image plane,
 * against tan(fov / 2) for half the height; `fitCamera` moves the middle of the picture into the free part, which is
 * the canvas less the panels, so its half-width is that much narrower. A view with no size yet (hidden, or not laid out)
 * counts as square.
 */
export function closeUpDistance(
  radius: number,
  fovDeg: number,
  width: number,
  height: number,
  insets: Insets,
  fill = CLOSE_UP_FILL,
): number {
  const freeW = width - Math.abs(insets.left - insets.right);
  const ratio = height > 0 && freeW > 0 ? Math.min(1, freeW / height) : 1;
  const k = fill * Math.tan((fovDeg * Math.PI) / 360) * ratio;
  return radius * Math.sqrt(1 + 1 / (k * k));
}

/**
 * How close and how far the controls may go while beside a body: never inside it (or its ring), and never so far that
 * it is lost among the stars.
 */
export function closeUpLimits(fit: number, stop: number): { min: number; max: number } {
  return { min: fit * 1.25, max: Math.max(stop * 4, fit * 2) };
}

/** Where the camera is, seen from a body: how far, and in which direction (a unit vector). */
export function poseFrom(camera: THREE.Vector3, body: THREE.Vector3): { distance: number; dir: THREE.Vector3 } {
  const offset = camera.clone().sub(body);
  const distance = offset.length();
  return { distance, dir: distance > 0 ? offset.divideScalar(distance) : new THREE.Vector3(0, 1, 0) };
}
