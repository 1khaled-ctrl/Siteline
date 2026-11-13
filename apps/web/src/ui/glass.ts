import { useEffect } from 'react';

const SURFACES = '.glass, .hud > *';
/** How far past a surface's edge its highlight (a 420 px circle that fades out at 62%) can still be seen on it. */
const REACH_PX = 300;
/** How often the surfaces' places are read again, besides after a scroll or a resize. */
const REREAD_MS = 250;

interface Surface {
  el: HTMLElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Whether its highlight was last put within reach of it. */
  lit: boolean;
}

/**
 * Leans each glass surface's highlight toward the pointer: sets `--mx` and `--my` on every `.glass` and panel card to
 * where the pointer is relative to it, once a frame at most. Touch has no hover, so the highlight stays put there.
 *
 * The surfaces' places are read all together, at most every quarter second and after a scroll or resize, never between
 * the writes: a place read after a write makes the page lay itself out again, once per surface per frame, which made
 * dragging the 3D view stutter. A surface the pointer is out of reach of is left alone once its highlight is off it.
 */
export function useGlassLight(): void {
  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;
    let readAt = Number.NEGATIVE_INFINITY;
    let surfaces: Surface[] = [];
    const paint = (now: number) => {
      frame = 0;
      if (now - readAt > REREAD_MS) {
        readAt = now;
        const lit = new Map(surfaces.map((s) => [s.el, s.lit]));
        surfaces = [...document.querySelectorAll<HTMLElement>(SURFACES)].map((el) => {
          const { left, top, right, bottom } = el.getBoundingClientRect();
          return { el, left, top, right, bottom, lit: lit.get(el) ?? true };
        });
      }
      for (const s of surfaces) {
        const near = Math.hypot(Math.max(s.left - x, 0, x - s.right), Math.max(s.top - y, 0, y - s.bottom)) < REACH_PX;
        if (!near && !s.lit) continue;
        s.lit = near;
        s.el.style.setProperty('--mx', `${(x - s.left).toFixed(0)}px`);
        s.el.style.setProperty('--my', `${(y - s.top).toFixed(0)}px`);
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const moved = () => {
      readAt = Number.NEGATIVE_INFINITY;
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('scroll', moved, { capture: true, passive: true });
    window.addEventListener('resize', moved, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('scroll', moved, { capture: true });
      window.removeEventListener('resize', moved);
      cancelAnimationFrame(frame);
    };
  }, []);
}
