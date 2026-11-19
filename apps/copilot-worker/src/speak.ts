/**
 * Luna's voice (POST /api/speak): a reply's text in, MP3 audio out, so "Talk live" speaks in her own voice without a
 * paid voice platform. First choice is Cartesia, with the voice the LiveKit agent used (apps/voice-agent/src/voice.ts)
 * and an API key set as a secret on the Pages project (`CARTESIA_API_KEY`). Without the key, or when Cartesia refuses
 * (its free plan has a monthly character allowance), Deepgram's Aura 2 voice "luna" on Workers AI speaks instead,
 * through the same `AI` binding as the chat, inside its free daily allocation. When neither answers, the browser reads
 * the reply with its own voice.
 *
 * Neither the key nor the visitor's text is ever logged.
 */
import { allowedOrigin } from './relay';

export interface SpeakEnv {
  CARTESIA_API_KEY?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
}

/** The Cartesia voice SiteLine speaks with, as in the LiveKit agent. */
export const LUNA_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
/** Cartesia's bytes endpoint, from its API reference (docs.cartesia.ai, "TTS bytes"), checked 20 Nov 2026. */
export const CARTESIA = { url: 'https://api.cartesia.ai/tts/bytes', version: '2026-08-14', model: 'sonic-3.6' };
/** Workers AI's Aura 2 (English), whose default speaker is "luna". */
export const AURA = { model: '@cf/deepgram/aura-2-en', speaker: 'luna' };
/** A spoken reply is one to three sentences; more than this is cut, so one request can't spend the month's voice. */
export const MAX_SPEAK_CHARS = 600;
/** Bigger bodies are refused before they are read as JSON. */
const MAX_BODY_BYTES = 4_000;
/** A talk of ten questions, each with an answer and a few progress lines, fits; a script asking for more is refused. */
const SPEAK_LIMIT = { requests: 60, windowMs: 10 * 60_000 };

/**
 * What a reply sounds like read aloud: no emoji, arrows or markup, and one pause per line. The same rules as
 * `speakable` in apps/web/src/voice.ts (a test checks they agree).
 */
export function speakableText(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/[↳•·]/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

const asked = new Map<string, number[]>();
/** True when this visitor may have another line spoken; counts the request. */
export function speakAllowed(visitor: string, nowMs: number): boolean {
  const recent = (asked.get(visitor) ?? []).filter((t) => nowMs - t < SPEAK_LIMIT.windowMs);
  const ok = recent.length < SPEAK_LIMIT.requests;
  if (ok) recent.push(nowMs);
  asked.set(visitor, recent);
  if (asked.size > 5000) asked.clear();
  return ok;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const audio = (body: BodyInit, voice: 'cartesia' | 'aura') =>
  new Response(body, {
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Luna-Voice': voice },
  });

/** Workers AI hands back audio as a stream, bytes, or base64 in an object, depending on the model's version. */
function audioBody(out: unknown): BodyInit | null {
  if (out instanceof ReadableStream || out instanceof ArrayBuffer || out instanceof Uint8Array) return out as BodyInit;
  if (out && typeof out === 'object' && typeof (out as { audio?: unknown }).audio === 'string') {
    return Uint8Array.from(atob((out as { audio: string }).audio), (c) => c.charCodeAt(0));
  }
  return null;
}

/** The reply's text from the request, cleaned for speech and cut to length; null when the body isn't `{text}`. */
export function readSpeakText(body: string): string | null {
  if (body.length > MAX_BODY_BYTES) return null;
  try {
    const text = (JSON.parse(body) as { text?: unknown }).text;
    return typeof text === 'string' ? speakableText(text).slice(0, MAX_SPEAK_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * One line spoken. Audio comes back as `audio/mpeg` with `X-Luna-Voice` naming the voice used; errors come back as a
 * short `error` code: `method`, `origin`, `rate_limited`, `bad_request`, `empty` and `no_voice` (neither voice
 * answered, so the browser speaks instead).
 */
export async function speak(
  request: Request,
  env: SpeakEnv,
  nowMs = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!allowedOrigin(request)) return json({ error: 'origin' }, 403);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  if (!speakAllowed(ip, nowMs)) return json({ error: 'rate_limited' }, 429);
  const text = readSpeakText(await request.text());
  if (text === null) return json({ error: 'bad_request' }, 400);
  if (!text) return json({ error: 'empty' }, 400);

  if (env.CARTESIA_API_KEY) {
    try {
      const res = await fetcher(CARTESIA.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CARTESIA_API_KEY}`,
          'Cartesia-Version': CARTESIA.version,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: CARTESIA.model,
          transcript: text,
          voice: { id: LUNA_VOICE_ID },
          output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
          language: 'en',
        }),
      });
      if (res.ok && res.body) return audio(res.body, 'cartesia');
    } catch {
      // Cartesia unreachable: the free voice below speaks instead.
    }
  }
  if (env.AI) {
    try {
      const body = audioBody(await env.AI.run(AURA.model, { text, speaker: AURA.speaker, encoding: 'mp3' }));
      if (body) return audio(body, 'aura');
    } catch {
      // Over the daily allocation, or the model failed: the browser speaks instead.
    }
  }
  return json({ error: 'no_voice' }, 503);
}
