/** A camera flight as it starts: how long it takes, and how big a move it is. */
export interface Flight {
  durationMs: number;
  /** How much the camera's distance changes, as the size of the zoom: |ln(end / start)|. */
  zoom: number;
  /** How far round the camera swings, in radians. */
  turnRad: number;
  /** True for the pull back out to the whole solar system as you leave a world's own view. */
  back?: boolean;
}

type FlightListener = (flight: Flight) => void;
const listeners = new Set<FlightListener>();

/** Hears every camera flight any view starts, such as for a sound that follows the move. Returns a way to stop. */
export function onFlight(listener: FlightListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Each view tells the listeners as one of its flights starts. */
export function reportFlight(flight: Flight): void {
  if (!(flight.durationMs > 0)) return;
  for (const listener of listeners) listener(flight);
}

/** The angle between two directions, in radians, safe for slightly unnormalised input. */
export function angleBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const la = Math.hypot(a.x, a.y, a.z);
  const lb = Math.hypot(b.x, b.y, b.z);
  if (!la || !lb) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
}

/** The size of a zoom from one camera distance to another. */
export const zoomSize = (from: number, to: number): number => (from > 0 && to > 0 ? Math.abs(Math.log(to / from)) : 0);
