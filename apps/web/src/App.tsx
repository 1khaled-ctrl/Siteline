import { useTranslation } from 'react-i18next';
import { useApp } from './store';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { Controls } from './ui/Controls';
import { EarthPanel } from './ui/EarthPanel';
import { MoonView } from './ui/MoonView';
import { SiteReport } from './ui/SiteReport';

export function App() {
  const { t } = useTranslation();
  const view = useApp((s) => s.view);
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-wide">SiteLine</h1>
          <p className="text-sm text-quiet">{t('app.tagline')}</p>
        </div>
        <Breadcrumbs />
      </header>
      <main className="grid flex-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[18rem_1fr_26rem]">
        <div className="lg:overflow-y-auto">
          <Controls />
        </div>
        <MoonView />
        <div className="lg:overflow-y-auto">{view === 'earth' ? <EarthPanel /> : <SiteReport />}</div>
      </main>
    </div>
  );
}
