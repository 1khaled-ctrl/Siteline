/**
 * The voice agent's own rules, kept apart from the LiveKit worker so they can be tested. The tools and the base
 * prompt are the chat relay's (apps/copilot-worker/src/relay.ts), so voice and chat can't drift apart; this adds what
 * changes when the answer is spoken, and how tool calls travel to the visitor's browser.
 */
import { SYSTEM_PROMPT, TOOLS } from '../../copilot-worker/src/relay';

/** The RPC methods the browser registers (apps/web/src/liveVoice.ts). */
export const RPC = { tool: 'siteline.tool', state: 'siteline.state', say: 'siteline.say' } as const;

/** LiveKit Inference models, overridable from the environment. Flux decides on its own when the visitor has finished. */
export const MODELS = {
  stt: process.env.SITELINE_STT ?? 'deepgram/flux-general-en',
  llm: process.env.SITELINE_LLM ?? 'openai/gpt-4.1-mini',
  tts: process.env.SITELINE_TTS ?? 'cartesia/sonic-3',
  /** The Cartesia voice SiteLine speaks with (chosen by the team). */
  ttsVoice: process.env.SITELINE_TTS_VOICE ?? 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4',
  /** Used by LiveKit's gateway when the main voice fails, so the agent isn't left silent. */
  ttsFallback: process.env.SITELINE_TTS_FALLBACK ?? 'deepgram/aura-2',
};

const SPOKEN = `
You are speaking out loud in a live voice call, not writing.
- Answer in one to three short spoken sentences. No emoji, no lists, no markdown, no line-by-line report.
- Round what you say: whole percentages and one decimal for slopes. Name a site by its region; say coordinates only if asked.
- Before a tool that takes a while (find_landing_sites, check_site, robot_fit), first say one short line such as "Let me search the nine Artemis regions, that takes a moment."
- While find_landing_sites runs, the app speaks its progress for you (each site it finds, how far it has got). Don't repeat those lines; when the result comes, answer in one or two sentences.
- The screen shows the details, the sources and a list of sites. Say "it's on your screen" rather than reading everything out.
- If the visitor interrupts, stop and follow the new request.`;

/** The chat relay's prompt, without the Qwen-only switch at its end, and with the spoken rules. */
export const VOICE_INSTRUCTIONS = `${SYSTEM_PROMPT.replace(/\n?\/no_think\s*$/, '')}\n${SPOKEN}`;

/** The relay's tools, by name, as the worker defines them. */
export const VOICE_TOOLS = TOOLS.map((t) => t.function);

/** How long a tool may run in the browser: a search walks nine regions, so it gets minutes; the rest, seconds. */
export function timeoutFor(tool: string): number {
  if (tool === 'find_landing_sites') return 240_000;
  if (tool === 'check_site' || tool === 'robot_fit' || tool === 'analyze_site') return 60_000;
  return 15_000;
}

/** The browser's reply to a tool call, as the model should read it: the data, or an error it can act on. */
export function toolReply(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { data?: unknown; error?: unknown };
    if (parsed && typeof parsed === 'object' && 'error' in parsed)
      return JSON.stringify({ error: String(parsed.error) });
    return JSON.stringify(parsed?.data ?? null);
  } catch {
    return JSON.stringify({ error: 'the browser sent back something unreadable' });
  }
}

/** Progress lines longer than this are cut: they are meant to be a short spoken sentence. */
export const MAX_SAY_CHARS = 200;

/** What the agent says as the call opens. */
export const GREETING =
  "Hi, I'm Luna! Ask me anything about space. I can fly you to any planet, tell you how far it is, or find a safe place to land on the Moon.";

/** The app's state for one turn, as a note after the cached prompt (never inside it). */
export const appStateNote = (state: string) => `<app_state>${state}</app_state>`;
