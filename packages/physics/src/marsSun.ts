import { DEG, type Vec3 } from './vec';

const J2000_UTC_MS = Date.UTC(2000, 0, 1, 12);
// Ephemeris time (TDB) minus UTC since the leap second of 1 January 2017: 37 s of TAI−UTC and 32.184 s of TT−TAI.
// TDB−TT swings by under 2 ms, which turns Mars by 0.00001°. Add a leap second here if one is ever declared.
const ET_MINUS_UTC_S = 69.184;
const OBLIQUITY_J2000_DEG = 23.439291111;

// IAU 2015 rotation of Mars, as written in NAIF's pck00011.tpc (BODY499_*): pole right ascension and declination in
// degrees per Julian century (T), prime meridian in degrees per day (d), and the periodic terms in the precession
// angles (BODY4_NUT_PREC_ANGLES 11 to 26), each an angle at J2000 and its rate per century.
const POLE_RA_DEG = [317.269202, -0.10927547];
const POLE_DEC_DEG = [54.432516, -0.05827105];
const PRIME_MERIDIAN_DEG = [176.049863, 350.891982443297];
type Term = { amplitudeDeg: number; angleDeg: number; ratePerCentury: number };
const RA_TERMS: Term[] = [
  { amplitudeDeg: 0.000068, angleDeg: 198.991226, ratePerCentury: 19139.4819985 },
  { amplitudeDeg: 0.000238, angleDeg: 226.292679, ratePerCentury: 38280.8511281 },
  { amplitudeDeg: 0.000052, angleDeg: 249.663391, ratePerCentury: 57420.7251593 },
  { amplitudeDeg: 0.000009, angleDeg: 266.18351, ratePerCentury: 76560.636795 },
  { amplitudeDeg: 0.419057, angleDeg: 79.398797, ratePerCentury: 0.5042615 },
];
const DEC_TERMS: Term[] = [
  { amplitudeDeg: 0.000051, angleDeg: 122.433576, ratePerCentury: 19139.9407476 },
  { amplitudeDeg: 0.000141, angleDeg: 43.058401, ratePerCentury: 38280.8753272 },
  { amplitudeDeg: 0.000031, angleDeg: 57.663379, ratePerCentury: 57420.7517205 },
  { amplitudeDeg: 0.000005, angleDeg: 79.476401, ratePerCentury: 76560.6495004 },
  { amplitudeDeg: 1.591274, angleDeg: 166.325722, ratePerCentury: 0.5042615 },
];
const PM_TERMS: Term[] = [
  { amplitudeDeg: 0.000145, angleDeg: 129.071773, ratePerCentury: 19140.0328244 },
  { amplitudeDeg: 0.000157, angleDeg: 36.352167, ratePerCentury: 38281.0473591 },
  { amplitudeDeg: 0.00004, angleDeg: 56.668646, ratePerCentury: 57420.929536 },
  { amplitudeDeg: 0.000001, angleDeg: 67.364003, ratePerCentury: 76560.2552215 },
  { amplitudeDeg: 0.000001, angleDeg: 104.79268, ratePerCentury: 95700.4387578 },
  { amplitudeDeg: 0.584542, angleDeg: 95.391654, ratePerCentury: 0.5042615 },
];

const wrapLonDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
const series = (terms: Term[], T: number, f: (rad: number) => number) =>
  terms.reduce((sum, t) => sum + t.amplitudeDeg * f((t.angleDeg + t.ratePerCentury * T) * DEG), 0);

/** Seconds past J2000 in ephemeris time (TDB), from a UTC time in the years after 2017. */
export function etSeconds(tUtcMs: number): number {
  return (tUtcMs - J2000_UTC_MS) / 1000 + ET_MINUS_UTC_S;
}

/** Where Mars's north pole points (J2000 equator) and how far it has turned about it, in degrees. */
export function marsOrientation(tUtcMs: number): { raDeg: number; decDeg: number; primeMeridianDeg: number } {
  const et = etSeconds(tUtcMs);
  const d = et / 86_400;
  const T = d / 36525;
  return {
    raDeg: POLE_RA_DEG[0] + POLE_RA_DEG[1] * T + series(RA_TERMS, T, Math.sin),
    decDeg: POLE_DEC_DEG[0] + POLE_DEC_DEG[1] * T + series(DEC_TERMS, T, Math.cos),
    primeMeridianDeg: PRIME_MERIDIAN_DEG[0] + PRIME_MERIDIAN_DEG[1] * d + series(PM_TERMS, T, Math.sin),
  };
}

/**
 * Where the Sun is overhead on Mars: planetocentric latitude and east-positive longitude (IAU_MARS), from the Sun's
 * ECLIPJ2000 direction as seen from Mars. Geometric, so light time (a few minutes of Mars turning, 1°) is not applied.
 */
export function marsSubsolarPoint(sunFromMarsKm: Vec3, tUtcMs: number): { latDeg: number; lonDeg: number } {
  const { raDeg, decDeg, primeMeridianDeg } = marsOrientation(tUtcMs);
  // Ecliptic to the J2000 equator: tilt about the x axis by the obliquity.
  const eps = OBLIQUITY_J2000_DEG * DEG;
  const [x0, y0, z0] = sunFromMarsKm;
  let x = x0;
  let y = y0 * Math.cos(eps) - z0 * Math.sin(eps);
  let z = y0 * Math.sin(eps) + z0 * Math.cos(eps);
  // J2000 to the Mars-fixed frame: Rz(W) · Rx(90° − dec) · Rz(90° + ra), each turning the axes, not the vector.
  const turnZ = (deg: number) => {
    const a = deg * DEG;
    [x, y] = [x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a)];
  };
  turnZ(90 + raDeg);
  const tilt = (90 - decDeg) * DEG;
  [y, z] = [y * Math.cos(tilt) + z * Math.sin(tilt), -y * Math.sin(tilt) + z * Math.cos(tilt)];
  turnZ(primeMeridianDeg);
  return { latDeg: Math.asin(z / Math.hypot(x, y, z)) / DEG, lonDeg: wrapLonDeg(Math.atan2(y, x) / DEG) };
}
