import type { StayResult } from '@siteline/contracts';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const HEIGHT = 180;
const AXIS = { stroke: '#9aa7b4', grid: { stroke: '#ffffff14' }, ticks: { stroke: '#ffffff14' } };

export function Timeline({ series }: { series: StayResult['series'] }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || series.tUtcMs.length === 0) return;
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: HEIGHT,
        tzDate: (ts) => uPlot.tzDate(new Date(ts * 1000), 'Etc/UTC'),
        scales: { y: { range: [0, 1] } },
        axes: [AXIS, AXIS],
        series: [
          {},
          { label: t('timeline.sun'), stroke: '#ffb547', width: 2 },
          { label: t('timeline.earth'), stroke: '#5aa9ff', width: 2 },
        ],
      },
      [Array.from(series.tUtcMs, (ms) => ms / 1000), Array.from(series.sun), Array.from(series.earth)],
      el,
    );
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: HEIGHT }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
    };
  }, [series, t]);

  return (
    <figure>
      <figcaption className="mb-2 text-sm font-semibold">{t('timeline.heading')}</figcaption>
      {/* Time runs left to right in both languages. */}
      <div ref={ref} dir="ltr" className="text-xs text-quiet" />
    </figure>
  );
}
