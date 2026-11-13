import { useTranslation } from 'react-i18next';
import { setSoundOn, useSound } from '../sound';

/** A speaker: with two waves when sound is on, crossed out when it is muted. */
export function Speaker({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z" fill="currentColor" fillOpacity="0.18" />
      {on ? (
        <>
          <path d="M15.5 9a4 4 0 0 1 0 6" />
          <path d="M18.2 6.5a7.6 7.6 0 0 1 0 11" />
        </>
      ) : (
        <>
          <path d="M16 9.5l5 5" />
          <path d="M21 9.5l-5 5" />
        </>
      )}
    </svg>
  );
}

/**
 * Sound on or off, one tap, always in the header (the M key does the same). Its state is the speaker itself: waves when
 * on, a cross when muted.
 */
export function SoundToggle() {
  const { t } = useTranslation();
  const on = useSound((s) => s.on);
  return (
    <button
      type="button"
      aria-pressed={on}
      title={t(on ? 'sound.muteHint' : 'sound.unmuteHint')}
      onClick={() => setSoundOn(!on)}
      className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-line bg-panel-raised transition-colors hover:border-line-hover ${on ? 'text-ink' : 'text-quiet'}`}
    >
      <Speaker on={on} />
      <span className="sr-only">{t('sound.label')}</span>
    </button>
  );
}
