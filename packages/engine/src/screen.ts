import type * as THREE from 'three';

/** A point of a 3D view on the page, in CSS pixels from the window's top left. */
export interface ScreenPoint {
  x: number;
  y: number;
  /** How far the point is from the camera, in the view's own scene units; only compare within one view. */
  depth: number;
  /** In front of the camera and on the canvas (and, on a globe, on the near side). */
  visible: boolean;
}

/** How much of a view's canvas the app's floating panels cover, in CSS pixels from each edge. */
export interface Insets {
  left: number;
  right: number;
}

export const NO_INSETS: Insets = { left: 0, right: 0 };

/**
 * Sizes a camera to a `w` × `h` canvas and moves the middle of the picture into the part the panels leave free, so a
 * world sits in the middle of what you can see while the canvas still runs on under the panels. The picture keeps its
 * scale: only the horizontal frame grows, and the vertical field of view is untouched.
 */
export function fitCamera(camera: THREE.PerspectiveCamera, w: number, h: number, insets: Insets): void {
  const dx = (insets.left - insets.right) / 2;
  const fullW = w + 2 * Math.abs(dx);
  camera.aspect = fullW / h;
  if (dx) camera.setViewOffset(fullW, h, dx < 0 ? -2 * dx : 0, 0, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

/** Where a point in scene space falls on the page. */
export function toScreen(
  point: THREE.Vector3,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLElement,
  scratch: THREE.Vector3,
): ScreenPoint {
  const rect = canvas.getBoundingClientRect();
  const depth = point.distanceTo(camera.position);
  scratch.copy(point).project(camera);
  return {
    x: rect.left + ((scratch.x + 1) / 2) * rect.width,
    y: rect.top + ((1 - scratch.y) / 2) * rect.height,
    depth,
    visible: scratch.z < 1 && Math.abs(scratch.x) <= 1 && Math.abs(scratch.y) <= 1,
  };
}
