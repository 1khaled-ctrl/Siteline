import { useTranslation } from 'react-i18next';
import validation from '../../../../tests/reference/validation.json';
import { formatNumber } from '../format';

interface SunlightRow {
  point: string;
  busseyPct: number;
  oursPct: number;
}

/** The validation table the tests wrote; every number here was measured, none typed by hand. */
export function Checks({ open }: { open?: boolean }) {
  const { t } = useTranslation();
  const spice = validation.spice as { cases: number; worstDeg: number; toleranceDeg: number; recordedUtc: string };
  const sun = validation.sunlight as { rows: SunlightRow[]; toleranceBusseyPct: number; terrain: string };

  return (
    <details open={open} className="rounded-lg border border-line p-3 text-sm">
      <summary className="cursor-pointer font-display text-base font-semibold">{t('checks.heading')}</summary>
      <ul className="mt-3 space-y-3">
        <li>
          <span className="text-pass">✓ </span>
          {t('checks.spice', {
            cases: formatNumber(spice.cases, 0),
            worst: formatNumber(spice.worstDeg * 3600, 2),
            tol: formatNumber(spice.toleranceDeg * 3600, 1),
          })}
        </li>
        <li>
          {t('checks.sunlight', { terrain: sun.terrain, tol: sun.toleranceBusseyPct })}
          <table className="mt-2 w-full">
            <thead className="text-xs text-quiet">
              <tr>
                <th className="text-start font-normal">{t('checks.point')}</th>
                <th className="text-end font-normal">{t('checks.published')}</th>
                <th className="text-end font-normal">{t('checks.ours')}</th>
              </tr>
            </thead>
            <tbody>
              {sun.rows.map((r) => {
                const ok = Math.abs(r.oursPct - r.busseyPct) < sun.toleranceBusseyPct;
                return (
                  <tr key={r.point} className="border-t border-line">
                    <td className="py-1">
                      <span className={ok ? 'text-pass' : 'text-warn'}>{ok ? '✓' : '△'} </span>
                      {r.point}
                    </td>
                    <td className="py-1 text-end">{formatNumber(r.busseyPct, 0)}%</td>
                    <td className="py-1 text-end">{formatNumber(r.oursPct, 1)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-quiet">{t('checks.ridgeNote')}</p>
        </li>
        <li className="text-xs text-quiet">{t('checks.recorded', { date: spice.recordedUtc.slice(0, 10) })}</li>
      </ul>
    </details>
  );
}
