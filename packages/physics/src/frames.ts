import { cross, DEG, dot, norm, scale, sub, type Vec3 } from './vec';

export const MOON_RADIUS_KM = 1737.4;

export interface SiteFrame {
  pKm: Vec3;
  /** Local up, east and north unit vectors in the body-fixed frame. */
  u: Vec3;
  e: Vec3;
  n: Vec3;
}

export function siteFrame(
  latDeg: number,
  lonDeg: number,
  heightM = 0,
  observerHeightM = 0,
  radiusKm = MOON_RADIUS_KM,
): SiteFrame {
  const phi = latDeg * DEG;
  // At a pole, azimuth is measured from the 0° meridian by convention.
  const lam = (Math.abs(latDeg) === 90 ? 0 : lonDeg) * DEG;
  const u: Vec3 = [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
  const e: Vec3 = [-Math.sin(lam), Math.cos(lam), 0];
  return { pKm: scale(u, radiusKm + (heightM + observerHeightM) / 1000), u, e, n: cross(u, e) };
}

export interface ElevAz {
  elevDeg: number;
  /** Clockwise from local north, 0..360. */
  azDeg: number;
  distKm: number;
}

/** Direction of a target given in the same body-fixed frame as the site, seen from the site. */
export function elevAz(targetKm: Vec3, site: SiteFrame): ElevAz {
  const d = sub(targetKm, site.pKm);
  const distKm = norm(d);
  const s = scale(d, 1 / distKm);
  const elevDeg = Math.asin(Math.max(-1, Math.min(1, dot(s, site.u)))) / DEG;
  const az = Math.atan2(dot(s, site.e), dot(s, site.n)) / DEG;
  // A tiny negative angle plus 360 rounds to exactly 360, so wrap twice.
  return { elevDeg, azDeg: ((az % 360) + 360) % 360, distKm };
}
