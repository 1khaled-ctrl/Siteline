import { PICK_CITY_KM } from '@siteline/engine';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { useApp } from '../store';
import { panel, smallButton } from './Controls';

export function EarthPanel() {
  const { t } = useTranslation();
  const place = useApp((s) => s.earthPlace);
  const commandEarth = useApp((s) => s.commandEarth);

  const hemisphere = (v: number, positive: string, negative: string) =>
    `${formatNumber(Math.abs(v), 3)}° ${v >= 0 ? t(positive) : t(negative)}`;

  return (
    <aside className="flex flex-col gap-4" aria-live="polite">
      <section className={panel}>
        <h2 className="mb-3 font-semibold">{t('earth.panel.heading')}</h2>
        {!place ? (
          <p className="text-sm text-quiet">{t('earth.panel.empty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-lg font-semibold" data-testid="earth-country">
              {place.country?.name ?? t('earth.panel.sea')}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-quiet">{t('earth.panel.coords')}</dt>
              <dd dir="ltr" className="text-end">
                {hemisphere(place.latDeg, 'earth.panel.north', 'earth.panel.south')},{' '}
                {hemisphere(place.lonDeg, 'earth.panel.east', 'earth.panel.west')}
              </dd>
              <dt className="text-quiet">{t('earth.panel.nearestCity')}</dt>
              <dd className="text-end" data-testid="earth-city">
                {place.city ? place.city.name : t('earth.panel.noCity', { km: PICK_CITY_KM })}
              </dd>
              {place.city && (
                <>
                  <dt className="text-quiet" />
                  <dd className="text-end text-quiet">
                    {t('earth.panel.cityAway', { km: formatNumber(place.cityDistKm ?? 0, 0) })}
                    {' · '}
                    {t('earth.panel.population', { count: formatNumber(place.city.population, 0) })}
                  </dd>
                </>
              )}
            </dl>
            {place.country && (
              <button type="button" className={smallButton} onClick={() => commandEarth('country')}>
                {t('earth.panel.zoomCountry')}
              </button>
            )}
          </div>
        )}
      </section>
      <p className="px-1 text-xs text-quiet">{t('earth.panel.sources')}</p>
    </aside>
  );
}
