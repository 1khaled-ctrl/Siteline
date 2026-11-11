import { useTranslation } from 'react-i18next';
import { Controls } from './ui/Controls';
import { MoonView } from './ui/MoonView';
import { SiteReport } from './ui/SiteReport';

export function App() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <header className="border-b border-white/10 px-4 py-3">
        <h1 className="text-lg font-semibold tracking-wide">SiteLine</h1>
        <p className="text-sm text-quiet">{t('app.tagline')}</p>
      </header>
      <main className="grid flex-1 gap-4 p-4 lg:min-h-0 lg:grid-cols-[18rem_1fr_26rem]">
        <div className="lg:overflow-y-auto">
          <Controls />
        </div>
        <MoonView />
        <div className="lg:overflow-y-auto">
          <SiteReport />
        </div>
      </main>
    </div>
  );
}
