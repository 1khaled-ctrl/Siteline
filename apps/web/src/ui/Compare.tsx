import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { useStayMany } from '../physics';
import { type Pin, useApp } from '../store';
import { panel } from './Controls';

const label = (p: Pin) => `${formatNumber(p.latDeg, 2)}°, ${formatNumber(p.lonDeg, 2)}°`;

/** Every pinned site re-checked for the current landing date and slip, side by side. */
export function Compare() {
  const { t } = useTranslation();
  const pins = useApp((s) => s.pins);
  const rows = useStayMany(pins);
  if (pins.length === 0) return null;

  return (
    <section className={panel}>
      <h2 className="mb-2 font-semibold">{t('compare.heading', { count: pins.length })}</h2>
      <table className="w-full text-sm">
        <thead className="text-start text-xs text-quiet">
          <tr>
            <th className="py-1 text-start font-normal">{t('compare.site')}</th>
            <th className="py-1 text-end font-normal">{t('compare.sun')}</th>
            <th className="py-1 text-end font-normal">{t('compare.earth')}</th>
            <th className="py-1 text-end font-normal">{t('compare.verdict')}</th>
          </tr>
        </thead>
        <tbody>
          {pins.map((p, i) => {
            const r = rows[i]?.result;
            return (
              <tr key={label(p)} className="border-t border-white/10">
                <td className="py-1">
                  <button
                    type="button"
                    className="rounded px-1 text-start hover:bg-white/5"
                    onClick={() => useApp.getState().focusSite(p.latDeg, p.lonDeg)}
                  >
                    {label(p)}
                  </button>
                </td>
                <td className="py-1 text-end">{r ? `${formatNumber(r.sunFractionMin * 100, 0)}%` : '…'}</td>
                <td className="py-1 text-end">{r ? `${formatNumber(r.earthVisiblePct, 0)}%` : '…'}</td>
                <td className={`py-1 text-end ${r?.pass ? 'text-pass' : r ? 'text-fail' : ''}`}>
                  {r ? (r.pass ? t('report.verdict.pass') : t('report.verdict.fail')) : '…'}
                </td>
                <td className="py-1 text-end">
                  <button
                    type="button"
                    aria-label={t('compare.unpin')}
                    className="rounded px-2 text-quiet hover:text-ink"
                    onClick={() => useApp.getState().togglePin(p)}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
