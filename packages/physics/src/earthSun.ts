import { DEG, type Vec3 } from './vec';

const JD_AT_UNIX_EPOCH = 2440587.5;
const JD_J2000 = 2451545;
const DAY_MS = 86_400_000;
// General precession in ecliptic longitude, first order in time (IAU 2006), and the obliquity of the date (Meeus 22.2).
const PRECESSION_DEG_PER_CENTURY = 5028.796195 / 3600;
const OBLIQUITY_J2000_DEG = 23.439291111;
const OBLIQUITY_DEG_PER_CENTURY = -46.815 / 3600;

const wrapLonDeg = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Greenwich mean sidereal time in degrees (Meeus 12.4). UT1 is taken as UTC, which is within 0.9 s, or 0.004°. */
export function gmstDeg(tUtcMs: number): number {
  const days = tUtcMs / DAY_MS + JD_AT_UNIX_EPOCH - JD_J2000;
  const T = days / 36525;
  const deg = 280.46061837 + 360.98564736629 * days + 0.000387933 * T * T - (T * T * T) / 38_710_000;
  return ((deg % 360) + 360) % 360;
}

/**
 * Where the Sun is overhead on Earth: latitude and east-positive longitude, from the Sun's ECLIPJ2000 direction.
 * Precession and the obliquity of the date are applied; nutation (up to 0.005°), aberration and light time
 * (0.006°) are not, which is far finer than the day-night line needs.
 */
export function subsolarPoint(sunFromEarthKm: Vec3, tUtcMs: number): { latDeg: number; lonDeg: number } {
  const T = (tUtcMs / DAY_MS + JD_AT_UNIX_EPOCH - JD_J2000) / 36525;
  const turn = PRECESSION_DEG_PER_CENTURY * T * DEG;
  const obliquity = (OBLIQUITY_J2000_DEG + OBLIQUITY_DEG_PER_CENTURY * T) * DEG;
  // Turn the ecliptic about its pole to the equinox of the date, then tilt it onto the equator.
  const [x0, y0, z0] = sunFromEarthKm;
  const x = x0 * Math.cos(turn) - y0 * Math.sin(turn);
  const yEcl = x0 * Math.sin(turn) + y0 * Math.cos(turn);
  const y = yEcl * Math.cos(obliquity) - z0 * Math.sin(obliquity);
  const z = yEcl * Math.sin(obliquity) + z0 * Math.cos(obliquity);
  const rightAscensionDeg = Math.atan2(y, x) / DEG;
  return {
    latDeg: Math.asin(z / Math.hypot(x, y, z)) / DEG,
    lonDeg: wrapLonDeg(rightAscensionDeg - gmstDeg(tUtcMs)),
  };
}
