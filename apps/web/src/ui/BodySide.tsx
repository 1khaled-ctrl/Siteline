import type { LanderBody } from '@siteline/engine';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { findLander } from '../landers';
import { useApp } from '../store';
import { smallButton } from './Controls';
import { LanderTracker } from './LanderTracker';
import { MarsPanel, MarsSources } from './MarsPanel';
import { SiteReport } from './SiteReport';

interface Props {
  body: LanderBody;
  /** Name of the other tab, which holds `children` (what the planet panel shows about the place picked). */
  placeLabel: string;
  /** Changes when the user picks a new place on the map, which brings that tab forward. */
  placeKey: string | null;
  children: ReactNode;
  /** Shown under either tab, such as the credits for the maps. */
  footer?: ReactNode;
  /** The tab shown first. */
  startOn?: 'landers' | 'place';
}

/** The right-hand column of the Moon and Mars globes: the landers, or the place picked on the map. */
export function BodySide({ body, placeLabel, placeKey, children, footer, startOn = 'landers' }: Props) {
  const { t } = useTranslation();
  const missionId = useApp((s) => s.missionId);
  const [tab, setTab] = useState<'landers' | 'place'>(startOn);
  const seenMission = useRef(missionId);
  const seenPlace = useRef(placeKey);

  // Picking a lander brings its card forward; picking a place (after it, when both change) brings the place forward.
  useEffect(() => {
    if (missionId && missionId !== seenMission.current) setTab('landers');
    seenMission.current = missionId;
  }, [missionId]);
  useEffect(() => {
    if (placeKey !== seenPlace.current) setTab('place');
    seenPlace.current = placeKey;
  }, [placeKey]);

  const tabs = [
    { id: 'landers', label: t('landers.tab') },
    { id: 'place', label: placeLabel },
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex gap-1">
        <legend className="sr-only">{t('landers.sideLabel')}</legend>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            data-testid={`side-${id}`}
            className={`${smallButton} flex-1`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      {tab === 'landers' ? <LanderTracker body={body} /> : children}
      {footer}
    </div>
  );
}

/** The Moon globe's right column: the landers, or the site check for the place picked. */
export function MoonSide({ startOn }: { startOn?: 'landers' | 'place' }) {
  const { t } = useTranslation();
  const placeKey = useApp((s) => `${s.latDeg},${s.lonDeg}`);
  return (
    <BodySide body="Moon" placeLabel={t('report.heading')} placeKey={placeKey} startOn={startOn}>
      <SiteReport />
    </BodySide>
  );
}

/** Mars's right column: the landers, or what is at the place picked. */
export function MarsSide() {
  const { t } = useTranslation();
  const placeKey = useApp((s) => (s.marsPlace ? `${s.marsPlace.latDeg},${s.marsPlace.lonDeg}` : null));
  return (
    <BodySide body="Mars" placeLabel={t('landers.place')} placeKey={placeKey} footer={<MarsSources />}>
      <MarsPanel />
    </BodySide>
  );
}

/**
 * The close-up's right column: the card of the lander whose ground it shows. On the Moon it also has the site check for
 * the lander's spot, shown first, as on the whole Moon.
 */
export function SiteSide() {
  const missionId = useApp((s) => s.missionId);
  const body = missionId ? findLander(missionId)?.body : undefined;
  if (body === 'Moon') return <MoonSide startOn="place" />;
  return body ? <LanderTracker body={body} /> : null;
}
