import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FactBody } from './bodyFacts';
import { useBoot } from './boot';
import { findLander } from './landers';
import { useStage, useWide } from './stage';
import { useApp, type MoonView as ViewName } from './store';
import { BodyClock } from './ui/BodyClock';
import { BodyFacts } from './ui/BodyFacts';
import { MarsSide, MoonSide, SiteSide } from './ui/BodySide';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { Controls, LandingTime } from './ui/Controls';
import { Copilot } from './ui/Copilot';
import { DateStepper } from './ui/DateStepper';
import { EarthPanel } from './ui/EarthPanel';
import { useGlassLight } from './ui/glass';
import { Intro } from './ui/Intro';
import { JourneyDialog } from './ui/Journey';
import { MoonView } from './ui/MoonView';
import { OrbitDial } from './ui/OrbitDial';
import { Peek } from './ui/Peek';
import { Sheet } from './ui/Sheet';
import { SiteReport } from './ui/SiteReport';
import { SourcesButton, SourcesDialog } from './ui/SourcesDialog';
import { TiltButton } from './ui/Tilt';
import { OfflineBanner } from './ui/ViewStatus';
import { WorldsList } from './ui/WorldsList';

/** The views that show a world's facts; the solar system and a lander's close-up have none to show. */
const FACTS_BODY: Partial<Record<ViewName, FactBody>> = { earth: 'Earth', mars: 'Mars', globe: 'Moon', pole: 'Moon' };

/**
 * What the floating panel holds on each view, top to bottom. A world's facts lead, as in the demo, except at the south
 * pole, where the landing time and the site check come first and the Moon's facts go last.
 */
function PanelContent({ view }: { view: ViewName }): ReactNode {
  const facts = FACTS_BODY[view];
  const factsCard = facts && <BodyFacts key={facts} body={facts} />;
  switch (view) {
    case 'solar':
      return [<BodyClock key="clock" />, <WorldsList key="worlds" />];
    case 'earth':
      return [<BodyClock key="clock" />, factsCard, <EarthPanel key="side" />];
    case 'mars':
      return [<BodyClock key="clock" />, factsCard, <MarsSide key="side" />];
    case 'site':
      return [<BodyClock key="clock" />, <SiteSide key="side" />];
    case 'globe':
      return [factsCard, <LandingTime key="time" />, <MoonSide key="side" />, <Controls key="controls" />];
    default:
      return [<LandingTime key="time" />, <SiteReport key="report" />, <Controls key="controls" />, factsCard];
  }
}

/** The header's tagline names the world in view; a lander's close-up names the lander's world. */
function Tagline() {
  const { t } = useTranslation();
  const key = useApp((s) => {
    if (s.view !== 'site') return s.view;
    const body = findLander(s.missionId ?? '')?.body;
    return body && `site${body}`;
  });
  return key ? <p className="text-xs text-quiet max-lg:hidden">{t(`app.tagline.${key}`)}</p> : null;
}

/**
 * Watches whether the floating panel has anything in it: when every card in it is empty (the solar system's clock card
 * hides while no slip or time-lapse is set), the 3D view takes the whole width and centres in it.
 */
function usePanelShown(): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const check = () => {
      const shown = [...el.children].some((c) => (c as HTMLElement).offsetHeight > 0);
      document.documentElement.style.setProperty('--hud-end', shown ? '422px' : '0px');
      useStage.getState().setPanelShown(shown);
    };
    const observer = new ResizeObserver(check);
    observer.observe(el);
    const watch = new MutationObserver(() => {
      for (const c of el.children) observer.observe(c);
      check();
    });
    watch.observe(el, { childList: true });
    for (const c of el.children) observer.observe(c);
    check();
    return () => {
      observer.disconnect();
      watch.disconnect();
      document.documentElement.style.removeProperty('--hud-end');
      useStage.getState().setPanelShown(true);
    };
  }, []);
}

export function App() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  const opened = useBoot((s) => s.opened);
  useGlassLight();
  const panelRef = usePanelShown();
  const wide = useWide();
  return (
    <>
      <Intro />
      {/* Out of reach of the keyboard and screen readers until the opening hands over. */}
      <div className="flex h-dvh flex-col" inert={!opened}>
        <a
          href="#panel"
          className="sr-only z-30 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-space focus:not-sr-only focus:absolute focus:inset-s-3 focus:top-3"
        >
          {t('app.skipToPanel')}
        </a>
        <header className="relative z-10 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-bar px-3.5 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <h1 className="text-[21px]">SiteLine</h1>
            <Tagline />
          </div>
          <Breadcrumbs />
          {/* On a phone the date gets a row of its own and the sources button stays up with the title. */}
          <div className="ms-auto">
            <SourcesButton />
          </div>
          <div className="max-sm:w-full">
            <DateStepper />
          </div>
        </header>
        <SourcesDialog />
        <JourneyDialog />
        <OfflineBanner />
        {/* The 3D view fills the window. On a wide screen the panel's cards float over its end as panes of glass
          (`.hud` in index.css); on a phone they live in a sheet that peeks up from the bottom, under a thumb dial. */}
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <MoonView />
          <Copilot />
          {wide ? (
            <aside
              ref={panelRef}
              id="panel"
              tabIndex={-1}
              aria-label={t('app.panel')}
              className="hud absolute inset-y-3 inset-e-3 z-10 flex w-[410px] flex-col gap-3 overflow-y-auto pe-1"
            >
              <PanelContent view={view} />
            </aside>
          ) : (
            <>
              <Sheet peek={<Peek view={view} />} label={t('app.panel')}>
                <PanelContent view={view} />
              </Sheet>
              <OrbitDial />
              <TiltButton />
            </>
          )}
        </main>
      </div>
    </>
  );
}
