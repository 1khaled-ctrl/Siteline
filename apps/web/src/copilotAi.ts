/**
 * The AI half of the copilot, in the browser. The relay (/api/copilot, apps/copilot-worker/src/relay.ts) passes the
 * chat to a free Workers AI model; the tools it asks for run here, with the same functions the screen uses, and their
 * results go back to it. When the relay is not there (a plain Vite server), busy, or out of its free daily allowance,
 * `askAi` says so and the copilot answers with its own matcher instead.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** What a tool hands back: the data the model reads, the line shown under the reply, and the datasets it cites. */
export interface ToolResult {
  data: unknown;
  call: string;
  sources?: string[];
}

export type AiOutcome =
  | { ok: true; text: string; calls: string[]; sources: string[]; unverified: string[]; history: ChatMessage[] }
  | { ok: false; reason: string };

export type Relay = (messages: ChatMessage[]) => Promise<{ text: string; toolCalls: ToolCall[] } | { error: string }>;

/** Rounds of tools per question before the model must answer: enough to search, retry on another date, and select. */
const MAX_ROUNDS = 6;
/** The relay takes 48 messages and an agent turn can add a dozen; a longer chat starts over rather than trimming. */
const MAX_HISTORY = 20;

/** The relay at /api/copilot. */
export const fetchRelay: Relay = async (messages) => {
  const res = await fetch('/api/copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  // A Vite server with no relay answers 404 with its own page.
  if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) return { error: `http_${res.status}` };
  return res.json();
};

/** Every number in a text, as written: "55.9", "2,054", "2028". */
export const numbersIn = (text: string): string[] => text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];

/**
 * The numbers in a reply that no tool result, app state or question of this turn holds. A number counts as found if
 * some source number rounds to it at the precision it is written with, so "56%" is found in 55.9 but "57%" is not.
 */
export function unverifiedNumbers(reply: string, sources: string[]): string[] {
  const known = sources.flatMap(numbersIn).map((n) => Number(n.replace(/,/g, '')));
  const out: string[] = [];
  // A number may carry a scale word: "789 million km" is found in 789000000, at the precision of a million.
  for (const m of reply.matchAll(/(\d[\d,]*(?:\.\d+)?)(\s*(thousand|million|billion|trillion)\b)?/gi)) {
    const written = m[1];
    const scale = SCALE[(m[3] ?? '').toLowerCase()] ?? 1;
    const n = Number(written.replace(/,/g, '')) * scale;
    const decimals = written.split('.')[1]?.length ?? 0;
    const step = 10 ** -decimals * scale;
    if (!known.some((k) => Math.abs(k - n) < step / 2 + 1e-9 || k === n)) out.push(written);
  }
  return out;
}

const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };

/**
 * A reply as plain text. The model is told to write no markdown but sometimes does; the chat shows text as written, so
 * bold, headings and bullet markers would show as stray symbols.
 */
export const plainReply = (text: string): string =>
  text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();

/**
 * One question, through as many rounds of tools as the model needs (up to six). `history` is the chat so far; the
 * question goes in with the app's state ahead of it. Tools that throw go back to the model as errors.
 */
export async function askAi(
  question: string,
  appState: unknown,
  history: ChatMessage[],
  runTool: (call: ToolCall) => Promise<ToolResult>,
  relay: Relay = fetchRelay,
): Promise<AiOutcome> {
  const state = JSON.stringify(appState);
  const start: ChatMessage = { role: 'user', content: `<app_state>${state}</app_state>\n${question}` };
  let messages: ChatMessage[] = [...(history.length > MAX_HISTORY ? [] : history), start];
  const calls: string[] = [];
  const sources = new Set<string>();
  // Numbers a tool gave earlier in the chat count too: "is it cold there?" may answer from the last turn's facts.
  const seen: string[] = [state, question, ...history.filter((m) => m.role === 'tool').map((m) => m.content)];
  let corrected = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let reply: Awaited<ReturnType<Relay>>;
    try {
      reply = await relay(messages);
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if ('error' in reply) return { ok: false, reason: reply.error };
    if (reply.toolCalls.length === 0) {
      if (!reply.text) return { ok: false, reason: 'empty' };
      messages = [...messages, { role: 'assistant', content: reply.text }];
      const invented = unverifiedNumbers(reply.text, seen);
      // A number no tool gave goes back to the model once, named, so it can look it up instead of the turn being lost.
      if (invented.length && !corrected && round < MAX_ROUNDS - 1) {
        corrected = true;
        messages = [
          ...messages,
          {
            role: 'user',
            content: `[check] These numbers in your reply came from no tool: ${invented.join(', ')}. Call the tool that has them (space_facts for a planet or the Moon, analyze_site or check_site for a site) and answer again quoting only its numbers, or answer without numbers. Don't mention this check.`,
          },
        ];
        continue;
      }
      return {
        ok: true,
        text: reply.text,
        calls,
        sources: [...sources],
        unverified: invented,
        history: messages,
      };
    }
    const results: ChatMessage[] = [];
    for (const call of reply.toolCalls) {
      let content: string;
      try {
        const r = await runTool(call);
        calls.push(r.call);
        for (const s of r.sources ?? []) sources.add(s);
        content = JSON.stringify(r.data);
      } catch (e) {
        content = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      seen.push(content);
      results.push({ role: 'tool', tool_call_id: call.id, content });
    }
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: reply.text,
        tool_calls: reply.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      },
      ...results,
    ];
  }
  return { ok: false, reason: 'too_many_rounds' };
}
