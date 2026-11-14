import { type HeightSource, MOON_RADIUS_M, polarXY } from './dem';
import { discFraction } from './disc';
import { siteFrame } from './frames';
import { DEG, type Vec3 } from './vec';

/**
 * The surface view ("Land Here"): the ground around one landing point, rebuilt from the terrain at real scale in a local
 * frame centred on that point, and the Sun's light on it worked out from the same heights.
 *
 * Units: metres throughout, angles in radians inside and degrees in names ending in `Deg`.
 */

/** The eye height the surface view stands at, metres above the ground: a standing astronaut's eyes, roughly. */
export const EYE_HEIGHT_M = 1.7;

/**
 * A local east-north-up frame on the Moon, with its origin on the ground at a site. East, north and up are the site's
 * own (`siteFrame`), so at the pole north is the 0° meridian, as everywhere else in SiteLine.
 */
export interface LocalFrame {
  latDeg: number;
  lonDeg: number;
  /** The ground's height at the site above the 1737.4 km reference sphere, metres. */
  groundHeightM: number;
  /** The origin: the ground at the site, metres from the Moon's centre in the body-fixed frame. */
  origin: Vec3;
  u: Vec3;
  e: Vec3;
  n: Vec3;
}

export function localFrame(latDeg: number, lonDeg: number, groundHeightM: number): LocalFrame {
  const { u, e, n } = siteFrame(latDeg, lonDeg);
  const r = MOON_RADIUS_M + groundHeightM;
  return { latDeg, lonDeg, groundHeightM, origin: [u[0] * r, u[1] * r, u[2] * r], u, e, n };
}

/** A body-fixed point (metres from the Moon's centre) as local east, north and up, metres. */
export function bodyToLocal(f: LocalFrame, p: Vec3): Vec3 {
  const d0 = p[0] - f.origin[0];
  const d1 = p[1] - f.origin[1];
  const d2 = p[2] - f.origin[2];
  return [
    d0 * f.e[0] + d1 * f.e[1] + d2 * f.e[2],
    d0 * f.n[0] + d1 * f.n[1] + d2 * f.n[2],
    d0 * f.u[0] + d1 * f.u[1] + d2 * f.u[2],
  ];
}

/** A point given by latitude, east-positive longitude and height above the reference sphere, in local metres. */
export function geoToLocal(f: LocalFrame, latDeg: number, lonDeg: number, heightM: number): Vec3 {
  const phi = latDeg * DEG;
  const lam = lonDeg * DEG;
  const r = MOON_RADIUS_M + heightM;
  return bodyToLocal(f, [r * Math.cos(phi) * Math.cos(lam), r * Math.cos(phi) * Math.sin(lam), r * Math.sin(phi)]);
}

/** The inverse of `geoToLocal`: latitude, longitude (wrapped to ±180°) and height of a local point. */
export function localToGeo(
  f: LocalFrame,
  east: number,
  north: number,
  up = 0,
): { latDeg: number; lonDeg: number; heightM: number } {
  const p: Vec3 = [
    f.origin[0] + east * f.e[0] + north * f.n[0] + up * f.u[0],
    f.origin[1] + east * f.e[1] + north * f.n[1] + up * f.u[1],
    f.origin[2] + east * f.e[2] + north * f.n[2] + up * f.u[2],
  ];
  const r = Math.hypot(p[0], p[1], p[2]);
  return {
    latDeg: Math.asin(Math.max(-1, Math.min(1, p[2] / r))) / DEG,
    lonDeg: Math.atan2(p[1], p[0]) / DEG,
    heightM: r - MOON_RADIUS_M,
  };
}

/** A body-fixed direction (any length) as a unit vector in local east, north, up. */
export function localDirection(f: LocalFrame, d: Vec3): Vec3 {
  const len = Math.hypot(d[0], d[1], d[2]);
  return [
    (d[0] * f.e[0] + d[1] * f.e[1] + d[2] * f.e[2]) / len,
    (d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2]) / len,
    (d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2]) / len,
  ];
}

/**
 * Local up, metres, of the terrain at local east and north: where the ground is, straight above or below that spot on
 * the site's horizontal plane. The Moon's curvature is in it (about 1.2 m lower 2 km out, 26 km lower 300 km out), and
 * the heights are the terrain's own, never stretched. NaN where no source has a height.
 *
 * `heights` are read in LOLA's south polar plane (`polarXY`), finest first; `used` gets the index of the source that
 * answered, or -1.
 */
export function surfaceUpAt(
  f: LocalFrame,
  sources: readonly HeightSource[],
  east: number,
  north: number,
  used?: { index: number },
): number {
  const r0 = MOON_RADIUS_M + f.groundHeightM;
  const across = east * east + north * north;
  let up = 0;
  let index = -1;
  // The ground point S = (R + h) q must have local east and north (east, north); q depends on h only slightly, so a
  // few rounds settle it (to under a millimetre 2 km out, and about a metre 300 km out).
  for (let round = 0; round < 4; round++) {
    const k = r0 + up;
    const p0 = f.origin[0] / r0;
    const p1 = f.origin[1] / r0;
    const p2 = f.origin[2] / r0;
    const x = k * p0 + east * f.e[0] + north * f.n[0];
    const y = k * p1 + east * f.e[1] + north * f.n[1];
    const z = k * p2 + east * f.e[2] + north * f.n[2];
    const len = Math.hypot(x, y, z);
    const q = polarXY([x / len, y / len, z / len]);
    let h = Number.NaN;
    index = -1;
    for (let i = 0; i < sources.length; i++) {
      h = sources[i].heightAt(q.x, q.y);
      if (Number.isFinite(h)) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      if (used) used.index = -1;
      return Number.NaN;
    }
    const rr = MOON_RADIUS_M + h;
    const under = rr * rr - across;
    if (!(under > 0)) {
      if (used) used.index = -1;
      return Number.NaN;
    }
    up = Math.sqrt(under) - r0;
  }
  if (used) used.index = index;
  return up;
}

/**
 * A square heightfield on the site's horizontal plane: `size` × `size` nodes `spacingM` apart, centred on the origin.
 * Row 0 is the northern edge and rows run south; within a row, nodes run west to east. That is three.js's x = east,
 * z = −north, with the node (col, row) at x = −halfM + col·spacingM, z = −halfM + row·spacingM.
 */
export interface LocalGrid {
  size: number;
  spacingM: number;
  halfM: number;
  /** Local up of the ground at each node, metres; NaN where there is no data. */
  up: Float32Array;
  /** Which source gave each node its height (0 is the finest), 255 where none had one. */
  from?: Uint8Array;
}

/** The terrain resampled onto a local grid; see `LocalGrid` and `surfaceUpAt`. */
export function resampleToLocal(
  f: LocalFrame,
  sources: readonly HeightSource[],
  spacingM: number,
  halfM: number,
): LocalGrid {
  const cells = Math.round((2 * halfM) / spacingM);
  if (!(cells >= 1) || Math.abs(cells * spacingM - 2 * halfM) > 1e-6)
    throw new Error(`a local grid's side (${2 * halfM} m) must be a whole number of cells of ${spacingM} m`);
  const size = cells + 1;
  const up = new Float32Array(size * size);
  const from = new Uint8Array(size * size);
  const used = { index: -1 };
  for (let row = 0; row < size; row++) {
    const north = halfM - row * spacingM;
    for (let col = 0; col < size; col++) {
      const east = -halfM + col * spacingM;
      const i = row * size + col;
      up[i] = surfaceUpAt(f, sources, east, north, used);
      from[i] = used.index < 0 ? 255 : used.index;
    }
  }
  return { size, spacingM, halfM, up, from };
}

/**
 * The ground's local up at any east and north inside the grid, on the same two triangles per cell the surface is drawn
 * with (each cell split along its north-east to south-west diagonal), so the camera's height and the drawn ground
 * agree exactly. NaN outside the grid or where a corner has no data.
 */
export function gridUpAt(grid: LocalGrid, east: number, north: number): number {
  const last = grid.size - 1;
  // A point a rounding error outside the edge is on it.
  const fx = Math.min(last, Math.max(0, (east + grid.halfM) / grid.spacingM));
  const fz = Math.min(last, Math.max(0, (grid.halfM - north) / grid.spacingM));
  const slack = 1e-6 * last;
  if (
    !(
      (east + grid.halfM) / grid.spacingM >= -slack &&
      (grid.halfM - north) / grid.spacingM >= -slack &&
      (east + grid.halfM) / grid.spacingM <= last + slack &&
      (grid.halfM - north) / grid.spacingM <= last + slack
    )
  )
    return Number.NaN;
  const c = Math.min(Math.floor(fx), last - 1);
  const r = Math.min(Math.floor(fz), last - 1);
  const x = fx - c;
  const z = fz - r;
  const a = r * grid.size + c; // north-west
  const ha = grid.up[a];
  const hb = grid.up[a + 1]; // north-east
  const hc = grid.up[a + grid.size]; // south-west
  if (x + z <= 1) return ha + (hb - ha) * x + (hc - ha) * z;
  const hd = grid.up[a + grid.size + 1]; // south-east
  return hd + (hc - hd) * (1 - x) + (hb - hd) * (1 - z);
}

/** The ground under a point from the finest of several nested grids that has it there (finest first). */
export function levelsUpAt(grids: readonly LocalGrid[], east: number, north: number): number {
  for (const g of grids) {
    const h = gridUpAt(g, east, north);
    if (Number.isFinite(h)) return h;
  }
  return Number.NaN;
}

/** Where an eye at `eyeHeightM` above the ground is, as local up; NaN where there is no ground. */
export function eyeUpAt(grid: LocalGrid, east: number, north: number, eyeHeightM = EYE_HEIGHT_M): number {
  return gridUpAt(grid, east, north) + eyeHeightM;
}

/** Why a step was refused: the edge of the walkable terrain, or a hole in it where the data has no heights. */
export type MoveBlock = 'edge' | 'nodata';

/**
 * A step from one spot to another on the walkable grid, kept on terrain that exists: inside the grid less `marginM`,
 * and off cells without data. A step that would leave slides along whichever axis still can, as a wall does.
 */
export function clampMove(
  grid: LocalGrid,
  from: { east: number; north: number },
  to: { east: number; north: number },
  marginM: number,
): { east: number; north: number; blocked: MoveBlock | null } {
  const limit = grid.halfM - marginM;
  const ok = (e: number, n: number): MoveBlock | null => {
    if (Math.abs(e) > limit || Math.abs(n) > limit) return 'edge';
    return Number.isFinite(gridUpAt(grid, e, n)) ? null : 'nodata';
  };
  const direct = ok(to.east, to.north);
  if (direct === null) return { ...to, blocked: null };
  if (ok(to.east, from.north) === null) return { east: to.east, north: from.north, blocked: direct };
  if (ok(from.east, to.north) === null) return { east: from.east, north: to.north, blocked: direct };
  return { ...from, blocked: direct };
}

/** Elevation and azimuth (clockwise from north) of a local direction, degrees. */
export function localElevAz(dir: Vec3): { elevDeg: number; azDeg: number } {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  const elevDeg = Math.asin(Math.max(-1, Math.min(1, dir[2] / len))) / DEG;
  const az = Math.atan2(dir[0], dir[1]) / DEG;
  return { elevDeg, azDeg: ((az % 360) + 360) % 360 };
}

/** Nested grids, finest first, with what a walk needs to stop early. */
export interface RayGrids {
  grids: readonly LocalGrid[];
  /** The highest ground in each grid and every coarser one. */
  maxUpOnward: number[];
}

/** Prepares nested grids (finest first, each centred on the origin) for many skyline walks. */
export function rayGrids(grids: readonly LocalGrid[]): RayGrids {
  const max = grids.map((g) => {
    let m = Number.NEGATIVE_INFINITY;
    for (const v of g.up) if (v > m) m = v;
    return m;
  });
  return { grids, maxUpOnward: grids.map((_, i) => Math.max(...max.slice(i))) };
}

/** Distance along a horizontal ray from (e, n) in direction (de, dn) to where it leaves a grid's square. */
function exitDistance(g: LocalGrid, e: number, n: number, de: number, dn: number): number {
  const h = g.halfM;
  const te = de > 0 ? (h - e) / de : de < 0 ? (-h - e) / de : Number.POSITIVE_INFINITY;
  const tn = dn > 0 ? (h - n) / dn : dn < 0 ? (-h - n) / dn : Number.POSITIVE_INFINITY;
  return Math.min(te, tn);
}

export interface HorizonWalk {
  /** Skip ground closer than this, metres, so a point does not shade itself. */
  minDistM: number;
  /** Stop once the skyline is certainly at or above this angle, degrees (a Sun fully hidden). */
  stopAboveDeg?: number;
  /** Stop once nothing further could rise above this angle, degrees (a Sun fully clear). */
  stopBelowDeg?: number;
}

/**
 * The skyline's elevation, degrees, seen from local (east, north, up) along one azimuth, from the nested grids
 * (finest first). The walk is a straight line in the site's own frame, and the grids carry the Moon's curvature, so
 * nothing more is needed for a skyline tens of kilometres away. Each grid is walked at about its own spacing; where a
 * grid has a hole, the next coarser one is read. -90 when nothing is found.
 */
export function horizonAlongDeg(
  grids: readonly LocalGrid[],
  east: number,
  north: number,
  up: number,
  azDeg: number,
  walk: HorizonWalk,
  prepared?: RayGrids,
): number {
  const { maxUpOnward } = prepared ?? rayGrids(grids);
  const de = Math.sin(azDeg * DEG);
  const dn = Math.cos(azDeg * DEG);
  const stopAbove = walk.stopAboveDeg === undefined ? Number.POSITIVE_INFINITY : Math.tan(walk.stopAboveDeg * DEG);
  const stopBelow = walk.stopBelowDeg === undefined ? Number.NEGATIVE_INFINITY : Math.tan(walk.stopBelowDeg * DEG);
  const last = grids.length - 1;
  const end = exitDistance(grids[last], east, north, de, dn);
  // A walk from inside the finest grid only ever moves outward through the nested squares, so the ground still ahead
  // is bounded by the coarser grids' highest; from anywhere else it may cross a finer grid, so only the highest of all.
  const inside = (k: number, e: number, n: number) => Math.abs(e) <= grids[k].halfM && Math.abs(n) <= grids[k].halfM;
  const outward = inside(0, east, north);
  let best = Number.NEGATIVE_INFINITY; // tangent of the highest angle so far
  let t = walk.minDistM;
  while (t <= end) {
    const pe = east + t * de;
    const pn = north + t * dn;
    let k = 0;
    while (k < last && !inside(k, pe, pn)) k++;
    const grid = grids[k];
    // Nothing further out stands high enough to beat what is already seen, or to block the light at all.
    const ceiling = ((outward ? maxUpOnward[k] : maxUpOnward[0]) - up) / t;
    if (ceiling <= best || ceiling <= stopBelow) break;
    let h = gridUpAt(grid, pe, pn);
    // A hole in one grid is read from the next coarser one that has the spot.
    for (let j = k + 1; j <= last && !Number.isFinite(h); j++) h = gridUpAt(grids[j], pe, pn);
    if (Number.isFinite(h)) {
      const tan = (h - up) / t;
      if (tan > best) {
        best = tan;
        if (best >= stopAbove) break;
      }
    }
    t += Math.max(grid.spacingM * 0.75, t * 0.001);
  }
  return toDeg(best);
}

const toDeg = (tan: number) => (tan === Number.NEGATIVE_INFINITY ? -90 : Math.atan(tan) / DEG);

/**
 * The share of a disc (the Sun's) each node of one grid sees above the terrain, 0 to 1: the ground's cast shadows,
 * from walking toward the disc from each node through all the grids. Worked out every `stride` nodes and filled in
 * between, so it is as sharp as `stride × spacingM`. A node facing away from the light is the renderer's to darken;
 * this is only what the terrain blocks.
 */
export function discVisibility(
  grids: readonly LocalGrid[],
  level: number,
  dir: Vec3,
  radiusDeg: number,
  stride = 2,
): Float32Array {
  const grid = grids[level];
  const { elevDeg, azDeg } = localElevAz(dir);
  const out = new Float32Array(grid.size * grid.size);
  const prepared = rayGrids(grids);
  const coarse = Math.floor((grid.size - 1) / stride) + 1;
  const sample = new Float32Array(coarse * coarse);
  const lift = 0.05; // metres: keeps a walk from grazing the node's own triangles
  for (let r = 0; r < coarse; r++) {
    const row = Math.min(r * stride, grid.size - 1);
    for (let c = 0; c < coarse; c++) {
      const col = Math.min(c * stride, grid.size - 1);
      const h = grid.up[row * grid.size + col];
      if (!Number.isFinite(h)) {
        sample[r * coarse + c] = 0;
        continue;
      }
      const east = -grid.halfM + col * grid.spacingM;
      const north = grid.halfM - row * grid.spacingM;
      const sky = horizonAlongDeg(
        grids,
        east,
        north,
        h + lift,
        azDeg,
        { minDistM: grid.spacingM, stopAboveDeg: elevDeg + radiusDeg, stopBelowDeg: elevDeg - radiusDeg },
        prepared,
      );
      sample[r * coarse + c] = discFraction(elevDeg, sky, radiusDeg);
    }
  }
  // Fill in between the sampled nodes.
  const last = coarse - 1;
  for (let row = 0; row < grid.size; row++) {
    const fr = Math.min(row / stride, last);
    const r0 = Math.min(Math.floor(fr), Math.max(0, last - 1));
    const r1 = Math.min(r0 + 1, last);
    const wr = fr - r0;
    for (let col = 0; col < grid.size; col++) {
      const fc = Math.min(col / stride, last);
      const c0 = Math.min(Math.floor(fc), Math.max(0, last - 1));
      const c1 = Math.min(c0 + 1, last);
      const wc = fc - c0;
      const top = sample[r0 * coarse + c0] * (1 - wc) + sample[r0 * coarse + c1] * wc;
      const bottom = sample[r1 * coarse + c0] * (1 - wc) + sample[r1 * coarse + c1] * wc;
      out[row * grid.size + col] = top * (1 - wr) + bottom * wr;
    }
  }
  return out;
}

/** A square grid of points to work something out at, laid out like a `LocalGrid` (row 0 north, west to east). */
export interface PointGrid {
  size: number;
  spacingM: number;
  halfM: number;
}

/**
 * The share of a disc (the Sun's) seen from every point of `out`, over the nested terrain grids: the same answer as
 * walking from each point toward the disc (`horizonAlongDeg`), found far faster. Points are taken along lines parallel
 * to the disc's azimuth, `out.spacingM` apart; each line is walked from the far end on the disc's side toward the other,
 * keeping the upper convex hull of the profile already passed, so each point's skyline is the hull's tangent from it:
 * about one step per point, however low the disc. The answers are then read back onto `out`'s nodes.
 *
 * The profile beyond `out` toward the disc (out to the coarsest grid's edge, the Moon's curvature included as everywhere
 * here) is walked at each grid's own spacing, once for every `shareFar` neighbouring lines: lines a few metres apart see
 * the same ridges kilometres away.
 */
export function sweepDiscVisibility(
  grids: readonly LocalGrid[],
  out: PointGrid,
  dir: Vec3,
  radiusDeg: number,
  shareFar = 8,
): Float32Array {
  const result = new Float32Array(out.size * out.size);
  const { elevDeg, azDeg } = localElevAz(dir);
  if (Math.hypot(dir[0], dir[1]) < 1e-9) return result.fill(elevDeg > 0 ? 1 : 0);
  // Toward the disc on the ground (de, dn), and across the lines (pe, pn), a quarter turn clockwise.
  const de = Math.sin(azDeg * DEG);
  const dn = Math.cos(azDeg * DEG);
  const pe = dn;
  const pn = -de;
  const step = out.spacingM;
  const H = out.halfM;
  const uMax = H * (Math.abs(pe) + Math.abs(pn));
  const tMax = H * (Math.abs(de) + Math.abs(dn));
  const lines = Math.ceil((2 * uMax) / step) + 1;
  const points = Math.ceil((2 * tMax) / step) + 1;
  const along = new Float32Array(lines * points);
  const last = grids[grids.length - 1];
  const outer = last.halfM;

  const heightAt = (e: number, n: number): { h: number; spacing: number } => {
    for (const g of grids) {
      const edge = g.halfM * (1 + 1e-9);
      if (Math.abs(e) > edge || Math.abs(n) > edge) continue;
      const h = gridUpAt(g, e, n);
      if (Number.isFinite(h)) return { h, spacing: g.spacingM };
    }
    return { h: Number.NaN, spacing: last.spacingM };
  };
  // Where a line leaves the coarsest grid on the disc's side.
  const farEnd = (u: number): number => {
    let t = Number.POSITIVE_INFINITY;
    for (const [d, p] of [
      [de, pe],
      [dn, pn],
    ]) {
      if (d > 1e-12) t = Math.min(t, (outer - u * p) / d);
      else if (d < -1e-12) t = Math.min(t, (-outer - u * p) / d);
    }
    return t;
  };

  // The hull: points (t, h) with t decreasing toward the top of the stack.
  let hullT = new Float64Array(1024);
  let hullH = new Float64Array(1024);
  let top = -1;
  const push = (t: number, h: number) => {
    // Points under the segment from the new point to the next hull point can no longer be anyone's skyline.
    while (top >= 1 && (hullH[top - 1] - h) / (hullT[top - 1] - t) >= (hullH[top] - h) / (hullT[top] - t)) top--;
    if (top + 1 >= hullT.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      hullT = grow(hullT);
      hullH = grow(hullH);
    }
    top++;
    hullT[top] = t;
    hullH[top] = h;
  };
  /** The steepest rise from (t, h) to the hull, as a tangent; −∞ with nothing beyond. */
  const skyline = (t: number, h: number): number => {
    while (top >= 1 && (hullH[top - 1] - h) / (hullT[top - 1] - t) >= (hullH[top] - h) / (hullT[top] - t)) top--;
    return top >= 0 ? (hullH[top] - h) / (hullT[top] - t) : Number.NEGATIVE_INFINITY;
  };

  let farT = new Float64Array(0);
  let farH = new Float64Array(0);
  for (let j = 0; j < lines; j++) {
    const u = -uMax + j * step;
    if (j % shareFar === 0) {
      // The far profile for this group of lines, walked from the coarsest grid's edge in to `out`.
      top = -1;
      const uFar = Math.min(uMax, u + (shareFar * step) / 2);
      for (let t = farEnd(uFar); t > tMax; ) {
        const e = uFar * pe + t * de;
        const n = uFar * pn + t * dn;
        const { h, spacing } = heightAt(e, n);
        if (Number.isFinite(h)) push(t, h);
        t -= Math.max(spacing * 0.75, step);
      }
      farT = hullT.slice(0, top + 1);
      farH = hullH.slice(0, top + 1);
    }
    // Every line starts from its group's far hull.
    if (hullT.length < farT.length + points + 1) {
      hullT = new Float64Array(farT.length + points + 1024);
      hullH = new Float64Array(farT.length + points + 1024);
    }
    hullT.set(farT);
    hullH.set(farH);
    top = farT.length - 1;
    for (let k = points - 1; k >= 0; k--) {
      const t = -tMax + k * step;
      const { h } = heightAt(u * pe + t * de, u * pn + t * dn);
      const i = j * points + k;
      if (!Number.isFinite(h)) {
        along[i] = Number.NaN;
        continue;
      }
      const tan = skyline(t, h);
      along[i] = discFraction(elevDeg, toDeg(tan), radiusDeg);
      push(t, h);
    }
  }

  // Back onto `out`'s nodes, bilinearly between the lines and the points along them.
  for (let r = 0; r < out.size; r++) {
    const north = H - r * step;
    for (let c = 0; c < out.size; c++) {
      const east = -H + c * step;
      const fj = Math.min(lines - 1, Math.max(0, (east * pe + north * pn + uMax) / step));
      const fk = Math.min(points - 1, Math.max(0, (east * de + north * dn + tMax) / step));
      const j0 = Math.max(0, Math.min(Math.floor(fj), lines - 2));
      const k0 = Math.max(0, Math.min(Math.floor(fk), points - 2));
      const wj = fj - j0;
      const wk = fk - k0;
      // Points with no terrain under them (past the data's edge) are left out of the blend.
      let sum = 0;
      let weight = 0;
      for (const [jj, kk, w] of [
        [j0, k0, (1 - wj) * (1 - wk)],
        [j0, k0 + 1, (1 - wj) * wk],
        [j0 + 1, k0, wj * (1 - wk)],
        [j0 + 1, k0 + 1, wj * wk],
      ]) {
        const v = along[jj * points + kk];
        if (Number.isFinite(v) && w > 0) {
          sum += v * w;
          weight += w;
        }
      }
      result[r * out.size + c] = weight > 0 ? sum / weight : 0;
    }
  }
  return result;
}

/** Values on one point grid read onto another covering the same square, bilinearly between `from`'s nodes. */
export function resampleGrid(values: Float32Array, from: PointGrid, to: PointGrid): Float32Array {
  const out = new Float32Array(to.size * to.size);
  const last = from.size - 1;
  const cell = Math.max(0, last - 1);
  for (let r = 0; r < to.size; r++) {
    const fr = Math.min(last, Math.max(0, (from.halfM - (to.halfM - r * to.spacingM)) / from.spacingM));
    const r0 = Math.min(Math.floor(fr), cell);
    const wr = fr - r0;
    for (let c = 0; c < to.size; c++) {
      const fc = Math.min(last, Math.max(0, (-to.halfM + c * to.spacingM + from.halfM) / from.spacingM));
      const c0 = Math.min(Math.floor(fc), cell);
      const wc = fc - c0;
      const i = r0 * from.size + c0;
      const top = values[i] * (1 - wc) + values[i + 1] * wc;
      const bottom = values[i + from.size] * (1 - wc) + values[i + from.size + 1] * wc;
      out[r * to.size + c] = top * (1 - wr) + bottom * wr;
    }
  }
  return out;
}

export interface EyeSky {
  /** The skyline's elevation toward the body, degrees. */
  horizonDeg: number;
  /** Share of the body's disc above that skyline, 0 to 1. */
  fraction: number;
}

/**
 * What an eye at `eyeHeightM` above the ground at (east, north) sees of a body in local direction `dir`: the skyline
 * toward it, from the same grids the view draws, and the share of its disc above it.
 */
export function eyeSky(
  grids: readonly LocalGrid[],
  east: number,
  north: number,
  eyeHeightM: number,
  dir: Vec3,
  radiusDeg: number,
  minDistM: number,
): EyeSky | undefined {
  const ground = levelsUpAt(grids, east, north);
  if (!Number.isFinite(ground)) return undefined;
  const { elevDeg, azDeg } = localElevAz(dir);
  const horizonDeg = horizonAlongDeg(grids, east, north, ground + eyeHeightM, azDeg, { minDistM });
  return { horizonDeg, fraction: discFraction(elevDeg, horizonDeg, radiusDeg) };
}

/**
 * Surface normals of a grid, as three.js wants them (x = east, y = up, z = −north), from the heights' central
 * differences; one-sided at the edges and beside holes.
 */
export function gridNormals(grid: LocalGrid): Float32Array {
  const { size, spacingM, up } = grid;
  const out = new Float32Array(size * size * 3);
  const at = (c: number, r: number) => up[r * size + c];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const h = at(c, r);
      let dx = 0;
      let dz = 0;
      if (Number.isFinite(h)) {
        const w = c > 0 ? at(c - 1, r) : Number.NaN;
        const e = c < size - 1 ? at(c + 1, r) : Number.NaN;
        const n = r > 0 ? at(c, r - 1) : Number.NaN;
        const s = r < size - 1 ? at(c, r + 1) : Number.NaN;
        // Slope toward +x (east) and toward +z (south, the rows' direction).
        if (Number.isFinite(w) && Number.isFinite(e)) dx = (e - w) / (2 * spacingM);
        else if (Number.isFinite(e)) dx = (e - h) / spacingM;
        else if (Number.isFinite(w)) dx = (h - w) / spacingM;
        if (Number.isFinite(n) && Number.isFinite(s)) dz = (s - n) / (2 * spacingM);
        else if (Number.isFinite(s)) dz = (s - h) / spacingM;
        else if (Number.isFinite(n)) dz = (h - n) / spacingM;
      }
      const len = Math.hypot(dx, 1, dz);
      const i = (r * size + c) * 3;
      out[i] = -dx / len;
      out[i + 1] = 1 / len;
      out[i + 2] = -dz / len;
    }
  }
  return out;
}

/**
 * The triangles of a grid as an index buffer (two per cell, split as `gridUpAt` splits them), leaving out cells with a
 * corner that has no data and, if `hole` is given, cells wholly inside that half-width around the origin: the part a
 * finer grid draws instead. The cut stops one cell short of the finer grid's edge so the two overlap a little and no
 * gap opens between them.
 */
export function gridTriangles(grid: LocalGrid, holeHalfM?: number): Uint32Array {
  const { size, spacingM, halfM, up } = grid;
  const keep: number[] = [];
  const inner = holeHalfM === undefined ? Number.NEGATIVE_INFINITY : holeHalfM - spacingM;
  for (let r = 0; r < size - 1; r++) {
    const z0 = -halfM + r * spacingM;
    for (let c = 0; c < size - 1; c++) {
      const x0 = -halfM + c * spacingM;
      if (x0 >= -inner && x0 + spacingM <= inner && z0 >= -inner && z0 + spacingM <= inner) continue;
      const a = r * size + c;
      const b = a + 1;
      const cc = a + size;
      const d = cc + 1;
      if (!(Number.isFinite(up[a]) && Number.isFinite(up[b]) && Number.isFinite(up[cc]) && Number.isFinite(up[d])))
        continue;
      keep.push(a, cc, b, b, cc, d);
    }
  }
  return Uint32Array.from(keep);
}

/** Node positions for three.js (x = east, y = up, z = −north); a node without data sits at y = 0 and is never drawn. */
export function gridPositions(grid: LocalGrid, sinkM = 0, sinkInsideHalfM?: number): Float32Array {
  const { size, spacingM, halfM, up } = grid;
  const out = new Float32Array(size * size * 3);
  for (let r = 0; r < size; r++) {
    const z = -halfM + r * spacingM;
    for (let c = 0; c < size; c++) {
      const x = -halfM + c * spacingM;
      const h = up[r * size + c];
      // A coarser grid's nodes under the finer one sink a little, so where they overlap the finer ground is drawn.
      const under =
        sinkInsideHalfM !== undefined && Math.abs(x) <= sinkInsideHalfM && Math.abs(z) <= sinkInsideHalfM ? sinkM : 0;
      const i = (r * size + c) * 3;
      out[i] = x;
      out[i + 1] = Number.isFinite(h) ? h - under : 0;
      out[i + 2] = z;
    }
  }
  return out;
}
