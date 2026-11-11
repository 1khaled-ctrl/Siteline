import { useTranslation } from 'react-i18next';
import { type MoonView, useApp } from '../store';

interface Crumb {
  label: string;
  /** Where clicking goes; the last crumb is the current place and does not link. */
  view: MoonView;
}

const TRAIL: Record<MoonView, Crumb[]> = {
  solar: [{ label: 'crumbs.solar', view: 'solar' }],
  globe: [
    { label: 'crumbs.solar', view: 'solar' },
    { label: 'crumbs.moon', view: 'globe' },
  ],
  pole: [
    { label: 'crumbs.solar', view: 'solar' },
    { label: 'crumbs.moon', view: 'globe' },
    { label: 'crumbs.pole', view: 'pole' },
  ],
};

export function Breadcrumbs() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  const trail = TRAIL[view];
  return (
    <nav aria-label={t('crumbs.label')}>
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={c.label} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-quiet">
                  ›
                </span>
              )}
              {last ? (
                <span aria-current="page" className="px-2 font-semibold">
                  {t(c.label)}
                </span>
              ) : (
                <button
                  type="button"
                  className="min-h-9 rounded-lg px-2 text-accent hover:bg-white/5"
                  onClick={() => useApp.getState().set({ view: c.view })}
                >
                  {t(c.label)}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
