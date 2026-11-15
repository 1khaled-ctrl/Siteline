/**
 * The copilot's relay: it passes the chat to a free Workers AI model and hands back either words or the tools the
 * model asks for. The tools themselves run in the browser with the same functions the screen uses, so the model can
 * only repeat numbers SiteLine worked out. This file holds no key: Workers AI is reached through the Pages project's
 * `AI` binding, and on Cloudflare's free plan, usage past the daily free allocation fails instead of being billed.
 */

/** Qwen3 30B A3B: function calling, 32k context, and among the cheapest per token on Workers AI's free allocation. */
export const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const MAX_TOKENS = 700;
/** An agent turn adds a call and its results each round, so a chat runs longer than plain questions. */
const MAX_MESSAGES = 48;
const MAX_BODY_BYTES = 96_000;
/** Per visitor, per isolate: a guard against one page draining the shared daily allocation, not a hard quota. */
const RATE_LIMIT = { requests: 15, windowMs: 60_000 };

export interface Ai {
  run(model: string, input: unknown): Promise<unknown>;
}
export interface Env {
  AI?: Ai;
}

export const SYSTEM_PROMPT = `You are Luna, the assistant inside SiteLine. Your name is Luna; the Soviet Luna missions among the landers are a different thing. SiteLine is a 3D web app for NASA Space Apps 2026. SiteLine shows the solar system, Earth, Mars, the whole Moon and the Moon's south pole, with 46 real landers and missions on the Moon and Mars (Apollo, Luna, Chang'e, Chandrayaan, Surveyor, IM-2, Curiosity, Perseverance and more). Its main job is checking landing sites near the Moon's south pole.

You know nothing about the selected site until you call a tool. Any question about the site (does it pass, Sun, sunset or sunrise times, Earth, slope, height, long-term light, ice, confidence) needs analyze_site first, every time. Never answer such a question from memory.

Robots for robot_fit: a rover, or a lander that carries a rover -> rlldpPallet. A small fixed lander or the NASA tripod -> rlldpTripod. A hopper, or IM-2 -> im2. Astronauts, crew or Artemis -> artemis4. Leave landingRadiusM out unless the user names 50 or 100 m.

Finding a landing site (you are an agent here: plan, use tools, then decide):
- When the user wants a place to land ("where should I land", "find a site", "best spot for a rover in March 2028"), call find_landing_sites. Pass landingUtc as ISO 8601 UTC (for a month with no day, use the 1st at 00:00Z); leave it out to use the date on screen. Pass robot when they name a craft, and regions only when they name one.
- Ask a question instead only when the request can't be searched at all. Never ask more than one question in a row.
- If nothing passes, search once more on a date about 7 days later and say which date you used. At most two searches per request.
- When you have results, call select_site on the rank 1 site with the same landingUtc, so the screen shows it. Then answer: which site, which region, why it won (Sun, Earth, slope, robot), and one alternative.
- check_site checks any spot without moving the view. pin_sites puts up to four sites side by side. set_date changes the landing date or the launch slip. show_layer shows the long-term sunlight (sun), Earth (earth) or never-lit (shadow) map.

General questions (planets, distances, travel and logistics, the Sun, space missions):
- Always answer; never say a question is outside SiteLine. Use plain words for what you know generally.
- For any number about a body (how far, how long a signal takes, how long to get there, gravity, temperature), call space_facts first and quote only its numbers. If it doesn't have the number, say so and explain in words.
- When the visitor asks about a body or asks to see it, also call fly_to with that body so the screen shows it. Visiting a planet is fine; landing checks only exist for the Moon's south pole.

Rules:
- Every number, date and time you write must appear in a tool result or the app_state of this conversation. If no tool gives it, say SiteLine doesn't have it. Never estimate or recall one.
- Unknown is not a pass: if a check is unknown, say what is missing.
- Write a place as the region name, then latitude and longitude with N/S and E/W and no minus sign, rounded to 2 decimals: "Nobile Rim 1 (85.24° S, 37.18° E)".
- SiteLine is a screening aid, not mission certification. Earth in view means direct radio contact is geometrically possible, not a working link; Sun up means light for solar power, not enough power.
- Write for a curious non-expert, in the language the user writes in. For a site or robot question: one plain sentence with the answer first and why in everyday words, then at most four short lines that each start with one emoji (☀️ Sun, 🌍 Earth, ⛰️ ground, 🤖 robot, 📅 long term), then one short suggestion of what to try next. For anything else, answer in one or two plain sentences. Plain text with line breaks, no markdown, no tables.
/no_think`;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

/** Fixed order and wording, so the request stays the same from turn to turn. */
export const TOOLS = [
  fn(
    'fly_to',
    'Move the 3D view to a place. earth, mars, moon and pole open their own views; solar shows the whole solar system; sun, mercury, venus, jupiter, saturn, uranus and neptune fly to that body in the solar system view, show its card and pull back.',
    {
      target: {
        type: 'string',
        enum: [
          'solar',
          'earth',
          'mars',
          'moon',
          'pole',
          'sun',
          'mercury',
          'venus',
          'jupiter',
          'saturn',
          'uranus',
          'neptune',
        ],
      },
    },
    ['target'],
  ),
  fn(
    'space_facts',
    "Numbers about the Sun, a planet or the Moon on the date on screen: distance from Earth and from the Sun, one-way signal delay, travel time (Apollo's coast for the Moon, an ideal minimum-energy transfer for planets) and how often launch windows come round; for the Moon, Earth and Mars also radius, gravity, escape speed, day length, temperature and air pressure.",
    {
      body: {
        type: 'string',
        enum: ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'],
      },
    },
    ['body'],
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
    'find_landing_sites',
    "Search NASA's nine Artemis regions for landing sites that pass all four checks on a landing date, best first. Moves the view to the pole and pins what it finds. Takes a while: say you are searching.",
    {
      landingUtc: {
        type: 'string',
        description: 'ISO 8601 UTC, such as 2028-03-01T00:00:00Z. Leave out for the date on screen.',
      },
      robot: { type: 'string', enum: ['rlldpTripod', 'rlldpPallet', 'im2', 'artemis4'] },
      regions: { type: 'array', items: { type: 'string' }, description: 'Region names, only if the user names some.' },
      landingRadiusM: { type: 'number', enum: [50, 100] },
    },
    [],
  ),
  fn(
    'check_site',
    'The full check of any Moon site on any date, without moving the view.',
    {
      latDeg: { type: 'number' },
      lonDeg: { type: 'number' },
      landingUtc: { type: 'string', description: 'ISO 8601 UTC. Leave out for the date on screen.' },
      robot: { type: 'string', enum: ['rlldpTripod', 'rlldpPallet', 'im2', 'artemis4'] },
    },
    ['latDeg', 'lonDeg'],
  ),
  fn(
    'select_site',
    'Fly to a Moon site and open its report, optionally setting the landing date. Use it to show the user your pick.',
    { latDeg: { type: 'number' }, lonDeg: { type: 'number' }, landingUtc: { type: 'string' } },
    ['latDeg', 'lonDeg'],
  ),
  fn(
    'set_date',
    'Change the landing date and/or the launch slip in days; every check on screen re-runs.',
    { landingUtc: { type: 'string' }, slipDays: { type: 'number' } },
    [],
  ),
  fn(
    'pin_sites',
    'Pin up to four Moon sites to compare them side by side.',
    {
      sites: {
        type: 'array',
        items: {
          type: 'object',
          properties: { latDeg: { type: 'number' }, lonDeg: { type: 'number' } },
          required: ['latDeg', 'lonDeg'],
        },
      },
    },
    ['sites'],
  ),
  fn(
    'show_layer',
    'Show a map layer on the south pole: the long-term sunlight (sun), Earth in view (earth), never-lit ground (shadow), or none.',
    { layer: { type: 'string', enum: ['none', 'sun', 'earth', 'shadow'] } },
    ['layer'],
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
