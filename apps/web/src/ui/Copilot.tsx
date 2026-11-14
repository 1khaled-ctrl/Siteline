import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Confidence, confidenceOf, type Reading, SLOPE_NEEDS_M } from '../confidence';
import { type Aspect, type Intent, parseIntent, type SiteSummary, summarize, type Target } from '../copilot';
import { askAi, type ChatMessage, type ToolCall, type ToolResult } from '../copilotAi';
import { formatNumber, formatUtc } from '../format';
import { findLander, MISSIONS } from '../landers';
import { physics, queryFor, URLS } from '../physics';
import { fitAt, isRobotId, LANDING_RADII_M, type LandingRadius, nearestLander, ROBOTS } from '../robots';
import { sound } from '../sound';
import { useStage } from '../stage';
import { type MoonView, useApp } from '../store';
import { CHECK_KEYS } from '../verdict';
import { Spinner } from './ViewStatus';

interface Message {
  id: number;
  from: 'you' | 'siteline';
  text: string;
  /** The tool call behind a reply, shown so it is clear what was looked up. */
  call?: string;
  sources?: string[];
  /** Numbers in an AI reply that no tool of that turn gave: shown while developing, logged on the live site. */
  unverified?: string[];
}

/** Who answered last: the free AI model, or the matcher in the browser when the AI is not reachable. */
type Mode = 'ai' | 'basic' | 'unknown';

/** Rounded to a tenth, the precision the report shows, so the model repeats what the screen says. */
const tenth = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const TARGETS: Target[] = ['solar', 'earth', 'mars', 'moon', 'pole'];

const NAMES = MISSIONS.map((m) => ({ id: m.id, name: m.name }));
const VIEW_OF: Record<Target, MoonView> = { solar: 'solar', earth: 'earth', mars: 'mars', moon: 'globe', pole: 'pole' };
const EXAMPLES = ['example1', 'example2', 'example7', 'example3', 'example4', 'example5'];
const READINGS: Reading[] = ['zone', 'sun', 'earth', 'height', 'longTerm', 'slope'];
const CONFIDENCE_LEVELS: Confidence[] = ['high', 'firstPass', 'flatHorizon', 'notMeasured'];

const callText = (intent: Intent) =>
  intent.tool === 'help'
    ? ''
    : `${intent.tool}(${Object.entries(intent.input)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ')})`;

/**
 * A small chat over the 3D view. It can fly the view, open a mission's card, and answer questions about the selected
 * Moon landing site from the same check the site report runs. It never writes data and calls no outside service.
 */
export function Copilot() {
  const { t } = useTranslation();
  const open = useStage((s) => s.copilotOpen);
  const setOpen = useStage.getState().setCopilotOpen;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Message[]>([]);
  const [mode, setMode] = useState<Mode>('unknown');
  const history = useRef<ChatMessage[]>([]);
  const next = useRef(1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message is what scrolls the log down.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const say = (m: Omit<Message, 'id'>) => {
    setLog((l) => [...l, { ...m, id: next.current++ }]);
    if (m.from === 'siteline') sound.chime();
  };

  const place = (s: { latDeg: number; lonDeg: number }) =>
    t('share.place', {
      lat: formatNumber(Math.abs(s.latDeg), 2),
      northSouth: s.latDeg < 0 ? t('landers.south') : t('landers.north'),
      lon: formatNumber(Math.abs(s.lonDeg), 2),
      eastWest: s.lonDeg < 0 ? t('landers.west') : t('landers.east'),
    });

  const answer = (aspect: Aspect, s: SiteSummary): string => {
    const pct = (v: number) => formatNumber(v, 0);
    const head = t('copilot.site', { place: place(s), date: formatUtc(s.landingUtc) });
    const failed = CHECK_KEYS.filter((k) => s.checks[k] === 'no').map((k) => t(`copilot.checkNames.${k}`));
    const unknown = CHECK_KEYS.filter((k) => s.checks[k] === 'unknown').map((k) => t(`copilot.checkNames.${k}`));
    const verdict = t(`copilot.verdict.${s.verdict}`, { failed: failed.join(', '), unknown: unknown.join(', ') });
    const problem = s.problem
      ? s.problem.atLanding
        ? t(`compare.atLanding.${s.problem.key}`)
        : `${t(`compare.problem.${s.problem.key}`)}${s.problem.atUtc ? ` ${formatUtc(s.problem.atUtc)}` : ''}`
      : undefined;
    const when = (iso: string | undefined) => (iso ? formatUtc(iso) : t('report.none'));
    // The site report's confidence marks, grouped: which readings are solid and which are a first pass.
    const sure = {
      terrainM: s.terrainKm !== undefined ? s.terrainKm * 1000 : undefined,
      longTermM: s.longTerm?.resolutionM,
    };
    const confidence = CONFIDENCE_LEVELS.map((level) => {
      const names = READINGS.filter((r) => confidenceOf(r, sure) === level).map((r) => t(`copilot.readingNames.${r}`));
      return names.length ? t(`copilot.confidenceLevels.${level}`, { list: names.join(', ') }) : '';
    }).filter(Boolean);
    const lines: Record<Aspect, string[]> = {
      confidence: [head, ...confidence],
      verdict: [head, verdict],
      why: [head, problem ? t('copilot.firstProblem', { problem }) : t('copilot.noProblem'), verdict],
      sun: [head, t('copilot.sun', { pct: pct(s.sunMinPct) }), t('copilot.nextSunset', { at: when(s.next.sunset) })],
      earth: [
        head,
        t('copilot.earth', { pct: pct(s.earthPct) }),
        t('copilot.nextEarthset', { at: when(s.next.earthset) }),
      ],
      slope: [
        head,
        s.checks.slope === 'unknown'
          ? s.terrainKm === undefined
            ? t('copilot.slopeNoTerrain')
            : s.terrainKm * 1000 > SLOPE_NEEDS_M
              ? t('copilot.slopeUnknown', {
                  size:
                    s.terrainKm >= 1 ? `${formatNumber(s.terrainKm)} km` : `${formatNumber(s.terrainKm * 1000, 0)} m`,
                })
              : // Terrain fine enough for the rule is loaded, so the slope waits on the 10 m read.
                t('copilot.slopePending')
          : t(`copilot.slope.${s.checks.slope}`),
      ],
      height: [
        head,
        s.groundHeightM !== undefined
          ? t('copilot.height', { m: formatNumber(s.groundHeightM, 0) })
          : t('copilot.heightNone'),
      ],
      longTerm: [
        head,
        s.longTerm
          ? t('copilot.longTerm', {
              sun: pct(s.longTerm.sunPct),
              earth: pct(s.longTerm.earthPct),
              shadow: s.longTerm.shadowed ? t('copilot.shadowed') : '',
            })
          : t('copilot.longTermNone'),
      ],
      events: [
        head,
        t('copilot.events', {
          sunset: when(s.next.sunset),
          sunrise: when(s.next.sunrise),
          earthset: when(s.next.earthset),
          earthrise: when(s.next.earthrise),
        }),
      ],
      summary: [
        head,
        verdict,
        t('copilot.sun', { pct: pct(s.sunMinPct) }),
        t('copilot.earth', { pct: pct(s.earthPct) }),
        ...(s.longTerm
          ? [t('copilot.longTerm', { sun: pct(s.longTerm.sunPct), earth: pct(s.longTerm.earthPct), shadow: '' })]
          : []),
        ...(problem ? [t('copilot.firstProblem', { problem })] : []),
      ],
    };
    return lines[aspect].join(' ');
  };

  /** The site check for the current site and date, waiting a few seconds for the 10 m slope as the report does. */
  const check = () => {
    const { latDeg, lonDeg, landingUtc, slipDays } = useApp.getState();
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    return physics.stay(query, URLS, 6000).then((r) => ({ query, r, site: { latDeg, lonDeg } }));
  };

  /** The tools the AI may call: the matcher's three, and the robot card's check. They read data or move the view. */
  const runTool = async (call: ToolCall): Promise<ToolResult> => {
    const a = call.arguments;
    const shown = `${call.name}(${Object.entries(a)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ')})`;
    if (call.name === 'fly_to') {
      const target = a.target as Target;
      if (!TARGETS.includes(target)) throw new Error(`no place called ${String(a.target)}`);
      useApp.getState().set({ view: VIEW_OF[target] });
      return { call: shown, data: { flyingTo: target } };
    }
    if (call.name === 'show_mission') {
      const named = parseIntent(String(a.name ?? ''), NAMES);
      if (named.tool !== 'show_mission') throw new Error(`no mission called ${String(a.name)}`);
      useApp.getState().selectMission(named.input.id);
      const m = findLander(named.input.id);
      return {
        call: shown,
        data: { opened: m?.name, status: m?.status, date: m?.date, site: m?.site[0], note: m?.note[0] },
      };
    }
    if (call.name === 'analyze_site') {
      const { query, r, site } = await check();
      const s = summarize(r, site, query.landingUtc);
      return {
        call: shown,
        sources: s.sources,
        data: {
          site,
          landingUtc: s.landingUtc,
          stayDays: query.stayDays,
          verdict: s.verdict,
          checks: s.checks,
          sunMinVisiblePct: tenth(s.sunMinPct),
          earthInViewPct: tenth(s.earthPct),
          landingSlope100mDeg: tenth(r.slope?.slope100mDeg),
          walkableWithin1kmPct: tenth(r.slope?.slope2kmPctUnder20),
          groundHeightM: s.groundHeightM === undefined ? null : Math.round(s.groundHeightM),
          horizonTerrainResolutionM: r.terrain?.resolutionM ?? null,
          longTerm: s.longTerm && {
            sunPct: tenth(s.longTerm.sunPct),
            earthPct: tenth(s.longTerm.earthPct),
            neverSunlit: s.longTerm.shadowed,
          },
          firstProblem: s.problem ?? null,
          next: s.next,
          caveat: 'Screening aid, not certification. Earth in view is not a radio link.',
        },
      };
    }
    if (call.name === 'robot_fit') {
      if (!isRobotId(a.robot)) throw new Error(`no robot called ${String(a.robot)}`);
      const robot = ROBOTS[a.robot];
      const radiusM = (LANDING_RADII_M as readonly number[]).includes(Number(a.landingRadiusM))
        ? (Number(a.landingRadiusM) as LandingRadius)
        : useApp.getState().landingRadiusM;
      // The card shows the same robot, so what the copilot says can be checked on screen.
      useApp.getState().set({ robot: robot.id, landingRadiusM: radiusM });
      const { query, r } = await check();
      const fit = fitAt(robot, query, r, radiusM);
      const near = nearestLander(query.site.latDeg, query.site.lonDeg);
      return {
        call: shown,
        sources: robot.sources,
        data: {
          robot: t(`robot.name.${robot.id}`),
          about: t(`robot.blurb.${robot.id}`),
          overall: fit.overall,
          landingRadiusM: radiusM,
          checks: fit.checks
            .filter((c) => c.status !== 'not_evaluated' || c.id === 'darkness')
            .map((c) => ({
              check: c.id,
              status: c.status,
              says: t(`robot.check.${c.id}.${c.reason}`, {
                radius: c.values.radiusM,
                limit: c.values.limitDeg,
                worst: tenth(c.values.worstDeg),
                steep: tenth(c.values.steepPct),
                sun: tenth(c.values.sunPct),
                dark: tenth(c.values.darkH),
                days: query.stayDays,
                pct: tenth(c.values.pct),
                walk: tenth(c.values.walkablePct),
                km: tenth(c.values.shadowKm),
              }),
            })),
          slopeLimitNote: t('robot.limitNote'),
          nearestLander: near && { name: near.name, km: tenth(near.km), approximate: near.approximate },
          caveat: t('robot.con3'),
        },
      };
    }
    throw new Error(`no tool called ${call.name}`);
  };

  const appState = () => {
    const s = useApp.getState();
    const query = queryFor({ latDeg: s.latDeg, lonDeg: s.lonDeg }, s.landingUtc, s.slipDays);
    return {
      view: s.view,
      selectedSite: { latDeg: s.latDeg, lonDeg: s.lonDeg },
      landingUtc: query.landingUtc,
      slipDays: s.slipDays,
      stayDays: query.stayDays,
      robot: s.robot,
      openMission: s.missionId,
    };
  };

  const run = async (message: string) => {
    const out = await askAi(message, appState(), history.current, runTool);
    if (out.ok) {
      history.current = out.history;
      setMode('ai');
      if (out.unverified.length) console.warn(`copilot: numbers no tool gave: ${out.unverified.join(', ')}`);
      return say({
        from: 'siteline',
        text: out.text,
        call: out.calls.map((c) => `↳ ${c}`).join('\n') || undefined,
        sources: out.sources,
        unverified: import.meta.env.DEV && out.unverified.length ? out.unverified : undefined,
      });
    }
    setMode('basic');
    return runBasic(message);
  };

  /** The matcher: one tool picked from the message's words, answered from the report's own sentences. */
  const runBasic = async (message: string) => {
    const intent = parseIntent(message, NAMES);
    const call = callText(intent) || undefined;
    if (intent.tool === 'help') return say({ from: 'siteline', text: t('copilot.help') });
    if (intent.tool === 'fly_to') {
      useApp.getState().set({ view: VIEW_OF[intent.input.target] });
      return say({
        from: 'siteline',
        call,
        text: t('copilot.flying', { place: t(`copilot.places.${intent.input.target}`) }),
      });
    }
    if (intent.tool === 'show_mission') {
      const m = findLander(intent.input.id);
      useApp.getState().selectMission(intent.input.id);
      return say({ from: 'siteline', call, text: t('copilot.mission', { name: m?.name ?? intent.input.id }) });
    }
    // analyze_site: the same check, on the same inputs, that the site report shows.
    const { latDeg, lonDeg, landingUtc, slipDays } = useApp.getState();
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    try {
      const s = summarize(await physics.stay(query, URLS), { latDeg, lonDeg }, query.landingUtc);
      say({ from: 'siteline', call, text: answer(intent.input.aspect, s), sources: s.sources });
    } catch (e) {
      say({
        from: 'siteline',
        call,
        text: t('copilot.failed', { message: e instanceof Error ? e.message : String(e) }),
      });
    }
  };

  const send = async (message: string) => {
    const m = message.trim();
    if (!m || busy) return;
    setText('');
    say({ from: 'you', text: m });
    setBusy(true);
    await run(m);
    setBusy(false);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  // The orb (Orb.tsx) opens it.
  if (!open) return null;

  return (
    <section
      aria-label={t('copilot.title')}
      data-avoid
      className="fixed inset-x-3 bottom-3 z-30 flex h-[min(520px,75dvh)] flex-col gap-2 rounded-xl border border-line bg-panel p-3 shadow-2xl lg:absolute lg:inset-x-auto lg:inset-s-3 lg:bottom-14 lg:h-[min(520px,calc(100%-80px))] lg:w-[420px]"
      data-testid="copilot"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg">
          {t('copilot.title')}{' '}
          <span className="ms-1 rounded-pill border border-line px-2 py-0.5 align-middle font-sans text-[11px] font-normal text-quiet">
            {t(`copilot.badge.${mode}`)}
          </span>
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-8 rounded-md border border-line bg-panel-raised px-2.5 text-[12.5px] hover:border-line-hover"
        >
          {t('copilot.close')}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pe-1" aria-live="polite">
        {log.length === 0 && (
          <div className="flex flex-col gap-2 text-sm text-quiet">
            <p>{t('copilot.intro')}</p>
            <div className="flex flex-wrap gap-1.5">
              {EXAMPLES.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => void send(t(`copilot.${k}`))}
                  className="min-h-8 rounded-pill border border-line bg-panel-raised px-3 text-[12.5px] text-ink hover:border-line-hover"
                >
                  {t(`copilot.${k}`)}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((m) =>
          m.from === 'you' ? (
            <p key={m.id} className="max-w-[85%] self-end rounded-lg bg-accent/15 px-3 py-1.5 text-sm">
              {m.text}
            </p>
          ) : (
            <div
              key={m.id}
              className="max-w-[92%] self-start rounded-lg border border-line bg-panel-raised px-3 py-2 text-sm"
            >
              {m.call && (
                <p className="mb-1 whitespace-pre-line font-mono text-[11.5px] text-quiet" dir="ltr">
                  {m.call.startsWith('↳') ? m.call : `↳ ${m.call}`}
                </p>
              )}
              <p>{m.text}</p>
              {m.unverified && (
                <p className="mt-1 text-xs text-warn">{t('copilot.unverified', { list: m.unverified.join(', ') })}</p>
              )}
              {m.sources && m.sources.length > 0 && (
                <p className="mt-1.5 text-xs text-quiet">
                  {t('report.sources')}:{' '}
                  {m.sources.map((id, i) => (
                    <span key={id}>
                      {i > 0 && ', '}
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-2 hover:text-ink"
                        onClick={() => useApp.getState().setSources(id)}
                      >
                        {id}
                      </button>
                    </span>
                  ))}
                </p>
              )}
            </div>
          ),
        )}
        {busy && (
          <p className="flex items-center gap-2 self-start text-sm text-quiet">
            <Spinner /> {t('copilot.thinking')}
          </p>
        )}
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="flex gap-1.5">
        <label htmlFor="copilot-input" className="sr-only">
          {t('copilot.inputLabel')}
        </label>
        <input
          id="copilot-input"
          ref={input}
          value={text}
          autoComplete="off"
          placeholder={t('copilot.placeholder')}
          onChange={(e) => setText(e.currentTarget.value)}
          className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-panel-sunk px-2.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="min-h-9 rounded-md border border-sun/60 bg-sun/15 px-3 text-sm text-sun-ink hover:border-sun disabled:opacity-50"
        >
          {t('copilot.send')}
        </button>
      </form>
      <p className="text-[11.5px] text-quiet">{t(mode === 'basic' ? 'copilot.noteBasic' : 'copilot.note')}</p>
    </section>
  );
}
