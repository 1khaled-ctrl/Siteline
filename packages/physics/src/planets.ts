import type { Vec3 } from './vec';

export const PLANET_NAMES = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
export type PlanetName = (typeof PLANET_NAMES)[number];
/** The Moon's position is relative to the Earth; every planet's is relative to the Sun. */
export type SolarBodyKey = PlanetName | 'moon';

export const PLANETS_FORMAT = 'siteline-planets-1';
export const KM_PER_AU = 149_597_870.7;

const BODY_KEYS: SolarBodyKey[] = [...PLANET_NAMES, 'moon'];
const FLOATS_PER_SAMPLE = BODY_KEYS.length * 3;

export interface PlanetsHeader {
  format: string;
  frame: string;
  bodies: string[];
  units: string;
  startUtcMs: number;
  stepMs: number;
  count: number;
  orbitPoints: number;
  orbitPeriodsDays: number[];
  kernels: string[];
}

/** Positions in km in ECLIPJ2000, sampled every 12 hours, plus one full orbit of each planet for drawing. */
export class PlanetTable {
  readonly startUtcMs: number;
  readonly endUtcMs: number;

  constructor(
    readonly header: PlanetsHeader,
    private readonly samples: Float32Array,
    private readonly orbits: Float32Array,
  ) {
    if (header.format !== PLANETS_FORMAT) throw new Error(`unknown planets format ${header.format}`);
    if (samples.length !== header.count * FLOATS_PER_SAMPLE) throw new Error('planet samples do not match the header');
    if (orbits.length !== PLANET_NAMES.length * header.orbitPoints * 3) {
      throw new Error('planet orbits do not match the header');
    }
    this.startUtcMs = header.startUtcMs;
    this.endUtcMs = header.startUtcMs + (header.count - 1) * header.stepMs;
  }

  positionKm(body: SolarBodyKey, tUtcMs: number): Vec3 {
    const x = (tUtcMs - this.startUtcMs) / this.header.stepMs;
    if (!(x >= 0 && x <= this.header.count - 1)) {
      throw new RangeError(`${new Date(tUtcMs).toISOString()} is outside the planets table`);
    }
    const i = Math.min(Math.floor(x), this.header.count - 2);
    const f = x - i;
    const a = i * FLOATS_PER_SAMPLE + BODY_KEYS.indexOf(body) * 3;
    const b = a + FLOATS_PER_SAMPLE;
    const d = this.samples;
    return [d[a] + (d[b] - d[a]) * f, d[a + 1] + (d[b + 1] - d[a + 1]) * f, d[a + 2] + (d[b + 2] - d[a + 2]) * f];
  }

  /** Every planet's position at one instant. */
  snapshot(tUtcMs: number): Record<SolarBodyKey, Vec3> {
    return Object.fromEntries(BODY_KEYS.map((k) => [k, this.positionKm(k, tUtcMs)])) as Record<SolarBodyKey, Vec3>;
  }

  /** One full orbit as x, y, z triples in km (a closed loop; the last point is not repeated). */
  orbitKm(planet: PlanetName): Float32Array {
    const n = this.header.orbitPoints * 3;
    const start = PLANET_NAMES.indexOf(planet) * n;
    return this.orbits.slice(start, start + n);
  }
}

/** Layout: uint32 LE header length, UTF-8 JSON header, padding to 4 bytes, float32 samples, float32 orbits. */
export function parsePlanets(buf: ArrayBuffer): PlanetTable {
  const headerLen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as PlanetsHeader;
  const offset = Math.ceil((4 + headerLen) / 4) * 4;
  const sampleFloats = header.count * FLOATS_PER_SAMPLE;
  return new PlanetTable(
    header,
    new Float32Array(buf, offset, sampleFloats),
    new Float32Array(buf, offset + sampleFloats * 4, PLANET_NAMES.length * header.orbitPoints * 3),
  );
}
