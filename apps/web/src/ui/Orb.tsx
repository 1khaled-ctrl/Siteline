import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useStage, useWide } from '../stage';

/** One of the orb's floating buttons. Add a row here to add a button; they fan out from the orb in this order. */
interface OrbAction {
  id: string;
  /** The i18n key under `orb.` for the button's label. */
  labelKey: string;
  icon: React.ReactNode;
  run: () => void;
}

const RADIUS_PX = 84;

const SparkIcon = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5 14.2 9.8 21.5 12l-7.3 2.2L12 21.5l-2.2-7.3L2.5 12l7.3-2.2Z" />
  </svg>
);
const EyeOffIcon = (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <path d="M3 3l18 18M10.6 10.7A2 2 0 0 0 13.3 13.4M6.2 6.3C3.9 7.8 2.5 10 2 12c1.6 4 5.4 7 10 7 1.7 0 3.3-.4 4.7-1.1M9.5 5.3C10.3 5.1 11.1 5 12 5c4.6 0 8.4 3 10 7-.5 1.2-1.2 2.3-2.1 3.3" />
  </svg>
);
const EyeIcon = (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    aria-hidden="true"
  >
    <path d="M2 12c1.6-4 5.4-7 10-7s8.4 3 10 7c-1.6 4-5.4 7-10 7S3.6 16 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/**
 * The orb: a glowing button at the bottom corner of the 3D view. A tap fans its actions out around it as floating round
 * buttons: Ask SiteLine, and hiding the whole interface for a clean look at the scene (the orb alone stays, dimmed,
 * to bring it back; so does Escape). On a wide screen it sits at the start edge and fans toward the middle; on a phone
 * it sits at the end edge beside the dial and fans the other way.
 */
export function Orb() {
  const { t } = useTranslation();
  const wide = useWide();
  const open = useStage((s) => s.orbOpen);
  const hidden = useStage((s) => s.uiHidden);
  const wrap = useRef<HTMLDivElement>(null);
  const { setOrbOpen, setUiHidden, setCopilotOpen } = useStage.getState();

  const actions: OrbAction[] = [
    {
      id: 'ask',
      labelKey: 'ask',
      icon: SparkIcon,
      run: () => {
        setOrbOpen(false);
        setCopilotOpen(true);
      },
    },
    {
      id: 'hide',
      labelKey: 'hide',
      icon: EyeOffIcon,
      run: () => {
        setOrbOpen(false);
        setUiHidden(true);
      },
    },
  ];

  // The page carries the hidden state for the stylesheet, which hides everything but the scene and the orb.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-ui-hidden', hidden);
    return () => document.documentElement.removeAttribute('data-ui-hidden');
  }, [hidden]);

  // Escape brings the interface back, or folds the fan; a tap anywhere else folds it.
  useEffect(() => {
    if (!open && !hidden) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (hidden) setUiHidden(false);
      else setOrbOpen(false);
    };
    const away = (e: PointerEvent) => {
      if (open && !wrap.current?.contains(e.target as Node)) setOrbOpen(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', away);
    };
  }, [open, hidden, setOrbOpen, setUiHidden]);

  // Toward the middle of the screen: right of a start-edge orb, left of an end-edge one.
  const dir = wide ? 1 : -1;
  const n = actions.length;

  return (
    <div
      ref={wrap}
      className="orb-wrap fixed inset-e-4 z-30 lg:absolute lg:inset-e-auto lg:inset-s-4 lg:bottom-5"
      data-avoid
      data-open={open || undefined}
    >
      {actions.map((a, i) => {
        // Fanned evenly between nearly straight up and nearly sideways.
        const angle = n === 1 ? 45 : 80 - (i * 70) / (n - 1);
        const rad = (angle * Math.PI) / 180;
        const x = dir * RADIUS_PX * Math.cos(rad);
        const y = -RADIUS_PX * Math.sin(rad);
        return (
          <button
            key={a.id}
            type="button"
            tabIndex={open ? 0 : -1}
            aria-hidden={!open}
            className="orb-action glass absolute start-1/2 top-1/2 grid size-11 place-items-center rounded-full text-ink"
            style={{ '--tx': `${x}px`, '--ty': `${y}px`, '--i': i } as React.CSSProperties}
            onClick={a.run}
          >
            {a.icon}
            <span
              className={`orb-label absolute top-1/2 whitespace-nowrap ${dir > 0 ? 'start-full ms-2.5' : 'end-full me-2.5'}`}
            >
              {t(`orb.${a.labelKey}`)}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        aria-expanded={open}
        aria-label={hidden ? t('orb.show') : open ? t('orb.close') : t('orb.open')}
        title={hidden ? t('orb.show') : undefined}
        className="orb relative grid size-14 place-items-center rounded-full text-space"
        data-hidden={hidden || undefined}
        onClick={() => (hidden ? setUiHidden(false) : setOrbOpen(!open))}
      >
        <span className="orb-ring" aria-hidden="true" />
        <span className="orb-ring orb-ring-late" aria-hidden="true" />
        <span className="orb-core" aria-hidden="true">
          {hidden ? EyeIcon : SparkIcon}
        </span>
      </button>
    </div>
  );
}
