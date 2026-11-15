import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MISSION_NAMES, runAgentTool, type SitesCard } from '../agentTools';
import { type Confidence, confidenceOf, type Reading, SLOPE_NEEDS_M } from '../confidence';
import { type Aspect, type Intent, parseIntent, type SiteSummary, summarize, type Target } from '../copilot';
import { askAi, type ChatMessage, plainReply, type ToolCall, type ToolResult } from '../copilotAi';
import { formatNumber, formatUtc } from '../format';
import { findLander } from '../landers';
import type { LiveSession, LiveState } from '../liveVoice';
import { physics, queryFor, URLS } from '../physics';
import { sound } from '../sound';
import { useStage } from '../stage';
import { type MoonView, useApp } from '../store';
import { CHECK_KEYS } from '../verdict';
import { canListen, canSpeak, listen, speak, stopSpeaking } from '../voice';
import { Spinner } from './ViewStatus';

/** One tool the agent ran for a reply, shown as a step while it works and kept after. */
interface Step {
  id: number;
  tool: string;
  call: string;
  status: 'running' | 'done' | 'failed';
  /** What it is doing right now, or why it failed. */
  detail?: string;
}

interface Message {
  id: number;
  from: 'you' | 'siteline';
  text: string;
  /** The tool call behind a matcher reply, shown so it is clear what was looked up. */
  call?: string;
  sources?: string[];
  /** Numbers in an AI reply that no tool of that turn gave: shown while developing, logged on the live site. */
  unverified?: string[];
  /** The agent's steps for this reply, in order. */
  steps?: Step[];
  /** Sites a search found, as buttons. */
  card?: SitesCard;
  /** True while the agent is still working on this reply. */
  working?: boolean;
}

/** Who answered last: the free AI model, or the matcher in the browser when the AI is not reachable. */
type Mode = 'ai' | 'basic' | 'unknown';

const VIEW_OF: Record<Target, MoonView> = { solar: 'solar', earth: 'earth', mars: 'mars', moon: 'globe', pole: 'pole' };
const EXAMPLES = ['example8', 'example1', 'example2', 'example7', 'example3', 'example4'];
const READINGS: Reading[] = ['zone', 'sun', 'earth', 'height', 'longTerm', 'slope'];
const CONFIDENCE_LEVELS: Confidence[] = ['high', 'firstPass', 'flatHorizon', 'notMeasured'];

const callText = (intent: Intent) =>
  intent.tool === 'help' || intent.tool === 'find_landing_sites'
    ? ''
    : `${intent.tool}(${Object.entries(intent.input)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ')})`;

/**
 * Ask SiteLine: a chat over the 3D view that works as an agent. It can fly the view, open a mission, check any Moon
 * site, and search the south pole for a site that passes, showing each step as it runs and moving the screen as it
 * goes. Tools run here with the functions the screen uses. It speaks and listens through the browser's own speech.
 */
export function Copilot() {
  const { t, i18n } = useTranslation();
  const open = useStage((s) => s.copilotOpen);
  const setOpen = useStage.getState().setCopilotOpen;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Message[]>([]);
  const [mode, setMode] = useState<Mode>('unknown');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string>();
  /** Replies are read aloud after a question asked by voice, until the visitor types again. */
  const [speakReplies, setSpeakReplies] = useState(false);
  const history = useRef<ChatMessage[]>([]);
  const next = useRef(1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const voice = canListen();
  /** The live voice call (LiveKit), while one is on; its state; and whether the visitor's mic is muted in it. */
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [muted, setMuted] = useState(false);
  const live = useRef<LiveSession | null>(null);
  /** Each transcript segment's message, so a growing segment updates its message instead of adding one. */
  const segments = useRef(new Map<string, number>());
  /** The steps message for the agent's current piece of work in the call, with the cards and tools it used. */
  const liveWork = useRef<{
    id: number;
    cards: SitesCard[];
    tools: string[];
    run: (call: ToolCall) => Promise<ToolResult>;
  } | null>(null);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      // Fetch LiveKit's client while the visitor reads the chat, so "Talk live" connects without that wait.
      void import('../liveVoice').then((m) => m.warmUpWebRtc()).catch(() => {});
    } else {
      stopListening.current?.();
      stopSpeaking();
      void live.current?.stop();
    }
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new message or step is what scrolls the log down.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const add = (m: Omit<Message, 'id'>): number => {
    const id = next.current++;
    setLog((l) => [...l, { ...m, id }]);
    return id;
  };
  const update = (id: number, patch: (m: Message) => Partial<Message>) =>
    setLog((l) => l.map((m) => (m.id === id ? { ...m, ...patch(m) } : m)));

  /** A progress line read aloud after a spoken question, queued behind what is already being said. */
  const narrate = (sentence: string) => speak(sentence, i18n.language, { queue: true });

  const say = (m: Omit<Message, 'id'>, spoken: boolean) => {
    add(m);
    if (m.from === 'siteline') {
      sound.chime();
      if (spoken && m.text) speak(m.text, i18n.language);
    }
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
    const where = t('copilot.friendly.where', { place: place(s), date: formatUtc(s.landingUtc) });
    const firstFailed = CHECK_KEYS.find((k) => s.checks[k] === 'no');
    const headline =
      s.verdict === 'pass'
        ? t('copilot.friendly.pass')
        : s.verdict === 'fail' && firstFailed
          ? t('copilot.friendly.fail', { why: t(`copilot.friendly.why.${firstFailed}`) })
          : t('copilot.friendly.undecided', { unknown: unknown.join(', ') });
    const sunLine =
      s.sunMinPct >= 99.95
        ? t('copilot.friendly.sunFull')
        : s.sunMinPct <= 0
          ? t('copilot.friendly.sunGone', { at: when(s.next.sunset) })
          : t('copilot.friendly.sunPart', { pct: pct(s.sunMinPct) });
    const earthLine =
      s.earthPct >= 99.95
        ? t('copilot.friendly.earthFull')
        : t(
            s.problem?.atLanding && s.problem.key === 'EARTH_BELOW_HORIZON'
              ? 'copilot.friendly.earthLanding'
              : 'copilot.friendly.earthPart',
            {
              pct: pct(s.earthPct),
            },
          );
    const slopeLine =
      s.checks.slope === 'yes'
        ? t('copilot.friendly.slopeOk')
        : s.checks.slope === 'no'
          ? t('copilot.friendly.slopeSteep')
          : t('copilot.friendly.slopeUnknown');
    const longLine = s.longTerm
      ? t('copilot.friendly.longTerm', { sun: pct(s.longTerm.sunPct), earth: pct(s.longTerm.earthPct) })
      : undefined;
    const nextStep = t(s.verdict === 'pass' ? 'copilot.friendly.nextPass' : 'copilot.friendly.nextFail');
    const friendly = [where, headline, sunLine, earthLine, slopeLine, ...(longLine ? [longLine] : []), nextStep];
    const lines: Record<Aspect, string[]> = {
      confidence: [head, ...confidence],
      verdict: [where, headline, nextStep],
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
      summary: friendly,
    };
    return lines[aspect].join('\n');
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
      pins: s.pins,
      openMission: s.missionId,
    };
  };

  /**
   * A tool runner that shows its work: each call becomes a step on the working message, its progress lines update
   * the step, and a card it returns (the sites a search found) is kept for the reply.
   */
  const stepper = (messageId: number, cards: SitesCard[], announce?: (sentence: string) => void) => {
    let stepId = 0;
    return async (call: ToolCall): Promise<ToolResult> => {
      stepId += 1;
      const id = stepId;
      const step: Step = {
        id,
        tool: call.name,
        call: `${call.name}(${Object.entries(call.arguments)
          .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
          .join(', ')})`,
        status: 'running',
      };
      const patchStep = (p: Partial<Step>) =>
        update(messageId, (m) => ({ steps: (m.steps ?? []).map((s) => (s.id === id ? { ...s, ...p } : s)) }));
      update(messageId, (m) => ({ steps: [...(m.steps ?? []), step] }));
      try {
        const out = await runAgentTool(call, { t, progress: (detail) => patchStep({ detail }), announce });
        if (out.card) cards.push(out.card);
        patchStep({ status: 'done', detail: undefined });
        return out;
      } catch (e) {
        patchStep({ status: 'failed', detail: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    };
  };

  /** Ends a working message with its reply. */
  const finish = (id: number, patch: Partial<Message>, spoken: boolean) => {
    update(id, () => ({ ...patch, working: false }));
    sound.chime();
    // After the progress lines, not over them.
    if (spoken && patch.text) speak(patch.text, i18n.language, { queue: true });
  };

  const run = async (message: string, spoken: boolean) => {
    // A plain command ("Fly to Mars", "Show me Apollo 11") needs no model: the matcher does it at once, and the free
    // daily allowance is kept for questions.
    const intent = parseIntent(message, MISSION_NAMES);
    if (intent.tool === 'fly_to' || intent.tool === 'show_mission') return runBasic(message, spoken);
    const working = add({ from: 'siteline', text: '', steps: [], working: true });
    const cards: SitesCard[] = [];
    const out = await askAi(
      message,
      appState(),
      history.current,
      stepper(working, cards, spoken ? narrate : undefined),
    );
    if (out.ok && out.unverified.length === 0) {
      history.current = out.history;
      setMode('ai');
      // A search the model didn't follow with select_site still ends on its best site, so the screen shows the answer.
      const card = cards.at(-1);
      const best = card?.sites[0];
      if (card && best && !out.calls.some((c) => c.startsWith('select_site('))) flyTo(card, best);
      return finish(working, { text: plainReply(out.text), sources: out.sources, card }, spoken);
    }
    // A reply with a number no tool gave is never shown: the matcher answers from the check itself instead, and the
    // chat the model sees stays as it was. Steps already taken stay on screen, since the view did move.
    if (out.ok) console.warn(`copilot: dropped an AI reply with numbers no tool gave: ${out.unverified.join(', ')}`);
    else setMode('basic');
    setLog((l) =>
      l.flatMap((m) =>
        m.id !== working ? [m] : m.steps?.length ? [{ ...m, working: false, card: cards.at(-1) }] : [],
      ),
    );
    return runBasic(message, spoken);
  };

  /** The matcher: one tool picked from the message's words, answered from the report's own sentences. */
  const runBasic = async (message: string, spoken: boolean) => {
    const intent = parseIntent(message, MISSION_NAMES);
    const call = callText(intent) || undefined;
    if (intent.tool === 'help') return say({ from: 'siteline', text: t('copilot.help') }, spoken);
    if (intent.tool === 'fly_to') {
      useApp.getState().set({ view: VIEW_OF[intent.input.target] });
      return say(
        { from: 'siteline', call, text: t('copilot.flying', { place: t(`copilot.places.${intent.input.target}`) }) },
        spoken,
      );
    }
    if (intent.tool === 'show_mission') {
      const m = findLander(intent.input.id);
      useApp.getState().selectMission(intent.input.id);
      return say({ from: 'siteline', call, text: t('copilot.mission', { name: m?.name ?? intent.input.id }) }, spoken);
    }
    if (intent.tool === 'find_landing_sites') {
      // The same search the agent runs, without the model: the steps, the pins and the card, with a plain sentence.
      const working = add({ from: 'siteline', text: '', steps: [], working: true });
      const cards: SitesCard[] = [];
      try {
        await stepper(
          working,
          cards,
          spoken ? narrate : undefined,
        )({
          id: 'basic',
          name: 'find_landing_sites',
          arguments: {},
        });
      } catch {
        // The failed step says why.
      }
      const card = cards.at(-1);
      const best = card?.sites[0];
      if (best) useApp.getState().focusSite(best.latDeg, best.lonDeg);
      const reply =
        card && best
          ? t('copilot.agent.basicFound', { region: best.region, date: formatUtc(card.landingUtc) })
          : t('copilot.agent.basicNone');
      return finish(working, { text: reply, card }, spoken);
    }
    // analyze_site: the same check, on the same inputs, that the site report shows.
    const { latDeg, lonDeg, landingUtc, slipDays } = useApp.getState();
    const query = queryFor({ latDeg, lonDeg }, landingUtc, slipDays);
    try {
      const s = summarize(await physics.stay(query, URLS), { latDeg, lonDeg }, query.landingUtc);
      say({ from: 'siteline', call, text: answer(intent.input.aspect, s), sources: s.sources }, spoken);
    } catch (e) {
      say(
        { from: 'siteline', call, text: t('copilot.failed', { message: e instanceof Error ? e.message : String(e) }) },
        spoken,
      );
    }
  };

  const send = async (message: string, spoken = false) => {
    const m = message.trim();
    if (!m || busy) return;
    setText('');
    // In a live call, a typed message goes to the voice agent, which answers aloud and in the chat.
    if (live.current) {
      add({ from: 'you', text: m });
      settleLive();
      live.current.send(m).catch((e) => setVoiceError(t('copilot.live.failed', { message: String(e) })));
      return;
    }
    setSpeakReplies(spoken);
    stopSpeaking();
    add({ from: 'you', text: m });
    setBusy(true);
    try {
      await run(m, spoken);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  const toggleMic = () => {
    setVoiceError(undefined);
    if (live.current) {
      const next = !muted;
      setMuted(next);
      void live.current.setMuted(next);
      return;
    }
    if (listening) {
      stopListening.current?.();
      return;
    }
    stopSpeaking();
    setListening(true);
    stopListening.current = listen(
      i18n.language,
      (partial) => setText(partial),
      (result) => {
        setListening(false);
        stopListening.current = null;
        if ('error' in result) {
          setVoiceError(t(result.error === 'not-allowed' ? 'copilot.agent.micBlocked' : 'copilot.agent.micFailed'));
          return;
        }
        if (result.text) void send(result.text, true);
      },
    );
  };

  /** A site from a search card: select it on its landing date and fly there, as the agent's own pick would. */
  const flyTo = (card: SitesCard, site: SitesCard['sites'][number]) => {
    useApp.getState().set({ landingUtc: card.landingUtc, live: false, slipDays: 0 });
    useApp.getState().focusSite(site.latDeg, site.lonDeg);
  };

  /**
   * Ends the call's current piece of work: its steps stop spinning, and a search the agent didn't follow with
   * select_site still ends on its best site, as in the chat.
   */
  const settleLive = () => {
    const work = liveWork.current;
    if (!work) return;
    liveWork.current = null;
    const card = work.cards.at(-1);
    const best = card?.sites[0];
    if (card && best && !work.tools.includes('select_site')) flyTo(card, best);
    update(work.id, () => ({ working: false, card }));
  };

  /** Ask SiteLine Live: a voice call with the LiveKit agent, whose tools run here, through the same steps as the chat. */
  const startCall = async () => {
    setVoiceError(undefined);
    stopListening.current?.();
    stopSpeaking();
    setSpeakReplies(false);
    setLiveState('connecting');
    // LiveKit's client loads with the first call, not with the app.
    const { fetchVoiceToken, startLive } = await import('../liveVoice');
    const got = await fetchVoiceToken();
    if ('error' in got) {
      setLiveState(null);
      setVoiceError(t(got.error === 'rate_limited' ? 'copilot.live.busy' : 'copilot.live.unavailable'));
      return;
    }
    try {
      live.current = await startLive(got.url, got.token, {
        transcript: ({ id, from, text }) => {
          const words = from === 'siteline' ? plainReply(text) : text.trim();
          if (!words) return;
          const key = `${from}:${id}`;
          const known = segments.current.get(key);
          if (known !== undefined) return update(known, () => ({ text: words }));
          // The visitor speaking again closes the work of the turn before.
          if (from === 'you') settleLive();
          segments.current.set(key, add({ from, text: words }));
        },
        state: (state) => {
          setLiveState(state);
          if (state === 'listening') settleLive();
        },
        tool: async (call) => {
          if (!liveWork.current) {
            const cards: SitesCard[] = [];
            const id = add({ from: 'siteline', text: '', steps: [], working: true });
            liveWork.current = {
              id,
              cards,
              tools: [],
              run: stepper(id, cards, (sentence) => void live.current?.say(sentence).catch(() => {})),
            };
          }
          const work = liveWork.current;
          work.tools.push(call.name);
          const out = await work.run(call);
          const sources = out.sources ?? [];
          if (sources.length) update(work.id, (m) => ({ sources: [...new Set([...(m.sources ?? []), ...sources])] }));
          return { data: out.data };
        },
        appState,
        ended: () => {
          settleLive();
          live.current = null;
          segments.current.clear();
          setLiveState(null);
          setMuted(false);
        },
      });
      setMode('ai');
    } catch (e) {
      live.current = null;
      setLiveState(null);
      setVoiceError(t('copilot.live.failed', { message: e instanceof Error ? e.message : String(e) }));
    }
  };

  // The orb (Orb.tsx) opens it.
  if (!open) return null;

  const running = log.some((m) => m.working);

  return (
    <section
      aria-label={t('copilot.title')}
      data-avoid
      className="fixed inset-x-3 bottom-3 z-30 flex h-[min(560px,78dvh)] flex-col gap-2 rounded-xl border border-line bg-panel p-3 shadow-2xl lg:absolute lg:inset-x-auto lg:inset-s-3 lg:bottom-14 lg:h-[min(600px,calc(100%-80px))] lg:w-110"
      data-testid="copilot"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`size-7 shrink-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,#FFE3A3,#F4B63F_55%,#8A5A0A)] ${
              busy || listening || (liveState !== null && liveState !== 'listening') ? 'animate-pulse' : ''
            }`}
          />
          <h2 className="min-w-0 text-lg">
            {t('copilot.title')}{' '}
            <span
              className={`ms-1 rounded-pill border px-2 py-0.5 align-middle font-sans text-[11px] font-normal ${
                liveState ? 'border-sun/60 text-sun-ink' : 'border-line text-quiet'
              }`}
            >
              {liveState
                ? t(`copilot.live.state.${liveState}`)
                : listening
                  ? t('copilot.agent.listening')
                  : running
                    ? t('copilot.agent.working')
                    : t(`copilot.badge.${mode}`)}
            </span>
          </h2>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            disabled={liveState === 'connecting'}
            onClick={() => (live.current ? void live.current.stop() : void startCall())}
            className={`min-h-8 rounded-md border px-2.5 text-[12.5px] disabled:opacity-60 ${
              liveState
                ? 'border-fail/60 bg-fail/10 hover:border-fail'
                : 'border-sun/60 bg-sun/15 text-sun-ink hover:border-sun'
            }`}
          >
            {liveState ? t('copilot.live.end') : t('copilot.live.start')}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="min-h-8 rounded-md border border-line bg-panel-raised px-2.5 text-[12.5px] hover:border-line-hover"
          >
            {t('copilot.close')}
          </button>
        </div>
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
                  className={`min-h-8 rounded-pill border bg-panel-raised px-3 text-[12.5px] text-ink hover:border-line-hover ${
                    k === 'example8' ? 'border-sun/60' : 'border-line'
                  }`}
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
              className="flex max-w-[94%] flex-col gap-1.5 self-start rounded-lg border border-line bg-panel-raised px-3 py-2 text-sm"
            >
              {m.call && (
                <p className="whitespace-pre-line font-mono text-[11.5px] text-quiet" dir="ltr">
                  {m.call.startsWith('↳') ? m.call : `↳ ${m.call}`}
                </p>
              )}
              {m.steps && m.steps.length > 0 && <Steps steps={m.steps} />}
              {m.working && !m.steps?.some((s) => s.status === 'running') && (
                <p className="flex items-center gap-2 text-quiet">
                  <Spinner /> {t('copilot.agent.thinking')}
                </p>
              )}
              {m.text && <p className="whitespace-pre-line">{m.text}</p>}
              {m.card && <Sites card={m.card} onFly={(s) => m.card && flyTo(m.card, s)} />}
              {m.unverified && (
                <p className="text-xs text-warn">{t('copilot.unverified', { list: m.unverified.join(', ') })}</p>
              )}
              {m.sources && m.sources.length > 0 && (
                <p className="text-xs text-quiet">
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
        {busy && !running && (
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
        {(voice || liveState) && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={busy || liveState === 'connecting'}
            aria-pressed={liveState ? !muted : listening}
            aria-label={
              liveState
                ? t(muted ? 'copilot.live.unmute' : 'copilot.live.mute')
                : listening
                  ? t('copilot.agent.micStop')
                  : t('copilot.agent.mic')
            }
            title={
              liveState
                ? t(muted ? 'copilot.live.unmute' : 'copilot.live.mute')
                : listening
                  ? t('copilot.agent.micStop')
                  : t('copilot.agent.mic')
            }
            className={`grid min-h-9 min-w-9 place-items-center rounded-md border text-sm disabled:opacity-50 ${
              (liveState && !muted) || listening
                ? 'border-sun bg-sun/25 text-sun-ink'
                : liveState && muted
                  ? 'border-fail/60 text-fail line-through'
                  : 'border-line bg-panel-raised hover:border-line-hover'
            } ${listening ? 'animate-pulse' : ''}`}
          >
            <MicIcon />
          </button>
        )}
        <input
          id="copilot-input"
          ref={input}
          value={text}
          autoComplete="off"
          placeholder={listening ? t('copilot.agent.listening') : t('copilot.placeholder')}
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
      {voiceError && <p className="text-[11.5px] text-warn">{voiceError}</p>}
      {speakReplies && canSpeak() && (
        <p className="flex items-center justify-between gap-2 text-[11.5px] text-quiet">
          <span>{t('copilot.agent.speaking')}</span>
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-ink"
            onClick={() => {
              stopSpeaking();
              setSpeakReplies(false);
            }}
          >
            {t('copilot.agent.mute')}
          </button>
        </p>
      )}
      <p className="text-[11.5px] text-quiet">
        {t(liveState ? 'copilot.live.note' : mode === 'basic' ? 'copilot.noteBasic' : 'copilot.note')}
      </p>
    </section>
  );
}

/** The agent's steps: what it ran, what it is doing now, and what failed and why. */
function Steps({ steps }: { steps: Step[] }) {
  const { t } = useTranslation();
  return (
    <ol className="flex flex-col gap-1 border-s border-line ps-2.5">
      {steps.map((s) => (
        <li key={s.id} className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-1.5 text-[12.5px]">
          <span className="pt-0.5" aria-hidden="true">
            {s.status === 'running' ? (
              <Spinner />
            ) : s.status === 'done' ? (
              <span className="text-pass">✓</span>
            ) : (
              <span className="text-fail">✕</span>
            )}
          </span>
          <span className="min-w-0">
            <span className="sr-only">{t(`copilot.agent.status.${s.status}`)} </span>
            {t(`copilot.agent.tool.${s.tool}`, { defaultValue: s.tool })}
            {s.detail && (
              <span className={`block ${s.status === 'failed' ? 'text-fail' : 'text-sun-ink'}`}>{s.detail}</span>
            )}
            <span className="block truncate font-mono text-[10.5px] text-quiet" dir="ltr" title={s.call}>
              {s.call}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The sites a search found, best first, each with its readings and a button that flies there. */
function Sites({ card, onFly }: { card: SitesCard; onFly: (site: SitesCard['sites'][number]) => void }) {
  const { t } = useTranslation();
  if (card.sites.length === 0)
    return (
      <p className="rounded-md border border-line bg-panel-sunk px-2.5 py-2 text-quiet">
        {t('copilot.agent.sitesNone', { date: formatUtc(card.landingUtc) })}
      </p>
    );
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line bg-panel-sunk p-1.5">
      <p className="px-1 text-[11.5px] text-quiet">
        {t('copilot.agent.sitesTitle', { date: formatUtc(card.landingUtc) })}
      </p>
      <ol className="flex flex-col gap-1">
        {card.sites.map((s, i) => (
          <li
            key={`${s.latDeg},${s.lonDeg}`}
            className="flex items-center gap-2 rounded px-1 py-1 hover:bg-panel-raised"
          >
            <span className="w-4 shrink-0 text-center font-mono text-xs text-quiet">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-1.5">
                <span className="text-pass">✓</span>
                <span className="font-medium">{s.region}</span>
                <bdi className="font-mono text-[11px] text-quiet">
                  {t('share.place', {
                    lat: formatNumber(Math.abs(s.latDeg), 2),
                    northSouth: s.latDeg < 0 ? t('landers.south') : t('landers.north'),
                    lon: formatNumber(Math.abs(s.lonDeg), 2),
                    eastWest: s.lonDeg < 0 ? t('landers.west') : t('landers.east'),
                  })}
                </bdi>
                {s.robotFit && (
                  <span
                    className={`rounded-pill border px-1.5 text-[10.5px] ${
                      s.robotFit === 'fits'
                        ? 'border-pass/60 text-pass'
                        : s.robotFit === 'does_not_fit'
                          ? 'border-fail/60 text-fail'
                          : 'border-warn/60 text-warn'
                    }`}
                  >
                    {t(`copilot.agent.fit.${s.robotFit}`)}
                  </span>
                )}
              </span>
              <span className="block font-mono text-[11px] text-quiet">
                {t('best.readings', {
                  sun: formatNumber(s.sunFractionMin * 100, 0),
                  earth: formatNumber(s.earthVisiblePct, 0),
                  slope: formatNumber(s.slope100mDeg, 1),
                })}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onFly(s)}
              className="min-h-8 shrink-0 rounded-md border border-line-hover bg-panel-raised px-2.5 text-xs hover:border-sun"
            >
              {t('copilot.agent.flyThere')}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}
