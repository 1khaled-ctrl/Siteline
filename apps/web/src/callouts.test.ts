import { describe, expect, it } from 'vitest';
import { type CalloutInput, depthLook, edgePoint, overlap, placeCallouts, type Rect, slot } from './callouts';

const bounds: Rect = { x: 0, y: 0, w: 1000, h: 700 };
const card = (id: string, ax: number, ay: number, w = 220, h = 90): CalloutInput => ({ id, ax, ay, w, h });
const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= bounds.w + 1e-6 && r.y + r.h <= bounds.h + 1e-6;

describe('callouts sit beside what they describe', () => {
  it('takes the side it prefers when there is room', () => {
    const [p] = placeCallouts([{ ...card('mars', 500, 350), prefer: 'ne' }], bounds);
    expect(p.side).toBe('ne');
    expect(p).toMatchObject(slot(card('mars', 500, 350), 'ne'));
  });

  it('turns to another side near an edge rather than leave the screen', () => {
    const [p] = placeCallouts([{ ...card('mars', 980, 40), prefer: 'ne' }], bounds);
    expect(inside(p)).toBe(true);
    expect(['sw', 'w', 's']).toContain(p.side);
  });

  it('never stacks two cards on each other, even for points a few pixels apart', () => {
    const items = [card('earth', 480, 340), card('moon', 488, 332), card('mars', 470, 350)];
    const placed = placeCallouts(items, bounds);
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i], placed[j])).toBe(0);
    for (const p of placed) expect(inside(p)).toBe(true);
  });

  it('keeps clear of the toolbars it is told to avoid', () => {
    const toolbar: Rect = { x: 0, y: 0, w: 1000, h: 60 };
    const [p] = placeCallouts([{ ...card('site', 500, 150), prefer: 'n' }], bounds, [toolbar]);
    expect(overlap(p, toolbar)).toBe(0);
  });

  it('keeps last frame’s side while it still works, so cards do not flicker as the camera turns', () => {
    const items = [card('site', 500, 350)];
    const [first] = placeCallouts(items, bounds, [], new Map([['site', 'sw']]));
    expect(first.side).toBe('sw');
  });

  it('does not cover another card’s point', () => {
    const items = [card('a', 400, 300), card('b', 470, 240)];
    const placed = placeCallouts(items, bounds);
    for (const p of placed)
      for (const other of items.filter((c) => c.id !== p.id))
        expect(other.ax > p.x && other.ax < p.x + p.w && other.ay > p.y && other.ay < p.y + p.h).toBe(false);
  });
});

describe('the leader line', () => {
  it('meets the card on the edge facing its point', () => {
    const r = { x: 100, y: 100, w: 200, h: 100 };
    expect(edgePoint(r, 50, 150)).toEqual({ x: 100, y: 150 });
    expect(edgePoint(r, 200, 300)).toEqual({ x: 200, y: 200 });
  });
});

describe('depth', () => {
  it('draws the nearest card largest and clearest', () => {
    const near = depthLook(0);
    const far = depthLook(1);
    expect(near).toEqual({ scale: 1, opacity: 1, blurPx: 0 });
    expect(far.scale).toBeLessThan(near.scale);
    expect(far.opacity).toBeLessThan(near.opacity);
    expect(far.blurPx).toBeGreaterThan(0);
  });
});
