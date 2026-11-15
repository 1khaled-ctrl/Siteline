import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MISSION_NAMES, runAgentTool, type SitesCard } from '../agentTools';
import { type Confidence, confidenceOf, type Reading, SLOPE_NEEDS_M } from '../confidence';
import {
  type Aspect,
  type Intent,
  isFactsQuestion,
  isSpaceBodyName,
  parseIntent,
  type SiteSummary,
  type SpaceBodyName,
  summarize,
  type Target,
} from '../copilot';
import { askAi, type ChatMessage, plainReply, type ToolCall, type ToolResult } from '../copilotAi';
import { formatNumber, formatUtc } from '../format';
import { findLander } from '../landers';
import { siteOnScreen } from '../landingAgent';
import type { LiveSession, LiveState } from '../liveVoice';
import { physics, queryFor, URLS } from '../physics';
import { sound } from '../sound';
import type { SpaceFacts } from '../spaceFacts';
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
  !('input' in intent)
    ? ''
    : `${intent.tool}(${Object.entries(intent.input)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ')})`;

/**
 * Luna: a chat over the 3D view that works as an agent. It can fly the view, open a mission, check any Moon
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
  /** The planet or body the conversation is about, so "is it cold there?" knows where "there" is. */
  const topic = useRef<SpaceBodyName | null>(null);
  const next = useRef(1);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stopListening = useRef<(() => void) | null>(null);
  const voice = canListen();
  /** The live voice call (LiveKit), while one is on; its state; and whether the visitor's mic is muted in it. */
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [muted, setMuted] = useState(false);
  const live = useRef<LiveSession | null>(null);
  /** Set once the server says it has no live voice, so the mic goes straight to the browser's speech from then on. */
  const noLiveVoice = useRef(false);
  const [liveUnavailable, setLiveUnavailable] = useState(false);
  /** The visitor is speaking in the live call right now (LiveKit's voice activity, ahead of the transcript). */
  const [youSpeaking, setYouSpeaking] = useState(false);
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

  /** Big distances in words a person would say: "1.3 billion km", "225 million km", "384,400 km". */
  const bigKm = (km: number) =>
    km >= 1e9
      ? t('copilot.space.billion', { n: formatNumber(km / 1e9, 2) })
      : km >= 1e6
        ? t('copilot.space.million', { n: formatNumber(km / 1e6, 0) })
        : t('copilot.space.km', { n: formatNumber(km, 0) });

  /** A friendly answer about a body, line by line, from `space_facts` and nothing else. */
  const spaceAnswer = (f: SpaceFacts): string => {
    const name = t(`bodies.${f.body}`);
    const lines = [t('copilot.space.head', { name })];
    if (f.distanceFromEarthKm !== null) lines.push(t('copilot.space.distance', { far: bigKm(f.distanceFromEarthKm) }));
    if (f.signalFromEarth)
      lines.push(
        f.signalFromEarth.seconds < 120
          ? t('copilot.space.signalS', { n: formatNumber(f.signalFromEarth.seconds, 1) })
          : t('copilot.space.signalMin', { n: formatNumber(f.signalFromEarth.minutes, 0) }),
      );
    if (f.travel?.kind === 'moon') lines.push(t('copilot.space.travelMoon', { days: f.travel.coastDays }));
    if (f.travel?.kind === 'transfer')
      lines.push(
        f.travel.idealTransferYears !== null
          ? t('copilot.space.travelYears', { n: formatNumber(f.travel.idealTransferYears, 1) })
          : t('copilot.space.travelDays', { n: formatNumber(f.travel.idealTransferDays, 0) }),
      );
    const p = f.physical;
    if (p) {
      const g = formatNumber(p.gravityMS2, 2);
      if (!p.solidSurface && p.temperatureAtLevel)
        lines.push(
          t('copilot.space.giant', {
            c: formatNumber(p.temperatureAtLevel.celsius, 0),
            bar: p.temperatureAtLevel.bar,
            g,
          }),
        );
      else if (p.meanTemperatureC !== null)
        lines.push(t('copilot.space.surface', { c: formatNumber(p.meanTemperatureC, 0), g }));
      else lines.push(t('copilot.space.gravity', { g }));
    }
    lines.push(t('copilot.space.more'));
    return lines.join('\n');
  };

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
      // Off the Moon nothing is selected, though the store keeps a default spot: Luna must not judge it.
      selectedSite: siteOnScreen(s.view) ? { latDeg: s.latDeg, lonDeg: s.lonDeg } : null,
      landingUtc: query.landingUtc,
      slipDays: s.slipDays,
      stayDays: query.stayDays,
      robot: s.robot,
      pins: s.pins,
      openMission: s.missionId,
      talkingAbout: topic.current,
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
      const about = call.arguments.body ?? call.arguments.target;
      if ((call.name === 'space_facts' || call.name === 'fly_to') && isSpaceBodyName(about)) topic.current = about;
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
    // Hello, thanks, who are you: answered at once in Luna's own words, without waiting on (or spending) the model.
    // An introduction or a tour goes to the model, which knows the site and can fly the views; the matcher's own
    // introduction is the fallback.
    if (intent.tool === 'chat' && intent.input.kind !== 'unknown' && intent.input.kind !== 'intro')
      return runBasic(message, spoken);
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
    // "Is it cold there?" names no body: it is about the one the conversation is on.
    const space =
      intent.tool === 'space'
        ? intent.input
        : intent.tool === 'chat' && intent.input.kind === 'unknown' && topic.current && isFactsQuestion(message)
          ? { body: topic.current, show: false, facts: true }
          : undefined;
    if (intent.tool === 'chat' && !space)
      return say({ from: 'siteline', text: t(`copilot.chat.${intent.input.kind}`) }, spoken);
    if (space) {
      // A planet without the model: the same tools Luna uses, and an answer built from their numbers.
      const { body, show, facts } = space;
      topic.current = body;
      const working = add({ from: 'siteline', text: '', steps: [], working: true });
      const tool = stepper(working, []);
      if (show) await tool({ id: 'show', name: 'fly_to', arguments: { target: body } }).catch(() => undefined);
      let text = t('copilot.space.shown', { name: t(`bodies.${body}`) });
      let sources: string[] | undefined;
      if (facts) {
        const out = await tool({ id: 'facts', name: 'space_facts', arguments: { body } }).catch(() => undefined);
        if (out) {
          text = spaceAnswer(out.data as SpaceFacts);
          sources = out.sources;
        }
      }
      return finish(working, { text, sources }, spoken);
    }
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
    if (intent.tool === 'land_here' || intent.tool === 'simulate_journey') {
      // The same tool Luna uses; a spot Land Here cannot reach gets the tool's own reason.
      const working = add({ from: 'siteline', text: '', steps: [], working: true });
      const ok = await stepper(
        working,
        [],
      )({ id: 'go', name: intent.tool, arguments: {} })
        .then(() => true)
        .catch(() => false);
      const reply = t(`copilot.go.${intent.tool}.${ok ? 'done' : 'failed'}`);
      return finish(working, { text: reply }, spoken);
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
    if (intent.tool !== 'analyze_site') return;
    // analyze_site: the same check, on the same inputs, that the site report shows.
    const { latDeg, lonDeg, landingUtc, slipDays, view } = useApp.getState();
    if (!siteOnScreen(view)) {
      say({ from: 'siteline', text: t('copilot.noSiteYet') }, spoken);
      return;
    }
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
    if (liveState === 'connecting') return;
    // The mic means talking to SiteLine: the live call and its own voice, wherever the server offers one. The
    // browser's speech is only the fallback, for a server without live voice set up.
    if (!noLiveVoice.current) {
      void startCall().then((started) => {
        if (!started && noLiveVoice.current && voice) listenInBrowser();
      });
      return;
    }
    listenInBrowser();
  };

  /** One question heard by the browser's own speech recognition, answered in the chat and read aloud. */
  const listenInBrowser = () => {
    setVoiceError(undefined);
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

  /** Luna Live: a voice call with the LiveKit agent, whose tools run here, through the same steps as the chat. */
  const startCall = async (): Promise<boolean> => {
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
      if (got.error === 'no_voice') {
        noLiveVoice.current = true;
        setLiveUnavailable(true);
      }
      setVoiceError(t(got.error === 'rate_limited' ? 'copilot.live.busy' : 'copilot.live.unavailable'));
      return false;
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
        speaking: setYouSpeaking,
        ended: () => {
          setYouSpeaking(false);
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
      return false;
    }
    return true;
  };

  // The orb (Orb.tsx) opens it.
  if (!open) return null;

  const running = log.some((m) => m.working);
  // One word for where Luna is: in a call, listening through the browser, working, or ready.
  const status: { key: string; tone: 'live' | 'busy' | 'ok' | 'quiet' } = liveState
    ? { key: `copilot.live.state.${liveState}`, tone: 'live' }
    : listening
      ? { key: 'copilot.agent.listening', tone: 'live' }
      : running || busy
        ? { key: 'copilot.agent.working', tone: 'busy' }
        : mode === 'ai'
          ? { key: 'copilot.status.online', tone: 'ok' }
          : mode === 'basic'
            ? { key: 'copilot.status.basic', tone: 'quiet' }
            : { key: 'copilot.status.ready', tone: 'ok' };
  const dot = { live: 'bg-sun', busy: 'bg-sun animate-pulse', ok: 'bg-pass', quiet: 'bg-quiet' }[status.tone];
  // The browser's own speech is only a fallback: its mic shows where live voice is not set up.
  const browserMic = voice && liveUnavailable && !liveState;
  const last = log.at(-1);

  return (
    <section
      aria-label={t('copilot.title')}
      data-avoid
      className="fixed inset-x-0 bottom-0 z-[60] flex h-[88dvh] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-line bg-panel shadow-[0_-12px_40px_rgba(0,0,0,0.55)] lg:absolute lg:inset-x-auto lg:inset-s-3 lg:bottom-24 lg:z-30 lg:h-[min(640px,calc(100%-112px))] lg:w-110 lg:rounded-2xl lg:border-b lg:shadow-2xl"
      data-testid="copilot"
    >
      <span aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line lg:hidden" />
      <header className="flex items-center gap-3 border-b border-line bg-linear-to-b from-sun/10 to-transparent px-4 py-3">
        <span
          aria-hidden="true"
          className={`size-9 shrink-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,#FFE3A3,#F4B63F_55%,#8A5A0A)] shadow-[0_0_16px_rgba(244,182,63,0.45)] ${
            busy || listening || (liveState !== null && liveState !== 'listening') ? 'animate-pulse' : ''
          }`}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-tight">
            {t('copilot.title')}
            <span className="ms-2 align-middle font-sans text-xs font-normal text-quiet">{t('copilot.subtitle')}</span>
          </h2>
          <p className="flex items-center gap-1.5 text-xs text-quiet" aria-live="polite">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${dot}`} />
            {t(status.key)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t('copilot.close')}
          title={t('copilot.close')}
          className="grid size-9 shrink-0 place-items-center rounded-full text-quiet hover:bg-panel-raised hover:text-ink"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
        {!liveUnavailable &&
          (liveState ? (
            <div
              className="flex items-center gap-3 rounded-xl border border-sun/60 bg-sun/10 px-3 py-2.5"
              data-testid="live-banner"
            >
              <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-sun text-panel">
                <MicIcon />
                {liveState !== 'connecting' && !muted && (
                  <span className="absolute inset-0 animate-ping rounded-full bg-sun/30 motion-reduce:hidden" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{t(`copilot.live.state.${liveState}`)}</span>
                <span className="block text-xs text-quiet">
                  {muted ? t('copilot.live.mutedHint') : t('copilot.live.onHint')}
                </span>
              </span>
              <button
                type="button"
                disabled={liveState === 'connecting'}
                onClick={toggleMic}
                aria-pressed={muted}
                title={muted ? t('copilot.live.unmuteTip') : t('copilot.live.muteTip')}
                className={`min-h-9 shrink-0 rounded-full border px-3 text-xs font-medium whitespace-nowrap disabled:opacity-60 ${
                  muted ? 'border-sun bg-sun text-panel' : 'border-line-hover bg-panel-raised hover:border-sun'
                }`}
              >
                {muted ? t('copilot.live.unmuteShort') : t('copilot.live.muteShort')}
              </button>
              <button
                type="button"
                disabled={liveState === 'connecting'}
                onClick={() => void live.current?.stop()}
                className="min-h-9 shrink-0 rounded-full border border-fail/60 bg-fail/10 px-3 text-xs font-medium hover:border-fail disabled:opacity-60"
              >
                {t('copilot.live.end')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void startCall()}
              className="group flex w-full items-center gap-3 rounded-xl border border-sun/70 bg-linear-to-r from-sun/25 to-sun/5 px-3 py-2.5 text-start transition hover:border-sun hover:from-sun/35 focus-visible:outline-2 focus-visible:outline-sun"
              data-testid="live-banner"
            >
              <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-sun text-panel shadow-[0_0_18px_rgba(244,182,63,0.55)]">
                <MicIcon />
                <span className="absolute inset-0 animate-ping rounded-full bg-sun/40 [animation-duration:2.2s] motion-reduce:hidden" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">{t('copilot.live.ctaTitle')}</span>
                <span className="hidden text-xs text-quiet sm:block">{t('copilot.live.ctaText')}</span>
                <span className="block text-xs text-quiet sm:hidden">{t('copilot.live.ctaTextShort')}</span>
              </span>
              <span className="shrink-0 rounded-full bg-sun px-3 py-1.5 text-xs font-semibold text-panel group-hover:brightness-110">
                {t('copilot.live.start')}
              </span>
            </button>
          ))}

        <div className="-me-2 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-2 pb-1" aria-live="polite">
          {log.length === 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2.5">
                <Avatar />
                <div className="rounded-2xl rounded-ss-sm border border-line bg-panel-raised px-3 py-2 text-sm">
                  <p className="font-medium">{t('copilot.welcome')}</p>
                  <p className="mt-1 text-quiet">{t('copilot.intro')}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 ps-10">
                {EXAMPLES.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => void send(t(`copilot.${k}`))}
                    className={`min-h-8 rounded-full border px-3 text-[12.5px] text-ink transition hover:border-sun hover:bg-sun/10 ${
                      k === 'example8' ? 'border-sun/60 bg-sun/10' : 'border-line bg-panel-raised'
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
              <p
                key={m.id}
                className="max-w-[85%] self-end rounded-2xl rounded-se-sm bg-accent/20 px-3 py-2 text-sm text-ink"
              >
                {m.text}
              </p>
            ) : (
              <div key={m.id} className="flex max-w-[96%] gap-2.5 self-start">
                <Avatar />
                <div className="flex min-w-0 flex-col gap-2 rounded-2xl rounded-ss-sm border border-line bg-panel-raised px-3 py-2 text-sm">
                  {m.call && (
                    <p className="whitespace-pre-line font-mono text-[11px] text-quiet" dir="ltr">
                      {m.call.startsWith('↳') ? m.call : `↳ ${m.call}`}
                    </p>
                  )}
                  {m.steps && m.steps.length > 0 && <Steps steps={m.steps} />}
                  {m.working && !m.steps?.some((s) => s.status === 'running') && (
                    <Typing label={t('copilot.agent.thinking')} />
                  )}
                  {m.text && <p className="whitespace-pre-line leading-relaxed">{m.text}</p>}
                  {m.card && <Sites card={m.card} onFly={(s) => m.card && flyTo(m.card, s)} />}
                  {m.unverified && (
                    <p className="text-xs text-warn">{t('copilot.unverified', { list: m.unverified.join(', ') })}</p>
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <p className="flex flex-wrap items-center gap-1 text-[11px] text-quiet">
                      <span>{t('report.sources')}:</span>
                      {m.sources.map((id) => (
                        <button
                          key={id}
                          type="button"
                          className="rounded-full border border-line px-1.5 py-px hover:border-line-hover hover:text-ink"
                          onClick={() => useApp.getState().setSources(id)}
                        >
                          {id}
                        </button>
                      ))}
                    </p>
                  )}
                </div>
              </div>
            ),
          )}
          {/* The visitor's voice is heard: shown at once, before speech-to-text sends the words. */}
          {youSpeaking && last?.from !== 'you' && (
            <p
              className="flex items-center gap-2 self-end rounded-2xl rounded-se-sm bg-accent/20 px-3 py-2 text-sm text-quiet"
              data-testid="you-speaking"
            >
              <VoiceBars /> {t('copilot.live.hearing')}
            </p>
          )}
          {busy && !running && (
            <div className="flex gap-2.5 self-start">
              <Avatar />
              <Typing label={t('copilot.thinking')} />
            </div>
          )}
          <div ref={end} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <form onSubmit={submit} className="flex items-center gap-2">
          <label htmlFor="copilot-input" className="sr-only">
            {t('copilot.inputLabel')}
          </label>
          {browserMic && (
            <button
              type="button"
              onClick={toggleMic}
              disabled={busy}
              aria-pressed={listening}
              aria-label={listening ? t('copilot.agent.micStop') : t('copilot.agent.mic')}
              title={listening ? t('copilot.agent.micStop') : t('copilot.agent.mic')}
              className={`grid size-10 shrink-0 place-items-center rounded-full border disabled:opacity-50 ${
                listening
                  ? 'animate-pulse border-sun bg-sun/25 text-sun-ink'
                  : 'border-line bg-panel-raised hover:border-line-hover'
              }`}
            >
              <MicIcon />
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-center rounded-full border border-line bg-panel-sunk ps-4 pe-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
            <input
              id="copilot-input"
              ref={input}
              value={text}
              autoComplete="off"
              placeholder={
                listening
                  ? t('copilot.agent.listening')
                  : liveState
                    ? t('copilot.live.typePlaceholder')
                    : t('copilot.placeholder')
              }
              onChange={(e) => setText(e.currentTarget.value)}
              className="luna-input min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-quiet"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              aria-label={t('copilot.send')}
              title={t('copilot.send')}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-sun text-panel transition hover:brightness-110 disabled:bg-panel-raised disabled:text-quiet"
            >
              <SendIcon />
            </button>
          </div>
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
        <details className="text-[11px] text-quiet">
          <summary className="cursor-pointer select-none hover:text-ink">{t('copilot.how')}</summary>
          <p className="mt-1">
            {t(liveState ? 'copilot.live.note' : mode === 'basic' ? 'copilot.noteBasic' : 'copilot.note')}
          </p>
        </details>
      </div>
    </section>
  );
}

/** Luna's face beside her messages: the same golden orb as the header. */
function Avatar() {
  return (
    <span
      aria-hidden="true"
      className="mt-0.5 size-7 shrink-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,#FFE3A3,#F4B63F_55%,#8A5A0A)]"
    />
  );
}

/** Three dots that say Luna is on it. */
function Typing({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 text-sm text-quiet">
      <span aria-hidden="true" className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 animate-bounce rounded-full bg-sun/80 motion-reduce:animate-none"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

/** A small level meter for a voice being heard. */
function VoiceBars() {
  return (
    <span aria-hidden="true" className="flex h-3.5 items-end gap-0.5">
      {[0.6, 1, 0.75, 0.9].map((h, i) => (
        <span
          key={h}
          className="w-0.5 animate-pulse rounded-full bg-sun motion-reduce:animate-none"
          style={{ height: `${h * 100}%`, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
