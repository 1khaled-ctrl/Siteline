/**
 * The copilot's relay: it passes the chat to a free Workers AI model and hands back either words or the tools the
 * model asks for. The tools themselves run in the browser with the same functions the screen uses, so the model can
 * only repeat numbers SiteLine worked out. This file holds no key: Workers AI is reached through the Pages project's
 * `AI` binding, and on Cloudflare's free plan, usage past the daily free allocation fails instead of being billed.
 */

/** Qwen3 30B A3B: function calling, 32k context, and among the cheapest per token on Workers AI's free allocation. */
export const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MAX_TOKENS = 600;
const MAX_MESSAGES = 24;
const MAX_BODY_BYTES = 48_000;
/** Per visitor, per isolate: a guard against one page draining the shared daily allocation, not a hard quota. */
const RATE_LIMIT = { requests: 15, windowMs: 60_000 };

export interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}
export interface Env {
  AI?: Ai;
}

export const SYSTEM_PROMPT = `You are Ask SiteLine, the assistant inside SiteLine, a 3D web app for choosing lunar landing sites near the Moon's south pole (NASA Space Apps 2026).

Rules:
- Every number, date and verdict you state must come from a tool result or the app_state in this conversation. Never estimate, recall or invent one. If no tool gives it, say SiteLine doesn't have it.
- For anything about the selected site (pass or fail, Sun, Earth, slope, height, long-term light, events, confidence), call analyze_site first.
- For whether a lander or robot suits the site, call robot_fit.
- To move the view, call fly_to; to open a mission's card, call show_mission.
- Unknown is not a pass: if a check is unknown, say what is missing.
- SiteLine is a screening aid, not mission certification. Earth in view is not a radio link, and Sun in view is not power.
- Reply in plain text, two to four short sentences, in the language the user writes in. No markdown tables.
/no_think`;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

/** Fixed order and wording, so the request stays the same from turn to turn. */
export const TOOLS = [
  fn(
    'fly_to',
    'Move the 3D view to a place.',
    { target: { type: 'string', enum: ['solar', 'earth', 'mars', 'moon', 'pole'] } },
    ['target'],
  ),
  fn(
    'show_mission',
    "Open a lander's or mission's card by its name, such as 'Apollo 11', 'Chandrayaan-3' or 'IM-2'.",
    { name: { type: 'string' } },
    ['name'],
  ),
  fn(
    'analyze_site',
    "The selected Moon site's check for the landing date: verdict, the four checks, Sun and Earth visibility over the stay, slope, ground height, long-term light, next events, confidence and sources.",
    {},
    [],
  ),
  fn(
    'robot_fit',
    "Whether the selected site suits a robot, from that robot's published needs: landing circle slope, light at landing, longest darkness, Earth in view, and ground. Robots: rlldpTripod (NASA RLLDP tripod lander concept), rlldpPallet (NASA RLLDP pallet lander with rover), im2 (IM-2 Athena's site criteria), artemis4 (Artemis IV crew).",
    {
      robot: { type: 'string', enum: ['rlldpTripod', 'rlldpPallet', 'im2', 'artemis4'] },
      landingRadiusM: { type: 'number', enum: [50, 100] },
    },
    ['robot'],
  ),
];
export const TOOL_NAMES = TOOLS.map((t) => t.function.name);

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

export type RelayReply = { text: string; toolCalls: ToolCall[] };

/** The chat the browser sends, checked: roles, sizes and shapes. Throws a short reason when it is not one. */
export function readChat(body: unknown): ChatMessage[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { messages?: unknown }).messages))
    throw new Error('messages missing');
  const messages = (body as { messages: unknown[] }).messages;
  if (messages.length === 0 || messages.length > MAX_MESSAGES) throw new Error('too many or too few messages');
  return messages.map((m) => {
    if (!m || typeof m !== 'object') throw new Error('bad message');
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (typeof content !== 'string') throw new Error('bad content');
    if (role === 'user') return { role, content };
    if (role === 'tool') {
      const id = (m as { tool_call_id?: unknown }).tool_call_id;
      if (typeof id !== 'string') throw new Error('bad tool message');
      return { role, tool_call_id: id, content };
    }
    if (role === 'assistant') {
      const calls = (m as { tool_calls?: unknown }).tool_calls;
      if (calls === undefined) return { role, content };
      if (!Array.isArray(calls)) throw new Error('bad tool calls');
      return {
        role,
        content,
        tool_calls: calls.map((c) => {
          const f = (c as { function?: { name?: unknown; arguments?: unknown } }).function;
          const id = (c as { id?: unknown }).id;
          if (typeof id !== 'string' || typeof f?.name !== 'string' || typeof f.arguments !== 'string')
            throw new Error('bad tool call');
          return { id, type: 'function' as const, function: { name: f.name, arguments: f.arguments } };
        }),
      };
    }
    throw new Error('bad role');
  });
}

const parseArgs = (a: unknown): Record<string, unknown> => {
  if (a && typeof a === 'object') return a as Record<string, unknown>;
  if (typeof a === 'string') {
    try {
      const v = JSON.parse(a || '{}');
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return {};
};

/** Qwen3 may think out loud before answering; only the answer is passed on. */
const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '');

/**
 * The model's reply in one shape, whichever Workers AI returns: the older `{response, tool_calls}` (arguments as an
 * object) or the OpenAI-style `{choices: [{message}]}` (arguments as a JSON string). A tool call the model wrote out as
 * text inside `<tool_call>` tags is read too. Tools that do not exist are dropped.
 */
export function readModelReply(raw: unknown): RelayReply {
  const r = (raw ?? {}) as {
    response?: unknown;
    tool_calls?: unknown;
    choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
  };
  const message = r.choices?.[0]?.message;
  let text = typeof message?.content === 'string' ? message.content : typeof r.response === 'string' ? r.response : '';
  const rawCalls = (
    Array.isArray(message?.tool_calls) ? message.tool_calls : Array.isArray(r.tool_calls) ? r.tool_calls : []
  ) as {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  }[];
  const calls: ToolCall[] = rawCalls.map((c, i) => ({
    id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`,
    name: String(c.function?.name ?? c.name ?? ''),
    arguments: parseArgs(c.function?.arguments ?? c.arguments),
  }));
  text = stripThinking(text);
  if (calls.length === 0) {
    for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
      const v = parseArgs(m[1]) as { name?: unknown; arguments?: unknown };
      calls.push({ id: `call_${calls.length}`, name: String(v.name ?? ''), arguments: parseArgs(v.arguments) });
    }
    text = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  }
  return { text: text.trim(), toolCalls: calls.filter((c) => TOOL_NAMES.includes(c.name)) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/** Same-site requests only: the page's own origin, or a local dev server. */
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  const own = new URL(request.url).origin;
  if (origin === own) return true;
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

const seen = new Map<string, number[]>();
/** True when this visitor is under the limit; counts the request. */
export function underLimit(visitor: string, nowMs: number): boolean {
  const recent = (seen.get(visitor) ?? []).filter((t) => nowMs - t < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.requests) {
    seen.set(visitor, recent);
    return false;
  }
  recent.push(nowMs);
  seen.set(visitor, recent);
  if (seen.size > 5000) seen.clear();
  return true;
}

/**
 * One relay step. Errors come back with a short `error` code the browser uses to fall back to its own matcher:
 * `no_ai` (no binding, as on a plain Vite server), `rate_limited`, `quota` (the free allocation is used up for the day),
 * `bad_request` and `model_failed`.
 */
export async function relay(request: Request, env: Env, nowMs = Date.now()): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!allowedOrigin(request)) return json({ error: 'origin' }, 403);
  if (!env.AI) return json({ error: 'no_ai' }, 503);
  const visitor = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (!underLimit(visitor, nowMs)) return json({ error: 'rate_limited' }, 429);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ error: 'bad_request' }, 413);
  let messages: ChatMessage[];
  try {
    messages = readChat(JSON.parse(body));
  } catch (e) {
    return json({ error: 'bad_request', detail: e instanceof Error ? e.message : '' }, 400);
  }
  try {
    const raw = await env.AI.run(MODEL, {
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      tools: TOOLS,
      max_tokens: MAX_TOKENS,
      temperature: 0.2,
    });
    return json(readModelReply(raw));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Workers AI answers with a daily-limit error once the free allocation is spent.
    const quota = /neuron|daily|limit|quota|4006|capacity/i.test(message);
    return json({ error: quota ? 'quota' : 'model_failed' }, quota ? 429 : 502);
  }
}
