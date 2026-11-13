import * as THREE from 'three';

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

/** A globe's outline on the page: its centre and its radius in CSS pixels. */
export interface ScreenDisc {
  x: number;
  y: number;
  r: number;
}

/** Where a sphere of `radius` around the scene's origin appears; null when the camera is inside it. */
export function discToScreen(
  radius: number,
  camera: THREE.PerspectiveCamera,
  canvas: HTMLElement,
  scratch: THREE.Vector3,
): ScreenDisc | null {
  const d = camera.position.length();
  if (d <= radius) return null;
  camera.updateMatrixWorld();
  const centre = toScreen(scratch.set(0, 0, 0), camera, canvas, scratch);
  // The outline's angular radius, as a share of half the vertical field of view, in pixels.
  const h = canvas.getBoundingClientRect().height;
  const r = (Math.tan(Math.asin(radius / d)) / Math.tan((camera.fov * Math.PI) / 360)) * (h / 2);
  return { x: centre.x, y: centre.y, r };
}

/** Views that tell overlays when they have drawn, so what follows them moves in the same frame. */
export interface FrameSource {
  /** Calls `listener` after every draw; returns a function that stops it. */
  addFrameListener(listener: () => void): () => void;
}

/**
 * A small turn of the camera on top of where its controls point it, for looking around a view as if through a window
 * (the phone's tilt-to-look). Safe to apply before every draw: it undoes its own last turn first, so it never builds up.
 */
export class LookOffset {
  private yaw = 0;
  private pitch = 0;
  private applied = false;
  private readonly base = new THREE.Quaternion();
  private readonly result = new THREE.Quaternion();

  /** The turn, in radians: yaw to the left, pitch up. Returns true if it changed. */
  set(yaw: number, pitch: number): boolean {
    if (yaw === this.yaw && pitch === this.pitch) return false;
    this.yaw = yaw;
    this.pitch = pitch;
    return true;
  }

  apply(camera: THREE.PerspectiveCamera): void {
    if (this.applied && camera.quaternion.equals(this.result)) camera.quaternion.copy(this.base);
    this.applied = false;
    if (!this.yaw && !this.pitch) return;
    this.base.copy(camera.quaternion);
    camera.rotateY(this.yaw);
    camera.rotateX(this.pitch);
    camera.updateMatrixWorld();
    this.result.copy(camera.quaternion);
    this.applied = true;
  }
}
