import type { Vec3 } from './vec';

export type EphemBody = 'sun' | 'earth';

/** Positions relative to the Moon's centre, in kilometres, in the Moon's body-fixed frame. */
export interface Ephemeris {
  readonly startUtcMs: number;
  readonly endUtcMs: number;
  positionKm(body: EphemBody, tUtcMs: number): Vec3;
}

export interface EphemerisHeader {
  format: string;
  frame: string;
  centre: string;
  abcorr: string;
  bodies: string[];
  units: string;
  startUtc: string;
  startUtcMs: number;
  stepMs: number;
  count: number;
  kernels: string[];
  dataSha256: string;
}

export const EPHEMERIS_FORMAT = 'siteline-ephem-1';
const FLOATS_PER_SAMPLE = 6;

export class EphemerisTable implements Ephemeris {
  readonly startUtcMs: number;
  readonly endUtcMs: number;

  constructor(
    readonly header: EphemerisHeader,
    private readonly data: Float32Array,
  ) {
    if (header.format !== EPHEMERIS_FORMAT) throw new Error(`unknown ephemeris format ${header.format}`);
    if (data.length !== header.count * FLOATS_PER_SAMPLE)
      throw new Error('ephemeris data length does not match header');
    this.startUtcMs = header.startUtcMs;
    this.endUtcMs = header.startUtcMs + (header.count - 1) * header.stepMs;
  }

  positionKm(body: EphemBody, tUtcMs: number): Vec3 {
    const x = (tUtcMs - this.startUtcMs) / this.header.stepMs;
    if (!(x >= 0 && x <= this.header.count - 1)) {
      throw new RangeError(`${new Date(tUtcMs).toISOString()} is outside the ephemeris table`);
    }
    const i = Math.min(Math.floor(x), this.header.count - 2);
    const f = x - i;
    const a = i * FLOATS_PER_SAMPLE + (body === 'sun' ? 0 : 3);
    const b = a + FLOATS_PER_SAMPLE;
    const d = this.data;
    return [d[a] + (d[b] - d[a]) * f, d[a + 1] + (d[b + 1] - d[a + 1]) * f, d[a + 2] + (d[b + 2] - d[a + 2]) * f];
  }
}

/** Layout: uint32 LE header length, UTF-8 JSON header, padding to 4 bytes, float32 LE samples (sun xyz, earth xyz). */
export function parseEphemeris(buf: ArrayBuffer): EphemerisTable {
  const headerLen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as EphemerisHeader;
  const offset = Math.ceil((4 + headerLen) / 4) * 4;
  return new EphemerisTable(header, new Float32Array(buf, offset, header.count * FLOATS_PER_SAMPLE));
}
