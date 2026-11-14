import { DEFAULT_STAY } from '@siteline/contracts';
import { EYE_HEIGHT_M } from '@siteline/physics';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../format';
import type { LandingTarget } from '../../land';
import type { SurfaceLevelData } from '../../physics.worker';
import { EarthIcon, SunIcon } from './SurfaceCompass';

/** What the About panel says about a ring, without its arrays. */
export type RingInfo = Omit<SurfaceLevelData, 'positions' | 'normals' | 'indices' | 'up'>;

interface Props {
  target: LandingTarget;
  rings: RingInfo[];
  walkIndex: number;
  /** The Artemis III region whose 5 m terrain the innermost ring comes from, if it does. */
  fineRegion?: string;
  /** How finely the shadows were worked out on the walkable ground, metres. */
  shadowM: number;
  onClose: () => void;
}

/**
 * About this view: what the surface view is drawn from and what it assumes, in short sections with the terrain's rings
 * as a table. Every number in it comes from the scene the worker built or from the physics package.
 */
export function SurfaceAbout({ target, rings, walkIndex, fineRegion, shadowM, onClose }: Props) {
  const { t } = useTranslation();
  const metres = (m: number) => t('land.info.metres', { m: formatNumber(m, m < 10 ? 1 : 0) });
  // The rings, in runs that share a dataset: each run is listed under its dataset's id.
  const groups: { id: string; rings: { ring: RingInfo; fromM: number }[] }[] = [];
  rings.forEach((ring, i) => {
    const fromM = rings[i - 1]?.halfM ?? 0;
    const last = groups.at(-1);
    if (last && last.id === ring.datasetId) last.rings.push({ ring, fromM });
    else groups.push({ id: ring.datasetId, rings: [{ ring, fromM }] });
  });

  const section = (title: string, children: ReactNode, testId?: string) => (
    <section className="border-t border-line pt-3" data-testid={testId}>
      <h4 className="mb-1.5 font-display text-xs font-semibold tracking-wide text-quiet uppercase">{title}</h4>
      <div className="space-y-2">{children}</div>
    </section>
  );

  return (
    <section
      className="glass pointer-events-auto flex max-h-[min(38rem,calc(100dvh-18rem))] min-h-0 w-full max-w-[27rem] flex-col self-end overflow-hidden max-sm:fixed max-sm:inset-3 max-sm:z-20 max-sm:max-h-none max-sm:w-auto max-sm:max-w-none max-sm:self-stretch"
      aria-labelledby="surface-about-title"
      data-testid="surface-info"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line py-1 ps-4 pe-1">
        <h3 id="surface-about-title" className="font-display text-base">
          {t('land.about')}
        </h3>
        <button
          type="button"
          className="grid size-11 place-items-center rounded-md text-lg text-quiet hover:text-ink"
          onClick={onClose}
          aria-label={t('land.close')}
          data-testid="surface-about-close"
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="space-y-3 overflow-y-auto px-4 pt-3 pb-4 text-sm leading-relaxed">
        <p>{t('land.info.what')}</p>

        {/* At a glance: what the picture keeps true. */}
        <ul className="flex flex-wrap gap-1.5 text-xs">
          <li className="rounded-pill border border-line bg-panel-raised/80 px-2.5 py-1">{t('land.info.factScale')}</li>
          <li className="rounded-pill border border-line bg-panel-raised/80 px-2.5 py-1">
            {t('land.info.factEye', { eye: formatNumber(EYE_HEIGHT_M, 1) })}
          </li>
          <li className="rounded-pill border border-line bg-panel-raised/80 px-2.5 py-1">
            {t('land.info.factShadows', { m: formatNumber(shadowM, shadowM < 10 ? 1 : 0) })}
          </li>
          <li className="flex items-center gap-1.5 rounded-pill border border-line bg-panel-raised/80 px-2.5 py-1">
            <SunIcon inView className="size-3" />
            <EarthIcon inView className="size-3" />
            {t('land.info.factSky')}
          </li>
        </ul>

        {target.source.kind === 'passing' && (
          <p className="rounded-lg border border-sun/40 bg-sun-wash/40 px-3 py-2 text-sun-ink">
            {t('land.passing', {
              sun: formatNumber(target.source.sunFractionMin * 100, 0),
              earth: formatNumber(target.source.earthVisiblePct, 0),
              slope: formatNumber(target.source.slope100mDeg, 1),
              observer: formatNumber(DEFAULT_STAY.observerHeightM, 0),
            })}
          </p>
        )}

        {section(
          t('land.info.ringsTitle'),
          <>
            <p>{t('land.info.rings')}</p>
            <div className="overflow-x-auto rounded-lg border border-line bg-panel-sunk/70">
              <table className="w-full text-xs" data-testid="surface-rings">
                <thead className="text-quiet">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-1.5 py-1.5 text-start font-normal">
                      {t('land.info.colReach')}
                    </th>
                    <th scope="col" className="px-1.5 py-1.5 text-end font-normal">
                      {t('land.info.colData')}
                    </th>
                    <th scope="col" className="px-1.5 py-1.5 text-end font-normal">
                      {t('land.info.colMesh')}
                    </th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.rings[0].ring.index} className="border-b border-line/60 last:border-0">
                    <tr>
                      <th scope="rowgroup" colSpan={3} className="px-1.5 pt-2 pb-0.5 text-start font-normal">
                        <span className="text-quiet">{t('land.info.colDataset')}</span>{' '}
                        <bdi className="font-mono">{g.id}</bdi>
                      </th>
                    </tr>
                    {g.rings.map(({ ring: l, fromM }) => {
                      const walk = l.index === walkIndex;
                      const notes = [
                        l.filledPct >= 0.05 && t('land.info.filled', { pct: formatNumber(l.filledPct, 1) }),
                        l.missingPct >= 0.05 && t('land.info.missing', { pct: formatNumber(l.missingPct, 1) }),
                        l.provisional && t('land.info.provisional'),
                      ].filter(Boolean);
                      return (
                        <tr key={l.index} className={walk ? 'bg-sun-wash/30' : ''}>
                          <td className="px-1.5 py-1 align-top">
                            <span className="font-mono whitespace-nowrap tabular-nums" dir="ltr">
                              {t('land.info.reach', {
                                from: formatNumber(fromM / 1000, 1),
                                to: formatNumber(l.halfM / 1000, 1),
                              })}
                            </span>
                            {walk && <span className="block text-sun-ink">{t('land.info.walkable')}</span>}
                            {notes.length > 0 && <span className="block text-quiet">{notes.join(' · ')}</span>}
                          </td>
                          <td className="px-1.5 py-1 text-end align-top font-mono whitespace-nowrap tabular-nums">
                            {metres(l.sourcePixM)}
                          </td>
                          <td className="px-1.5 py-1 text-end align-top font-mono whitespace-nowrap tabular-nums">
                            {metres(l.spacingM)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
            <p className="text-xs text-quiet">{t('land.info.tableNote')}</p>
            {fineRegion && (
              <p className="text-xs text-quiet">
                {t('land.info.fineCredit', {
                  region: fineRegion,
                  km: formatNumber((rings[0]?.halfM ?? 0) / 1000, 1),
                })}
              </p>
            )}
            <p>{t('land.info.scale')}</p>
          </>,
          'surface-info-terrain',
        )}

        {section(
          t('land.info.lightTitle'),
          <>
            <p>{t('land.info.shadows', { shadow: formatNumber(shadowM, shadowM < 10 ? 1 : 0) })}</p>
            <p>{t('land.info.material')}</p>
            <p>{t('land.info.earthLook')}</p>
          </>,
        )}

        {section(
          t('land.info.eyeTitle'),
          <p>
            {t('land.info.eye', {
              eye: formatNumber(EYE_HEIGHT_M, 1),
              observer: formatNumber(DEFAULT_STAY.observerHeightM, 0),
            })}
          </p>,
        )}

        {section(
          t('land.info.compassTitle'),
          <>
            <p>{t('land.info.compass')}</p>
            <p>{t('land.info.compassMarks')}</p>
          </>,
          'surface-info-compass',
        )}

        {section(
          t('land.info.limitsTitle'),
          <ul className="list-disc space-y-1.5 ps-4 marker:text-quiet">
            <li>{t('land.info.detail')}</li>
            <li>{t('land.info.slope')}</li>
            <li>{t('land.info.descent')}</li>
          </ul>,
        )}
      </div>
    </section>
  );
}
