import { useEffect } from 'react';

/**
 * Leans each glass surface's highlight toward the pointer: sets `--mx` and `--my` on every `.glass` and panel card to
 * where the pointer is relative to it, once a frame at most. Touch has no hover, so the highlight stays put there.
 */
export function useGlassLight(): void {
  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      frame = 0;
      for (const el of document.querySelectorAll<HTMLElement>('.glass, .hud > *')) {
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${(x - r.left).toFixed(0)}px`);
        el.style.setProperty('--my', `${(y - r.top).toFixed(0)}px`);
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    };
  }, []);
}
