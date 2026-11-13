/** A box on the page, in CSS pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A circle on the page, such as a globe on screen. */
export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** The eight places a card can sit around the point it describes. */
export const SIDES = ['ne', 'e', 'se', 'nw', 'w', 'sw', 'n', 's'] as const;
export type Side = (typeof SIDES)[number];

export interface CalloutInput {
  id: string;
  /** The point the leader line ends at. */
  ax: number;
  ay: number;
  /** The card's size. */
  w: number;
  h: number;
  /** Where this card would rather sit; it still moves if that spot is taken. */
  prefer?: Side;
  /** A globe the card must not cover: it sits beside it, or is left out when there is no room. */
  keepOff?: Disc;
}

export interface Placement extends Rect {
  id: string;
  side: Side;
}

/** How far a card sits from its point: the length of a leader line pointing straight out. */
export const GAP_PX = 56;

/** The card's box when it sits on `side` of its point. */
export function slot(c: CalloutInput, side: Side): Rect {
  const d = GAP_PX * Math.SQRT1_2;
  const { ax, ay, w, h } = c;
  switch (side) {
    case 'ne':
      return { x: ax + d, y: ay - d - h, w, h };
    case 'e':
      return { x: ax + GAP_PX, y: ay - h / 2, w, h };
    case 'se':
      return { x: ax + d, y: ay + d, w, h };
    case 'nw':
      return { x: ax - d - w, y: ay - d - h, w, h };
    case 'w':
      return { x: ax - GAP_PX - w, y: ay - h / 2, w, h };
    case 'sw':
      return { x: ax - d - w, y: ay + d, w, h };
    case 'n':
      return { x: ax - w / 2, y: ay - GAP_PX - h, w, h };
    case 's':
      return { x: ax - w / 2, y: ay + GAP_PX, w, h };
  }
}

export const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** About how much of `r` lies inside the circle `d`, as an area, counted on a 6 × 6 grid of points. */
export function discOverlap(r: Rect, d: Disc): number {
  let inside = 0;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 6; j++) {
      const x = r.x + ((i + 0.5) / 6) * r.w;
      const y = r.y + ((j + 0.5) / 6) * r.h;
      if ((x - d.x) ** 2 + (y - d.y) ** 2 < d.r ** 2) inside++;
    }
  }
  return (inside / 36) * r.w * r.h;
}

/** The share of a card that may lie over the globe it keeps off: a corner over the rim, no more. */
const KEEP_OFF_SHARE = 0.06;

/** The part of `r` outside `bounds`, as an area. */
const outside = (r: Rect, bounds: Rect): number => r.w * r.h - overlap(r, bounds);

const covers = (r: Rect, x: number, y: number, margin: number) =>
  x > r.x - margin && x < r.x + r.w + margin && y > r.y - margin && y < r.y + r.h + margin;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The leader line of a card at `r` for the point (ax, ay): from the point to where it meets the card's edge. */
function leaderOf(ax: number, ay: number, r: Rect): Segment {
  const end = edgePoint(r, ax, ay);
  return { x1: ax, y1: ay, x2: end.x, y2: end.y };
}

const turn = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));

/** Whether two leader lines cross each other (touching at an end does not count). */
export function linesCross(a: Segment, b: Segment): boolean {
  return (
    turn(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1) * turn(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2) < 0 &&
    turn(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1) * turn(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2) < 0
  );
}

/** Whether a leader line runs across a card's box. */
function lineCrossesBox(l: Segment, r: Rect): boolean {
  const inside = (x: number, y: number) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
  if (inside(l.x1, l.y1) || inside(l.x2, l.y2)) return true;
  const corners = [
    [r.x, r.y, r.x + r.w, r.y],
    [r.x + r.w, r.y, r.x + r.w, r.y + r.h],
    [r.x + r.w, r.y + r.h, r.x, r.y + r.h],
    [r.x, r.y + r.h, r.x, r.y],
  ];
  return corners.some(([x1, y1, x2, y2]) => linesCross(l, { x1, y1, x2, y2 }));
}

/** Slides `r` back inside `bounds` where it can. */
function clampInto(r: Rect, bounds: Rect): Rect {
  const x = Math.min(Math.max(r.x, bounds.x), bounds.x + bounds.w - r.w);
  const y = Math.min(Math.max(r.y, bounds.y), bounds.y + bounds.h - r.h);
  return { ...r, x: r.w > bounds.w ? bounds.x : x, y: r.h > bounds.h ? bounds.y : y };
}

/**
 * Places each card beside its point so that no two cards overlap, none covers another's point or one of the `avoid`
 * boxes (toolbars, hints), and all stay inside `bounds`. Cards go in the order given, each to the free side it likes
 * best; a card keeps last frame's side (`previous`) unless that side has become clearly worse, so cards do not flip
 * back and forth as the camera moves. A card with a globe to keep off sits clear of it, or is left out when no side
 * has room. Leader lines keep from crossing one another and from running under other cards. A last few passes push
 * apart any cards that still touch.
 */
export function placeCallouts(
  items: readonly CalloutInput[],
  bounds: Rect,
  avoid: readonly Rect[] = [],
  previous: ReadonlyMap<string, Side> = new Map(),
): Placement[] {
  const placed: Placement[] = [];
  const lines: Segment[] = [];
  for (const c of items) {
    const order = c.prefer ? [c.prefer, ...SIDES.filter((s) => s !== c.prefer)] : [...SIDES];
    let best: Placement | undefined;
    let bestCost = Infinity;
    order.forEach((side, rank) => {
      const r = slot(c, side);
      let cost = rank * 30 + outside(r, bounds) * 8;
      for (const p of placed) cost += overlap(r, p) * 6;
      // Lines that cross, or run under a card, are hard to follow back to their points.
      const line = leaderOf(c.ax, c.ay, r);
      for (let i = 0; i < placed.length; i++) {
        if (linesCross(line, lines[i])) cost += 2400;
        if (lineCrossesBox(line, placed[i])) cost += 1200;
        if (lineCrossesBox(lines[i], r)) cost += 1200;
      }
      for (const a of avoid) cost += overlap(r, a) * 4;
      if (c.keepOff) cost += discOverlap(r, c.keepOff) * 8;
      for (const other of items) if (other !== c && covers(r, other.ax, other.ay, 8)) cost += 4000;
      // Worth more than any preference, so only a real clash moves a card off last frame's side.
      if (previous.get(c.id) === side) cost -= 260;
      if (cost < bestCost) {
        bestCost = cost;
        best = { id: c.id, side, ...r };
      }
    });
    if (!best) continue;
    const spot = { ...best, ...clampInto(best, bounds) };
    if (c.keepOff && discOverlap(spot, c.keepOff) > KEEP_OFF_SHARE * spot.w * spot.h) continue;
    placed.push(spot);
    lines.push(leaderOf(c.ax, c.ay, spot));
  }
  // Push apart whatever still touches, half each way along the shorter overlap, then back inside the bounds.
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const push = (ox + 2) / 2;
          const dir = a.x + a.w / 2 < b.x + b.w / 2 ? -1 : 1;
          a.x += dir * push;
          b.x -= dir * push;
        } else {
          const push = (oy + 2) / 2;
          const dir = a.y + a.h / 2 < b.y + b.h / 2 ? -1 : 1;
          a.y += dir * push;
          b.y -= dir * push;
        }
      }
    }
    for (let i = 0; i < placed.length; i++) placed[i] = { ...placed[i], ...clampInto(placed[i], bounds) };
    if (!moved) break;
  }
  return placed;
}

/** The point on the edge of `r` where a line from (x, y) to the box's middle crosses it. */
export function edgePoint(r: Rect, x: number, y: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const k = Math.min(dx ? r.w / 2 / Math.abs(dx) : Infinity, dy ? r.h / 2 / Math.abs(dy) : Infinity);
  return { x: cx + dx * Math.min(1, k), y: cy + dy * Math.min(1, k) };
}

/**
 * How a card looks at its depth: the nearest of the cards on screen is full size and fully sharp, the farthest a
 * little smaller, fainter and softer, so depth reads at a glance. `depth` is 0 for the nearest and 1 for the farthest.
 */
export function depthLook(depth: number): { scale: number; opacity: number; blurPx: number } {
  const k = Math.min(1, Math.max(0, depth));
  return { scale: 1 - 0.1 * k, opacity: 1 - 0.28 * k, blurPx: 0.3 * k };
}
