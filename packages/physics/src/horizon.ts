export const HORIZON_BINS = 720;
export const HORIZON_STEP_DEG = 360 / HORIZON_BINS;

/** Skyline elevation in degrees; bin i is at azimuth i × 0.5°. */
export type HorizonMask = Float32Array;

export const flatHorizon = (): HorizonMask => new Float32Array(HORIZON_BINS);

/** Masks are stored as int16 hundredths of a degree. */
export function horizonFromInt16(values: Int16Array): HorizonMask {
  if (values.length !== HORIZON_BINS)
    throw new Error(`horizon mask needs ${HORIZON_BINS} values, got ${values.length}`);
  return Float32Array.from(values, (v) => v / 100);
}

export function horizonAt(mask: HorizonMask, azDeg: number): number {
  const x = (((azDeg % 360) + 360) % 360) / HORIZON_STEP_DEG;
  const i = Math.floor(x);
  const a = mask[i % HORIZON_BINS];
  const b = mask[(i + 1) % HORIZON_BINS];
  return a + (b - a) * (x - i);
}
