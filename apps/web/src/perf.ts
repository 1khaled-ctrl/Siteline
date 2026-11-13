/**
 * The device's pace, read from the first moments of the opening: if frames come slower than the budget, the app turns
 * its effects down instead of off (no blur in the opening's flight, no drift on the cards, a lighter frosting on the
 * glass), marked as `data-low-power` on the page so the styles can follow.
 */
export const perf = { low: false };

/** A frame budget a little over 30 fps: slower than this, and the effects get lighter. */
const BUDGET_MS = 30;

/** Times frames for `ms` and turns the effects down if their median runs over the budget. Resolves to `perf.low`. */
export function measureFrames(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let last = 0;
    const start = performance.now();
    const step = (now: number) => {
      if (last) gaps.push(now - last);
      last = now;
      if (now - start < ms) {
        requestAnimationFrame(step);
        return;
      }
      gaps.sort((a, b) => a - b);
      const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
      if (median > BUDGET_MS) {
        perf.low = true;
        document.documentElement.dataset.lowPower = '';
      }
      resolve(perf.low);
    };
    requestAnimationFrame(step);
  });
}
