import { useTranslation } from 'react-i18next';
import { formatUtc } from '../format';
import { useLightingUtcMs } from '../physics';
import { useApp } from '../store';
import { box, smallButton } from './Controls';

/**
 * Top of the floating panel on the solar-system, Earth and Mars views. The header sets the date they are placed and
 * lit for; this shows only when the Moon's launch slip or time-lapse has moved the lighting off that date, with a
 * way back.
 */
export function BodyClock() {
  const { t } = useTranslation();
  const landingUtc = useApp((s) => s.landingUtc);
  const playing = useApp((s) => s.playing);
  const playOffsetH = useApp((s) => s.playOffsetH);
  const setPlay = useApp((s) => s.setPlay);
  const litMs = useLightingUtcMs();

  if (litMs === Date.parse(landingUtc) && !playing) return null;
  return (
    <section className={`${box} flex flex-col gap-3`}>
      <p className="text-xs text-quiet">{t('clock.litFor', { when: formatUtc(new Date(litMs).toISOString()) })}</p>
      {(playing || playOffsetH > 0) && (
        <button type="button" className={smallButton} onClick={() => setPlay({ playing: false, playOffsetH: 0 })}>
          {t('clock.reset')}
        </button>
      )}
    </section>
  );
}
