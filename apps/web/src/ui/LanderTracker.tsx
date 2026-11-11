import {
  canPlanAtPole,
  type LanderBody,
  localSolarHours,
  MISSION_FILTERS,
  type Mission,
  missionPlace,
  missionsFor,
  nextMission,
  type PinStyle,
  patchKey,
  pinStyleOf,
  roverProgress,
  sunAzimuthDeg,
  sunHeightDeg,
  toneOf,
} from '@siteline/engine';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { formatDate, formatNumber } from '../format';
import { findLander, MISSION_SOURCES, MISSIONS, modelUrl, statusKey, textOf } from '../landers';
import { useApp } from '../store';
import { useLanderFiles, useShownUtcMs, useSubsolar } from '../useLanders';
import { panel, smallButton } from './Controls';
import { ModelBox } from './ModelBox';

const NASA_3D = 'https://github.com/nasa/NASA-3D-Resources';
const JPL_MAPS = 'https://science.nasa.gov/mission/mars-2020-perseverance/location-map/';
const YEAR_MS = 31_557_600_000;

const DOT_COLOUR: Record<PinStyle, string> = {
  crew: 'var(--color-warn)',
  landed: 'var(--color-ink)',
  tipped: 'var(--color-ink)',
  active: 'var(--color-pass)',
  lost: 'var(--color-fail)',
  crashed: 'var(--color-fail)',
  failed: 'var(--color-fail)',
  impact: 'var(--color-quiet)',
  next: 'var(--color-accent)',
  planned: 'var(--color-accent)',
  onway: 'var(--color-accent)',
  future: 'var(--color-accent)',
};
const TONE_CLASS = {
  good: 'border-pass text-pass',
  warn: 'border-warn text-warn',
  bad: 'border-fail text-fail',
  plain: 'border-white/20 text-ink',
} as const;

function Ext({ href, children }: { href: string; children?: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-ink">
      {children}
    </a>
  );
}

/** A small marker in the list: dashed for a lander that has not landed, solid otherwise. */
function Dot({ style }: { style: PinStyle }) {
  const colour = DOT_COLOUR[style];
  return (
    <span
      aria-hidden="true"
      className="mt-1 block size-3 shrink-0 rounded-full"
      style={style === 'future' ? { border: `2px dashed ${colour}` } : { background: colour }}
    />
  );
}

const YEAR_FROM = 1962;
const YEAR_TO = 2032;

/** Every lander of the body on a line of years, with the date shown marked. */
function Timeline({
  missions,
  shownMs,
  selectedId,
}: {
  missions: readonly Mission[];
  shownMs: number;
  selectedId: string | null;
}) {
  const { t } = useTranslation();
  const at = (ms: number) => {
    const d = new Date(ms);
    return 10 + ((d.getUTCFullYear() + d.getUTCMonth() / 12 - YEAR_FROM) / (YEAR_TO - YEAR_FROM)) * 300;
  };
  const decades = [1970, 1980, 1990, 2000, 2010, 2020, 2030];
  return (
    <svg
      viewBox="0 0 320 46"
      role="img"
      aria-label={t('landers.timeline', { from: YEAR_FROM, to: YEAR_TO })}
      className="mt-2 w-full"
    >
      <line x1="10" x2="310" y1="20.5" y2="20.5" stroke="currentColor" className="text-white/20" />
      {decades.map((y) => (
        <g key={y}>
          <line
            x1={at(Date.UTC(y, 0, 1))}
            x2={at(Date.UTC(y, 0, 1))}
            y1="17"
            y2="24"
            stroke="currentColor"
            className="text-quiet"
          />
          <text
            x={at(Date.UTC(y, 0, 1))}
            y="40"
            textAnchor="middle"
            fontSize="9.5"
            fill="currentColor"
            className="text-quiet"
          >
            {y}
          </text>
        </g>
      ))}
      {missions.map((m, i) => (
        <circle
          key={m.id}
          cx={at(m.tUtcMs)}
          cy={12 + (i % 2) * 4}
          r={m.id === selectedId ? 4.5 : 3}
          fill={DOT_COLOUR[pinStyleOf(m, shownMs)]}
          opacity={m.id === selectedId ? 1 : 0.9}
        />
      ))}
      <line x1={at(shownMs)} x2={at(shownMs)} y1="4" y2="28" stroke="var(--color-warn)" />
    </svg>
  );
}

function MissionList({ body }: { body: LanderBody }) {
  const { t, i18n } = useTranslation();
  const shownMs = useShownUtcMs();
  const filter = useApp((s) => s.missionFilter);
  const setFilter = useApp((s) => s.setMissionFilter);
  const select = useApp((s) => s.selectMission);
  const selectedId = useApp((s) => s.missionId);
  const all = MISSIONS.filter((m) => m.body === body);
  const shown = missionsFor(MISSIONS, body, filter, shownMs);
  const next = nextMission(MISSIONS, body);

  return (
    <section className={panel} data-testid="lander-list">
      <h2 className="font-semibold">{t('landers.title', { name: t(`bodies.${body.toLowerCase()}`) })}</h2>
      <p className="mt-1 text-xs text-quiet">{t('landers.key')}</p>
      {next && (
        <button type="button" className={`${smallButton} mt-3 w-full text-start`} onClick={() => select(next.id)}>
          <b>{t(next.status === 'onway' ? 'landers.status.onway' : 'landers.nextUp')}:</b> {next.name} ·{' '}
          <span className="text-quiet">
            {next.dateLabel ? textOf(next.dateLabel, i18n.language) : formatDate(next.tUtcMs)}
          </span>
        </button>
      )}
      <Timeline missions={all} shownMs={shownMs} selectedId={selectedId} />
      <fieldset className="mt-2 flex flex-wrap gap-1">
        <legend className="sr-only">{t('landers.filtersLabel')}</legend>
        {MISSION_FILTERS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={filter === k}
            className={`${smallButton} ${filter === k ? 'border-accent bg-accent/20' : ''}`}
            onClick={() => setFilter(k)}
          >
            {t(`landers.filters.${k}`)}
          </button>
        ))}
      </fieldset>
      {shown.length === 0 ? (
        <p className="mt-3 text-sm text-quiet">{t('landers.empty')}</p>
      ) : (
        <ul className="mt-2 flex max-h-96 flex-col gap-1 overflow-y-auto">
          {shown.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid={`mission-${m.id}`}
                className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-white/5"
                onClick={() => select(m.id)}
              >
                <Dot style={pinStyleOf(m, shownMs)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{m.name}</span>
                  <span className="block text-xs text-quiet">{textOf(m.site, i18n.language)}</span>
                </span>
                <span className="text-xs text-quiet">
                  {m.dateLabel && pinStyleOf(m, shownMs) === 'future'
                    ? textOf(m.dateLabel, i18n.language)
                    : new Date(m.tUtcMs).getUTCFullYear()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-quiet">{t('landers.hint')}</p>
      <p className="mt-2 text-xs text-quiet">
        <Trans i18nKey="landers.credit" components={{ jpl: <Ext href={JPL_MAPS} />, models: <Ext href={NASA_3D} /> }} />
      </p>
    </section>
  );
}

function Stat({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <dt className="text-quiet">{label}</dt>
      <dd className="text-end" data-testid={testId}>
        {children}
      </dd>
    </>
  );
}

function MissionCard({ mission: m }: { mission: Mission }) {
  const { t, i18n } = useTranslation();
  const shownMs = useShownUtcMs();
  const select = useApp((s) => s.selectMission);
  const openSite = useApp((s) => s.openSite);
  const focusSite = useApp((s) => s.focusSite);
  const { tracks, sites } = useLanderFiles();
  const subsolar = useSubsolar(m.body);

  const at = missionPlace(MISSIONS, m, tracks, shownMs);
  const future = pinStyleOf(m, shownMs) === 'future';
  const compass = (v: number, positive: string, negative: string) =>
    `${formatNumber(Math.abs(v), 3)}° ${t(v >= 0 ? positive : negative)}`;
  const sunHeight = at && subsolar ? sunHeightDeg(at.latDeg, at.lonDeg, subsolar.latDeg, subsolar.lonDeg) : undefined;
  const sun =
    at && subsolar && sunHeight !== undefined
      ? { heightDeg: sunHeight, azimuthDeg: sunAzimuthDeg(at.latDeg, at.lonDeg, subsolar.latDeg, subsolar.lonDeg) }
      : undefined;
  const solarTime = at && subsolar ? localSolarHours(at.lonDeg, subsolar.lonDeg) : undefined;
  const clock = (hours: number) =>
    `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((hours % 1) * 60)).padStart(2, '0')}`;
  const drove =
    tracks && (m.id === 'perseverance' || m.id === 'curiosity')
      ? roverProgress(MISSIONS, tracks, m.id, shownMs)
      : undefined;
  const sources = m.sourceIds.flatMap((id) => (MISSION_SOURCES[id] ? [MISSION_SOURCES[id]] : []));
  const model = modelUrl(m);
  const hasCloseUp = m.patch !== undefined && sites?.[patchKey(m) ?? ''] !== undefined;

  return (
    <section className={panel} data-testid="mission-card">
      <button type="button" className={smallButton} onClick={() => select(null)}>
        {i18n.dir() === 'rtl' ? '→' : '←'} {t('landers.back')}
      </button>
      <h2 className="mt-3 text-lg font-semibold">{m.name}</h2>
      <p className="text-sm text-quiet">{m.operator}</p>
      <div className="my-2 flex flex-wrap gap-2 text-xs">
        <span className={`rounded-full border px-2 py-0.5 ${TONE_CLASS[toneOf(m)]}`}>
          {t(`landers.status.${statusKey(m, shownMs)}`)}
        </span>
        {m.approximate && (
          <span className="rounded-full border border-white/20 px-2 py-0.5">{t('landers.approx')}</span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {future ? (
          <Stat label={t(m.status === 'onway' ? 'landers.launchedOn' : 'landers.plannedFor')}>
            {m.dateLabel ? textOf(m.dateLabel, i18n.language) : formatDate(m.tUtcMs)}
          </Stat>
        ) : (
          <Stat label={t(m.status === 'failed' ? 'landers.launchedOn' : 'landers.landedOn')}>
            {formatDate(m.tUtcMs)}
          </Stat>
        )}
        <Stat label={t('landers.siteLabel')}>{textOf(m.site, i18n.language)}</Stat>
        {at && (
          <Stat label={t('landers.coords')} testId="mission-coords">
            <span dir="ltr">
              {compass(at.latDeg, 'landers.north', 'landers.south')},{' '}
              {compass(at.lonDeg, 'landers.east', 'landers.west')}
            </span>
          </Stat>
        )}
        {drove && drove.km > 0 && (
          <>
            <Stat label={t('landers.driven')}>{formatNumber(drove.km, 2)} km</Stat>
            <Stat label={t('landers.sol')}>{drove.sol}</Stat>
          </>
        )}
        {!future &&
          (m.status === 'crew' || m.status === 'landed' || m.status === 'tipped' || m.status === 'active') && (
            <Stat label={t('landers.since')}>
              {t('landers.years', { n: formatNumber((shownMs - m.tUtcMs) / YEAR_MS, 1) })}
            </Stat>
          )}
        {sunHeight !== undefined && solarTime !== undefined && (
          <>
            <Stat label={t('landers.sunHeight')}>{formatNumber(sunHeight, 1)}°</Stat>
            <Stat label={t('landers.solarTime')}>
              <span dir="ltr">{clock(solarTime)}</span>
            </Stat>
          </>
        )}
      </dl>
      <p className="mt-3 text-sm">{textOf(m.note, i18n.language)}</p>
      {!at && <p className="mt-2 text-xs text-quiet">{t('landers.noPin')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {at && (
          <button type="button" className={smallButton} onClick={() => select(m.id)}>
            {t('landers.fly')}
          </button>
        )}
        {hasCloseUp && (
          <button type="button" className={smallButton} onClick={openSite} data-testid="open-site">
            {t('landers.closeUp')}
          </button>
        )}
        {canPlanAtPole(m) && at && (
          <button type="button" className={smallButton} onClick={() => focusSite(at.latDeg, at.lonDeg)}>
            {t('landers.planPole')}
          </button>
        )}
      </div>
      {model && at && <ModelBox url={model} body={m.body} sun={sun} />}
      {(sources.length > 0 || m.track || model) && (
        <>
          <h3 className="mt-4 text-xs text-quiet">{t('landers.sources')}</h3>
          <ol dir="ltr" className="mt-1 list-decimal ps-5 text-xs text-quiet">
            {sources.map(([label, url]) => (
              <li key={url}>
                <Ext href={url}>{label}</Ext>
              </li>
            ))}
            {m.track && <li>{t('landers.tracksNote')}</li>}
            {model && (
              <li>
                <Ext href={NASA_3D}>{t('landers.modelSource')}</Ext>
              </li>
            )}
          </ol>
        </>
      )}
    </section>
  );
}

/** The list of landers on one body, or the card of the one that is open. */
export function LanderTracker({ body }: { body: LanderBody }) {
  const missionId = useApp((s) => s.missionId);
  const mission = missionId ? findLander(missionId) : undefined;
  return (
    <aside className="flex flex-col gap-4" aria-live="polite">
      {mission && mission.body === body ? <MissionCard mission={mission} /> : <MissionList body={body} />}
    </aside>
  );
}
