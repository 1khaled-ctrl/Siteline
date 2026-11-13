import type { FrameSource, ScreenPoint } from '@siteline/engine';
import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBoot } from '../boot';
import { depthLook, edgePoint, type Placement, placeCallouts, type Rect, type Side } from '../callouts';
import { useWide } from '../stage';

export type CalloutTone = 'accent' | 'sun' | 'pass' | 'fail' | 'warn';

export interface Callout {
  id: string;
  /** Where on the page the leader line ends, read once a frame; null hides the card. */
  anchor: () => ScreenPoint | null;
  /** The side the card would rather sit on. */
  prefer?: Side;
  tone?: CalloutTone;
  /** What the card is about, for screen readers. */
  label: string;
  children: ReactNode;
}

interface Live {
  x: number;
  y: number;
  side?: Side;
  shown: number;
  phase: number;
  beat: number;
}

/** Tells the panel's cards to hold still too (`:root[data-reading]` in index.css). */
function markReading(on: boolean): void {
  if (on) document.documentElement.dataset.reading = '';
  else delete document.documentElement.dataset.reading;
}

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** How quickly a card catches up with where it should be, per second. */
const FOLLOW = 9;
/** Margin kept between the cards and the edges of the view. */
const EDGE = 10;

/**
 * Glass cards that live in the scene: each sits beside the thing it describes, with a thin leader line to the exact
 * point, and follows it as the camera moves. Cards never overlap one another, the view's toolbars (anything marked
 * `data-avoid`), or another card's point. Nearer things get larger, sharper cards. They drift a little, each on its
 * own beat, and everything holds still while the pointer is on a card. Wide screens only; phones have the sheet.
 */
export function CalloutLayer({ source, items }: { source: FrameSource | null; items: readonly Callout[] }) {
  const wide = useWide();
  const opened = useBoot((s) => s.opened);
  if (!wide || !opened || !source) return null;
  return <Layer source={source} items={items} />;
}

function Layer({ source, items }: { source: FrameSource; items: readonly Callout[] }) {
  const { i18n } = useTranslation();
  const layer = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const lines = useRef(new Map<string, SVGPathElement>());
  const dots = useRef(new Map<string, SVGGElement>());
  const live = useRef(new Map<string, Live>());
  const latest = useRef(items);
  latest.current = items;
  const frozen = useRef(false);

  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let avoid: Rect[] = [];
    let avoidAt = 0;
    let seed = 0;

    const paint = (dt: number) => {
      const root = layer.current;
      if (!root) return;
      const box = root.getBoundingClientRect();
      const now = performance.now();
      // The view's toolbars and hints, re-read now and then (they rarely move).
      if (now - avoidAt > 500) {
        avoidAt = now;
        avoid = [...document.querySelectorAll<HTMLElement>('[data-avoid]')]
          .map((el) => el.getBoundingClientRect())
          .filter(
            (r) => r.width > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom,
          )
          .map((r) => ({ x: r.left - box.left - 6, y: r.top - box.top - 6, w: r.width + 12, h: r.height + 12 }));
      }
      const still = frozen.current || reduced();
      const points = latest.current.map((item) => {
        const p = item.anchor();
        return p?.visible ? { item, x: p.x - box.left, y: p.y - box.top, depth: p.depth } : null;
      });
      const shown = points.filter((p): p is NonNullable<typeof p> => p !== null);
      const near = Math.min(...shown.map((p) => p.depth));
      const far = Math.max(...shown.map((p) => p.depth));
      const previous = new Map<string, Side>();
      for (const [id, l] of live.current) if (l.side) previous.set(id, l.side);
      const placed = new Map<string, Placement>(
        placeCallouts(
          shown.map(({ item, x, y }) => {
            const el = cards.current.get(item.id);
            return {
              id: item.id,
              ax: x,
              ay: y,
              w: el?.offsetWidth ?? 200,
              h: el?.offsetHeight ?? 80,
              prefer: item.prefer,
            };
          }),
          { x: EDGE, y: EDGE, w: box.width - 2 * EDGE, h: box.height - 2 * EDGE },
          avoid,
          previous,
        ).map((p) => [p.id, p]),
      );
      const t = now / 1000;
      for (const [i, item] of latest.current.entries()) {
        const card = cards.current.get(item.id);
        const line = lines.current.get(item.id);
        const dot = dots.current.get(item.id);
        if (!card || !line || !dot) continue;
        const point = points[i];
        const spot = placed.get(item.id);
        let l = live.current.get(item.id);
        if (!l) {
          seed += 1;
          l = { x: spot?.x ?? 0, y: spot?.y ?? 0, shown: 0, phase: seed * 2.4, beat: 7 + ((seed * 1.7) % 4) };
          live.current.set(item.id, l);
        }
        if (point && spot) {
          const k = still || l.shown === 0 ? 1 : 1 - Math.exp(-dt * FOLLOW);
          l.x += (spot.x - l.x) * k;
          l.y += (spot.y - l.y) * k;
          l.side = spot.side;
        }
        l.shown = Math.min(1, Math.max(0, l.shown + (point ? 1 : -1) * (still ? 1 : dt * 4)));
        const drift = still ? 0 : 1;
        const dx = drift * 2.2 * Math.sin((t * 2 * Math.PI) / l.beat + l.phase);
        const dy = drift * 1.8 * Math.cos((t * 2 * Math.PI) / (l.beat * 1.3) + l.phase);
        const look = depthLook(point && far > near ? (point.depth - near) / (far - near) : 0);
        const x = l.x + dx;
        const y = l.y + dy;
        const ease = l.shown * l.shown * (3 - 2 * l.shown);
        card.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${(look.scale * (0.94 + 0.06 * ease)).toFixed(3)})`;
        card.style.opacity = (look.opacity * ease).toFixed(3);
        card.style.filter = look.blurPx > 0.05 ? `blur(${look.blurPx.toFixed(2)}px)` : '';
        card.style.visibility = l.shown > 0 ? 'visible' : 'hidden';
        if (point && spot) {
          const r = { x, y, w: spot.w, h: spot.h };
          const end = edgePoint(r, point.x, point.y);
          line.setAttribute(
            'd',
            `M${point.x.toFixed(1)},${point.y.toFixed(1)}L${end.x.toFixed(1)},${end.y.toFixed(1)}`,
          );
          dot.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`);
        }
        line.style.opacity = (0.85 * ease * look.opacity).toFixed(3);
        dot.style.opacity = ease.toFixed(3);
      }
    };

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      paint(dt);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    // Right after each draw too, so the lines land on the picture that is on screen, not last frame's.
    const stop = source.addFrameListener(() => paint(0));
    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [source]);

  /** Holds every card (and the panel) still while you read one. */
  const hold = (on: boolean) => {
    frozen.current = on;
    markReading(on);
  };
  useEffect(() => () => markReading(false), []);

  return (
    // Placed from the 3D view's own pixels, so the layer never mirrors; each card's text keeps the page's direction.
    <div
      ref={layer}
      className="callout-layer pointer-events-none absolute inset-0 z-2"
      dir="ltr"
      data-testid="callouts"
    >
      <svg className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
        {items.map((item) => (
          <g key={item.id} data-tone={item.tone ?? 'accent'} className="callout-mark">
            <path
              ref={(el) => {
                if (el) lines.current.set(item.id, el);
                else lines.current.delete(item.id);
              }}
              className="callout-line"
            />
            <g
              ref={(el) => {
                if (el) dots.current.set(item.id, el);
                else dots.current.delete(item.id);
              }}
            >
              <circle className="callout-ping" r="9" />
              <circle className="callout-dot" r="3.5" />
            </g>
          </g>
        ))}
      </svg>
      {items.map((item) => (
        <section
          key={item.id}
          ref={(el) => {
            if (el) cards.current.set(item.id, el);
            else cards.current.delete(item.id);
          }}
          aria-label={item.label}
          dir={i18n.dir()}
          data-tone={item.tone ?? 'accent'}
          data-testid={`callout-${item.id}`}
          className="callout glass pointer-events-auto absolute start-0 top-0"
          style={{ visibility: 'hidden' }}
          onPointerEnter={() => hold(true)}
          onPointerLeave={() => hold(false)}
          onFocus={() => hold(true)}
          onBlur={() => hold(false)}
        >
          {item.children}
        </section>
      ))}
    </div>
  );
}
