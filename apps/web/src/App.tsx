import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FactBody } from './bodyFacts';
import { findLander } from './landers';
import { useApp, type MoonView as ViewName } from './store';
import { BodyClock } from './ui/BodyClock';
import { BodyFacts } from './ui/BodyFacts';
import { MarsSide, MoonSide, SiteSide } from './ui/BodySide';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { Controls, LandingTime } from './ui/Controls';
import { Copilot } from './ui/Copilot';
import { DateStepper } from './ui/DateStepper';
import { EarthPanel } from './ui/EarthPanel';
import { MoonView } from './ui/MoonView';
import { SiteReport } from './ui/SiteReport';
import { SourcesButton, SourcesDialog } from './ui/SourcesDialog';
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

export function App() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
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
      <OfflineBanner />
      {/* On a wide screen the 3D view fills the window and the panel floats over its end; on a narrow one they stack. */}
      <main className="relative flex flex-1 flex-col lg:block lg:min-h-0 lg:overflow-hidden">
        <MoonView />
        <Copilot />
        <aside
          id="panel"
          tabIndex={-1}
          aria-label={t('app.panel')}
          className="flex flex-col gap-5 border-t border-line bg-panel p-4 lg:absolute lg:inset-y-3 lg:inset-e-3 lg:z-10 lg:w-[410px] lg:overflow-y-auto lg:rounded-xl lg:border lg:bg-panel/95 lg:pb-6"
        >
          <PanelContent view={view} />
        </aside>
      </main>
    </div>
  );
}
