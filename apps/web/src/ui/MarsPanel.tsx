import { NEAR_FEATURE_KM } from '@siteline/engine';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { useApp } from '../store';
import { panel, smallButton } from './Controls';

export function MarsPanel() {
  const { t } = useTranslation();
  const place = useApp((s) => s.marsPlace);
  const commandMars = useApp((s) => s.commandMars);

  const hemisphere = (v: number, positive: string, negative: string) =>
    `${formatNumber(Math.abs(v), 3)}° ${v >= 0 ? t(positive) : t(negative)}`;

  return (
    <aside className="flex flex-col gap-4" aria-live="polite">
      <section className={panel}>
        <h2 className="mb-3 font-semibold">{t('mars.panel.heading')}</h2>
        {!place ? (
          <p className="text-sm text-quiet">{t('mars.panel.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-lg font-semibold" data-testid="mars-feature">
              {place.feature?.name ?? t('mars.panel.open')}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-quiet">{t('mars.panel.coords')}</dt>
              <dd dir="ltr" className="text-end">
                {hemisphere(place.latDeg, 'mars.panel.north', 'mars.panel.south')},{' '}
                {hemisphere(place.lonDeg, 'mars.panel.east', 'mars.panel.west')}
              </dd>
              <dt className="text-quiet">{t('mars.panel.elevation')}</dt>
              <dd className="text-end" data-testid="mars-elevation">
                {place.elevationM === undefined
                  ? t('mars.panel.elevationPending')
                  : t('mars.panel.elevationValue', { m: formatNumber(place.elevationM, 0) })}
              </dd>
              <dt className="text-quiet">{t('mars.panel.feature')}</dt>
              <dd className="text-end">
                {place.feature
                  ? `${t(`mars.kinds.${place.feature.kind}`)} · ${
                      place.inside
                        ? t('mars.panel.inside', { name: place.feature.name })
                        : t('mars.panel.near', {
                            km: formatNumber(place.featureDistKm ?? 0, 0),
                            name: place.feature.name,
                          })
                    }`
                  : t('mars.panel.nothing', { km: NEAR_FEATURE_KM })}
              </dd>
              {place.feature && (
                <>
                  <dt className="text-quiet" />
                  <dd className="text-end text-quiet">
                    {formatNumber(place.feature.diameterKm, 0)} km {t('mars.panel.across')}
                  </dd>
                </>
              )}
            </dl>
            {place.feature && (
              <button type="button" className={smallButton} onClick={() => commandMars('feature')}>
                {t('mars.panel.zoomFeature', { name: place.feature.name })}
              </button>
            )}
          </div>
        )}
      </section>
      <p className="px-1 text-xs text-quiet">{t('mars.panel.sources')}</p>
    </aside>
  );
}
