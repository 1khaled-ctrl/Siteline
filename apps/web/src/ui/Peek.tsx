import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FACT_BODIES, type FactBody } from '../bodyFacts';
import { findLander } from '../landers';
import { useStay } from '../physics';
import { useStage } from '../stage';
import { type MoonView, useApp } from '../store';
import { checksOf, verdictOf } from '../verdict';
import { useBodyReadings } from './BodyFacts';
import { FLYABLE, type Flyable, useWorldReadings, worldColour } from './WorldsList';

const BODY: Partial<Record<MoonView, FactBody>> = { earth: 'Earth', mars: 'Mars', globe: 'Moon' };
const VERDICT = {
  pass: { icon: '✓', className: 'text-pass' },
  fail: { icon: '✗', className: 'text-fail' },
  undecided: { icon: '?', className: 'text-warn' },
} as const;

/** One line: what you are looking at, and the number that matters most there. */
function Line({
  title,
  value,
  dot,
  action,
}: {
  title: ReactNode;
  value?: ReactNode;
  dot?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3" aria-live="polite">
      {dot && (
        <span className="size-3 shrink-0 rounded-pill" style={{ background: dot, boxShadow: `0 0 10px ${dot}` }} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-lg leading-tight">{title}</p>
        {value && <p className="line-clamp-2 text-[13px] leading-snug text-quiet">{value}</p>}
      </div>
      {action}
    </div>
  );
}

function WorldPeek() {
  const { t } = useTranslation();
  const world = useStage((s) => s.dialWorld);
  const { readings } = useWorldReadings();
  const r = readings(world);
  return (
    <Line
      dot={worldColour(world)}
      title={r.name}
      value={
        <>
          {t('worlds.fromSun')} <bdi className="font-mono text-ink">{r.fromSun}</bdi> · {t('worlds.signal')}{' '}
          <bdi className="font-mono text-ink">{r.signal}</bdi>
        </>
      }
      action={
        FLYABLE.has(world) && (
          <button
            type="button"
            className="callout-go min-h-11 px-4"
            aria-label={t('callout.flyTo', { name: r.name })}
            onClick={() => useApp.getState().commandSolar(world as Flyable)}
          >
            {t('callout.fly')}
          </button>
        )
      }
    />
  );
}

function BodyPeek({ body }: { body: FactBody }) {
  const { t } = useTranslation();
  const r = useBodyReadings(body);
  return (
    <Line
      title={t(`facts.heading.${body}`)}
      value={
        body === 'Earth' ? (
          <>
            {t('facts.sunlight')} <bdi className="font-mono text-ink">{r.sunlight}</bdi>
          </>
        ) : (
          <>
            {t('facts.signal')} <bdi className="font-mono text-ink">{r.signal}</bdi>
          </>
        )
      }
    />
  );
}

function SitePeek() {
  const { t } = useTranslation();
  const { result } = useStay();
  if (!result) return <Line title={t('callout.site')} value={t('callout.checking')} />;
  const v = verdictOf(checksOf(result));
  return (
    <Line
      title={
        <span className={VERDICT[v].className}>
          <span aria-hidden="true">{VERDICT[v].icon} </span>
          {t(`report.verdict.${v}`)}
        </span>
      }
      value={
        <>
          {t('report.sunMin')} <bdi className="font-mono text-ink">{`${Math.round(result.sunFractionMin * 100)}%`}</bdi>
          {' · '}
          {t('report.earthPct')} <bdi className="font-mono text-ink">{`${Math.round(result.earthVisiblePct)}%`}</bdi>
        </>
      }
    />
  );
}

/** The sheet's line for each view: the picked world, the site's verdict, a globe's signal time, or the lander. */
export function Peek({ view }: { view: MoonView }) {
  const missionId = useApp((s) => s.missionId);
  const body = BODY[view];
  if (view === 'solar') return <WorldPeek />;
  if (view === 'pole') return <SitePeek />;
  if (body && FACT_BODIES.includes(body)) return <BodyPeek body={body} />;
  const lander = findLander(missionId ?? '');
  return <Line title={lander?.name ?? ''} />;
}
