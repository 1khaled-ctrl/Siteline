import { useTranslation } from 'react-i18next';
import { formatUtc } from '../format';
import { useLightingUtcMs } from '../physics';
import { useApp } from '../store';
import { panel, smallButton } from './Controls';

const input = 'mt-1 block w-full min-h-11 rounded-lg border border-white/15 bg-space/60 px-3';

/**
 * The left column of the solar-system, Earth and Mars views. They read one thing from the clock, the date the planets
 * are placed and lit for, so that is all this shows; the Moon's landing controls stay with the Moon views.
 */
export function BodyClock() {
  const { t } = useTranslation();
  const landingUtc = useApp((s) => s.landingUtc);
  const playing = useApp((s) => s.playing);
  const playOffsetH = useApp((s) => s.playOffsetH);
  const set = useApp((s) => s.set);
  const setPlay = useApp((s) => s.setPlay);
  const litMs = useLightingUtcMs();

  return (
    <aside className="flex flex-col gap-4">
      <section className={`${panel} flex flex-col gap-3`}>
        <label className="block text-sm text-quiet">
          {t('clock.label')}
          <input
            type="datetime-local"
            dir="ltr"
            min="2026-01-01T00:00"
            max="2035-12-31T23:59"
            value={landingUtc.slice(0, 16)}
            className={`${input} text-ink`}
            onChange={(e) => set({ landingUtc: `${e.currentTarget.value}:00Z` })}
          />
        </label>
        <p className="text-xs text-quiet">{t('clock.litFor', { when: formatUtc(new Date(litMs).toISOString()) })}</p>
        {(playing || playOffsetH > 0) && (
          <button type="button" className={smallButton} onClick={() => setPlay({ playing: false, playOffsetH: 0 })}>
            {t('clock.reset')}
          </button>
        )}
      </section>
    </aside>
  );
}
