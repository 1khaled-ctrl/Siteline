import { type LanderBody, type Mission, patchKey } from '@siteline/engine';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PINNED, textOf } from '../landers';
import { BODY_VIEW, useApp } from '../store';
import { useLanderFiles } from '../useLanders';

interface Props {
  body: LanderBody;
  /** The crumb's own text, such as "Moon". */
  text: string;
  /** Whether this crumb is where you are now, so it keeps the lit pill. */
  here: boolean;
  /** Where "Whole Moon" or "Whole Mars" goes. */
  goHome: () => void;
}

/**
 * The planet's crumb as a menu of its landing sites. A site with close-up terrain opens the close-up; any other flies
 * the globe to it and opens its card, as picking it from the lander list does.
 */
export function SiteMenu({ body, text, here, goHome }: Props) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const missionId = useApp((s) => s.missionId);
  const view = useApp((s) => s.view);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const byKeyboard = useRef(false);

  const sites = PINNED[body];
  // A site has a close-up when the close-ups' headers name it; until they arrive, every site flies the globe.
  const headers = useLanderFiles().sites;
  const hasCloseUp = (m: Mission) => headers?.[patchKey(m) ?? ''] !== undefined;
  const closeUps = sites.filter(hasCloseUp);
  const others = sites.filter((m) => !hasCloseUp(m));
  const bodyName = t(`bodies.${body.toLowerCase()}`);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  // Clicking anywhere else closes the menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // On a narrow screen the menu would run past the window's edge, so slide it back inside with a 16 px gutter.
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    el.style.translate = '';
    const r = el.getBoundingClientRect();
    const gutter = 16;
    const shift = Math.min(0, window.innerWidth - gutter - r.right) + Math.max(0, gutter - r.left);
    if (shift) el.style.translate = `${shift}px 0`;
  }, [open]);

  // Opening puts the keyboard on the place you are, or the first item.
  useEffect(() => {
    if (!open) return;
    const items = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    const current = list.current?.querySelector<HTMLElement>('[aria-current="true"]');
    // A mouse click leaves the ring off; the keyboard shows where it landed.
    (current ?? items?.[0])?.focus({ focusVisible: byKeyboard.current } as FocusOptions);
  }, [open]);

  const pick = (m: Mission) => {
    const s = useApp.getState();
    s.selectMission(m.id);
    if (hasCloseUp(m)) s.openSite();
    close(true);
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') setOpen(false);
  };

  const item = (m: Mission) => {
    const current = m.id === missionId;
    return (
      <button
        key={m.id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-current={current ? 'true' : undefined}
        data-testid={`site-menu-${m.id}`}
        className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-1 text-start hover:bg-panel-raised focus-visible:bg-panel-raised ${current ? 'text-accent' : ''}`}
        onClick={() => pick(m)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{m.name}</span>
          <span className="block truncate text-xs text-quiet">{textOf(m.site, i18n.language)}</span>
        </span>
        <span className="max-w-28 shrink-0 text-end font-mono text-xs text-quiet">
          {m.dateLabel ? textOf(m.dateLabel, i18n.language) : new Date(m.tUtcMs).getUTCFullYear()}
        </span>
      </button>
    );
  };

  return (
    <div ref={wrap} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t('crumbs.sitesButton', { name: text })}
        aria-current={here ? 'page' : undefined}
        data-testid={`crumb-sites-${body.toLowerCase()}`}
        className={`relative flex min-h-9 items-center gap-1 rounded-md px-2 transition-colors hover:text-ink ${here ? '' : 'text-quiet'}`}
        onClick={(e) => {
          // A click from Enter or Space has no pointer, so `detail` is 0.
          byKeyboard.current = e.detail === 0;
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            byKeyboard.current = true;
            setOpen(true);
          }
        }}
      >
        {here && <span className="crumb-here absolute inset-0 rounded-md" />}
        <span className="relative">{text}</span>
        <span aria-hidden="true" className={`relative text-[10px] transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          role="menu"
          aria-label={t('crumbs.sitesMenu', { name: bodyName })}
          className="absolute start-0 top-full z-30 mt-1.5 max-h-[min(70vh,30rem)] w-80 max-w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[10px] [scrollbar-color:var(--color-line-hover)_transparent] [scrollbar-width:thin] border border-line bg-panel p-1.5 shadow-2xl"
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            aria-current={view === BODY_VIEW[body] && !missionId ? 'true' : undefined}
            className="flex min-h-11 w-full items-center rounded-md px-2.5 text-start text-sm hover:bg-panel-raised focus-visible:bg-panel-raised"
            onClick={() => {
              goHome();
              close(true);
            }}
          >
            {t('crumbs.wholeBody', { name: bodyName })}
          </button>
          {closeUps.length > 0 && (
            <fieldset className="m-0 mt-3 min-w-0 border-0 p-0">
              <legend className="px-2.5 pb-1 text-xs text-quiet">{t('crumbs.closeUps')}</legend>
              {closeUps.map(item)}
            </fieldset>
          )}
          {others.length > 0 && (
            <fieldset className="m-0 mt-3 min-w-0 border-0 p-0">
              <legend className="px-2.5 pb-1 text-xs text-quiet">{t('crumbs.onGlobe')}</legend>
              {others.map(item)}
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
