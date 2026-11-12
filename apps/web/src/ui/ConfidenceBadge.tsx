import { useTranslation } from 'react-i18next';
import { type Confidence, FULL_DETAIL_M, SLOPE_NEEDS_M } from '../confidence';
import { formatNumber } from '../format';

const ICON: Record<Confidence, string> = { high: '●', firstPass: '◐', notMeasured: '○', flatHorizon: '◌' };
const TONE: Record<Confidence, string> = {
  high: 'border-pass/45 text-pass',
  firstPass: 'border-line-hover text-quiet',
  notMeasured: 'border-line text-quiet',
  flatHorizon: 'border-warn/50 text-warn',
};

/** The words behind a level, for the tooltip and for screen readers. */
export function useConfidenceWords() {
  const { t } = useTranslation();
  return (level: Confidence, terrainM?: number) =>
    t(`confidence.why.${level}`, {
      km: terrainM === undefined ? '' : formatNumber(terrainM / 1000),
      full: formatNumber(FULL_DETAIL_M, 0),
      slope: formatNumber(SLOPE_NEEDS_M, 0),
    });
}

/** How far to trust one reading: a word on a chip, or just its mark (with the words for hover and screen readers). */
export function ConfidenceBadge({
  level,
  terrainM,
  compact,
}: {
  level: Confidence;
  terrainM?: number;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const why = useConfidenceWords()(level, terrainM);
  return (
    <span
      title={why}
      className={`inline-flex shrink-0 items-center gap-1 rounded-pill border px-1.5 align-middle font-sans text-[11px] leading-4 font-normal ${TONE[level]}`}
    >
      <span aria-hidden="true">{ICON[level]}</span>
      {compact ? <span className="sr-only">{why}</span> : t(`confidence.short.${level}`)}
    </span>
  );
}

/** The key under the readings: the three marks, and what the loaded terrain is. */
export function ConfidenceKey({ terrainM, note }: { terrainM?: number; note: string }) {
  const { t } = useTranslation();
  const words = useConfidenceWords();
  const levels: Confidence[] =
    terrainM === undefined ? ['high', 'flatHorizon', 'notMeasured'] : ['high', 'firstPass', 'notMeasured'];
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${terrainM === undefined ? 'border-warn/50 bg-warn/8' : 'border-line bg-panel-raised'}`}
    >
      <h3 className="mb-1.5 text-base">{t('confidence.heading')}</h3>
      <ul className="flex flex-col gap-1.5">
        {levels.map((level) => (
          <li key={level} className="flex items-start gap-2">
            <ConfidenceBadge level={level} terrainM={terrainM} />
            <span className="text-xs text-quiet">{words(level, terrainM)}</span>
          </li>
        ))}
      </ul>
      <p className={`mt-2 text-xs ${terrainM === undefined ? 'text-warn' : 'text-quiet'}`}>{note}</p>
    </div>
  );
}
