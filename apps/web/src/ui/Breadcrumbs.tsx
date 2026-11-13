import type { LanderBody } from '@siteline/engine';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { useTranslation } from 'react-i18next';
import { findLander } from '../landers';
import { type MoonView, useApp } from '../store';
import { SiteMenu } from './SiteMenu';

interface Crumb {
  id: string;
  text: string;
  /** What clicking does; the last crumb is the current place and does not link. */
  go: () => void;
  /** A planet crumb that also opens a menu of that planet's landing sites. */
  menu?: LanderBody;
}

const to = (view: MoonView) => () => useApp.getState().set({ view });

/** A whole planet with no lander picked: what the first item of its crumb's menu does. */
const wholeBody = (body: LanderBody) => () => {
  const s = useApp.getState();
  s.selectMission(null);
  if (body === 'Moon') {
    s.set({ view: 'globe' });
  } else {
    s.set({ view: 'mars' });
    s.setMarsPlace(null);
    s.commandMars('home');
  }
};

const SPRING = { type: 'spring', stiffness: 480, damping: 38 } as const;

/**
 * Where you are, as a trail back to the solar system. The crumb you are on sits in a lit pill that glides along as you
 * go deeper or come back, and crumbs slide in and out from the trail's start.
 */
export function Breadcrumbs() {
  const { t, i18n } = useTranslation();
  const from = i18n.dir() === 'rtl' ? 10 : -10;
  const view = useApp((s) => s.view);
  const place = useApp((s) => s.earthPlace);
  const marsPlace = useApp((s) => s.marsPlace);
  const missionId = useApp((s) => s.missionId);

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
      go: wholeBody('Mars'),
      menu: 'Mars',
    });
    if (marsPlace?.feature) {
      trail.push({
        id: 'feature',
        text: marsPlace.feature.name,
        go: () => useApp.getState().commandMars('feature'),
      });
    }
  } else if (view === 'globe' || view === 'pole') {
    trail.push({
      id: 'moon',
      text: t('crumbs.moon'),
      go: wholeBody('Moon'),
      menu: 'Moon',
    });
    if (view === 'pole') trail.push({ id: 'pole', text: t('crumbs.pole'), go: to('pole') });
  }

  const site = view === 'site' && missionId ? findLander(missionId) : undefined;
  if (site) {
    trail.push({
      // The same key as on the planet's own view, so its crumb stays put rather than sliding out and back in.
      id: site.body.toLowerCase(),
      text: t(`crumbs.${site.body.toLowerCase()}`),
      go: wholeBody(site.body),
      menu: site.body,
    });
    trail.push({ id: 'site', text: t('siteView.crumb', { name: site.name }), go: () => {} });
  }

  return (
    <nav aria-label={t('crumbs.label')}>
      <LayoutGroup id="crumbs">
        <ol className="relative flex flex-wrap items-center gap-0.5 text-[13px]">
          <AnimatePresence initial={false} mode="popLayout">
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <motion.li
                  key={c.id}
                  layout="position"
                  className="flex items-center gap-1"
                  initial={{ opacity: 0, x: from }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: from, transition: { duration: 0.15 } }}
                  transition={SPRING}
                >
                  {i > 0 && (
                    <span aria-hidden="true" className="text-quiet">
                      ›
                    </span>
                  )}
                  {c.menu ? (
                    <SiteMenu body={c.menu} text={c.text} here={last} goHome={c.go} />
                  ) : last ? (
                    <span aria-current="page" className="relative flex min-h-8 items-center px-2">
                      <motion.span
                        layoutId="crumb-here"
                        className="crumb-here absolute inset-0 rounded-md"
                        transition={SPRING}
                      />
                      <span className="relative">{c.text}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="min-h-9 rounded-md px-1.5 text-quiet transition-colors hover:text-ink"
                      onClick={c.go}
                    >
                      {c.text}
                    </button>
                  )}
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ol>
      </LayoutGroup>
    </nav>
  );
}
