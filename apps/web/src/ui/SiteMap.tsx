import {
  decodePatch,
  type Mission,
  marsRoutes,
  missionPlace,
  patchKey,
  SITE_BODY_RADIUS_KM,
  type SitePatch,
  type SitePatchMeta,
  SiteView,
  sunHeightDeg,
} from '@siteline/engine';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatNumber } from '../format';
import { COLOUR_URL, findLander, MISSIONS, patchImageUrl } from '../landers';
import { useActiveView, useStageInsets } from '../stage';
import { useApp } from '../store';
import { useLanderFiles, useShownUtcMs, useSubsolar } from '../useLanders';
import { LanderPins } from './LanderPins';
import { hintBox, ViewPills, viewButton } from './ViewPills';
import { useLoad, ViewStatus } from './ViewStatus';

const GLD100 = 'https://wms.lroc.asu.edu/lroc/view_rdr/WAC_GLD100';
const MEGDR = 'https://pds-geosciences.wustl.edu/missions/mgs/megdr.html';
const SSS = 'https://www.solarsystemscope.com/textures/';
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const DEFAULT_RELIEF = 3;

/** Read a close-up height patch: the PNG decoded through a canvas, then the heights unpacked from red and green. */
async function readPatch(url: string, meta: SitePatchMeta): Promise<SitePatch> {
  const image = new Image();
  // Read back pixel by pixel, so a patch from another origin (the R2 bucket) must come with CORS or the canvas locks.
  image.crossOrigin = 'anonymous';
  image.src = url;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw new Error('no 2D canvas');
  g.drawImage(image, 0, 0);
  return decodePatch(meta, g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
}

function Ext({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">
      {children}
    </a>
  );
}

/** The ground around one lander's site, up close, with the landers and rover routes that lie on it. */
export function SiteMap() {
  const { t } = useTranslation();
  const missionId = useApp((s) => s.missionId);
  const closeSite = useApp((s) => s.closeSite);
  const mission = missionId ? findLander(missionId) : undefined;
  const { tracks, sites } = useLanderFiles();
  const meta = mission && sites?.[patchKey(mission) ?? ''];
  const shownMs = useShownUtcMs();
  const subsolar = useSubsolar(mission?.body ?? 'Moon');
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SiteView | null>(null);
  const load = useLoad();
  const { ready, fail, restart } = load;
  const [relief, setRelief] = useState(DEFAULT_RELIEF);
  const [sunny, setSunny] = useState(false);
  const [pixels, setPixels] = useState(0);

  useEffect(() => {
    const url = mission && patchImageUrl(mission);
    if (!ref.current || !mission || !meta || !url) return;
    let live = true;
    let created: SiteView | undefined;
    restart();
    readPatch(url, meta).then(
      (patch) => {
        if (!live || !ref.current) return;
        created = new SiteView(ref.current, { body: mission.body, patch, colourUrl: COLOUR_URL[mission.body] });
        setPixels(patch.width);
        setView(created);
        ready();
      },
      (e: unknown) => live && fail(e),
    );
    return () => {
      live = false;
      created?.dispose();
      setView(null);
    };
  }, [mission, meta, ready, fail, restart]);
  useEffect(() => {
    if (sites && mission && !meta) fail(t('siteView.noPatch'));
  }, [sites, mission, meta, fail, t]);

  useEffect(() => view?.setRelief(relief), [view, relief]);
  useEffect(() => view?.setSubsolar(sunny ? subsolar : undefined), [view, sunny, subsolar]);
  useEffect(
    () => view?.setRoutes(tracks && mission?.body === 'Mars' ? marsRoutes(MISSIONS, tracks, shownMs) : []),
    [view, tracks, mission, shownMs],
  );

  // The landers on this square of ground.
  const onGround = useMemo<Mission[]>(() => {
    if (!mission || !meta) return [];
    return MISSIONS.filter((m) => {
      const at = missionPlace(MISSIONS, m, tracks, shownMs);
      return (
        m.body === mission.body &&
        at !== undefined &&
        Math.abs(at.latDeg - meta.latDeg) <= meta.halfDeg &&
        Math.abs(at.lonDeg - meta.lonDeg) <= meta.halfDeg
      );
    });
  }, [mission, meta, tracks, shownMs]);

  const insets = useStageInsets();
  useActiveView(view);
  useEffect(() => {
    view?.setInsets(insets);
  }, [view, insets]);

  if (!mission) return null;
  const metresPerPixel =
    meta && pixels
      ? (2 * meta.halfDeg * (Math.PI / 180) * SITE_BODY_RADIUS_KM[mission.body] * 1000) / pixels
      : undefined;
  const night =
    sunny && meta && subsolar && sunHeightDeg(meta.latDeg, meta.lonDeg, subsolar.latDeg, subsolar.lonDeg) < 0;

  return (
    <section className="fade-in absolute inset-0">
      <div ref={ref} className="stage-canvas" data-testid="site-map" />
      <LanderPins host={view} missions={onGround} tracks={tracks} atUtcMs={shownMs} />
      <ViewPills
        below={
          night && (
            <p role="status" className="rounded-md bg-panel-raised/92 px-2 py-1 text-xs text-warn">
              {t('siteView.sunBelow')}
            </p>
          )
        }
      >
        <button
          type="button"
          aria-pressed={sunny}
          title={t('siteView.realSunHint')}
          className={viewButton}
          onClick={() => setSunny((v) => !v)}
        >
          {t('siteView.realSun')}
        </button>
        <label className={`${viewButton} flex items-center gap-2`}>
          <span>{t('siteView.relief')}</span>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={relief}
            className="w-24 accent-sun"
            onChange={(e) => setRelief(Number(e.currentTarget.value))}
          />
          <output dir="ltr" className="w-6 text-end tabular-nums">
            {t('siteView.reliefValue', { n: relief })}
          </output>
        </label>
        <button type="button" className={viewButton} onClick={() => view?.home()}>
          {t('siteView.home')}
        </button>
        <button
          type="button"
          aria-label={t('siteView.zoomIn')}
          className={viewButton}
          onClick={() => view?.zoomBy(0.6)}
        >
          +
        </button>
        <button
          type="button"
          aria-label={t('siteView.zoomOut')}
          className={viewButton}
          onClick={() => view?.zoomBy(1.7)}
        >
          −
        </button>
      </ViewPills>
      <button type="button" className={`${viewButton} absolute inset-e-3 top-3`} onClick={closeSite}>
        {t('siteView.back')}
      </button>
      <div className="pointer-events-none absolute inset-x-3 bottom-3.5 flex flex-col items-center gap-1.5">
        <p className="pointer-events-auto max-w-2xl rounded-md bg-bar/80 px-2.5 py-1 text-center text-[11px] text-quiet">
          {metresPerPixel !== undefined && `${t('siteView.resolution', { m: formatNumber(metresPerPixel, 0) })} `}
          <Trans
            i18nKey={`siteView.credit.${mission.body}`}
            components={{
              gld: <Ext href={GLD100} />,
              megdr: <Ext href={MEGDR} />,
              sss: <Ext href={SSS} />,
              ccby: <Ext href={CC_BY} />,
            }}
          />
        </p>
        <p className={`${hintBox} max-sm:hidden`}>{t('siteView.hint')}</p>
      </div>
      <ViewStatus view="site" load={load} />
    </section>
  );
}
