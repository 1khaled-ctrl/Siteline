import { useTranslation } from 'react-i18next';
import { type MoonView, useApp } from '../store';

interface Crumb {
  id: string;
  text: string;
  /** What clicking does; the last crumb is the current place and does not link. */
  go: () => void;
}

const to = (view: MoonView) => () => useApp.getState().set({ view });

export function Breadcrumbs() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  const place = useApp((s) => s.earthPlace);
  const marsPlace = useApp((s) => s.marsPlace);

  const solar: Crumb = { id: 'solar', text: t('crumbs.solar'), go: to('solar') };
  const trail: Crumb[] = [solar];
  if (view === 'earth') {
    trail.push({
      id: 'earth',
      text: t('crumbs.earth'),
      go: () => {
        useApp.getState().setEarthPlace(null);
        useApp.getState().commandEarth('home');
      },
    });
    // Zooming from the globe to a country to a city is the trail.
    if (place?.country) {
      trail.push({ id: 'country', text: place.country.name, go: () => useApp.getState().commandEarth('country') });
      if (place.city) trail.push({ id: 'city', text: place.city.name, go: () => {} });
    }
  } else if (view === 'mars') {
    trail.push({
      id: 'mars',
      text: t('crumbs.mars'),
      go: () => {
        useApp.getState().setMarsPlace(null);
        useApp.getState().commandMars('home');
      },
    });
    if (marsPlace?.feature) {
      trail.push({
        id: 'feature',
        text: marsPlace.feature.name,
        go: () => useApp.getState().commandMars('feature'),
      });
    }
  } else if (view === 'globe' || view === 'pole') {
    trail.push({ id: 'moon', text: t('crumbs.moon'), go: to('globe') });
    if (view === 'pole') trail.push({ id: 'pole', text: t('crumbs.pole'), go: to('pole') });
  }

  return (
    <nav aria-label={t('crumbs.label')}>
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={c.id} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden="true" className="text-quiet">
                  ›
                </span>
              )}
              {last ? (
                <span aria-current="page" className="px-2 font-semibold">
                  {c.text}
                </span>
              ) : (
                <button type="button" className="min-h-9 rounded-lg px-2 text-accent hover:bg-white/5" onClick={c.go}>
                  {c.text}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
