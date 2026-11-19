import { describe, expect, it, vi } from 'vitest';
import { speakable } from '../../web/src/voice';
import {
  AURA,
  CARTESIA,
  LUNA_VOICE_ID,
  MAX_SPEAK_CHARS,
  readSpeakText,
  speak,
  speakAllowed,
  speakableText,
} from './speak';

const post = (body: unknown, origin = 'http://localhost:5173', ip = 'ip-default') =>
  new Request('https://siteline.test/api/speak', {
    method: 'POST',
    headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const mp3 = () => new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { 'Content-Type': 'audio/mpeg' } });

describe('speakableText', () => {
  it('reads a reply the way the browser does: no emoji or arrows, one pause per line', () => {
    const reply = 'Found 3 sites ✨\n↳ Malapert Massif · passes\n\nIt’s on your screen.';
    expect(speakableText(reply)).toBe('Found 3 sites. Malapert Massif passes. It’s on your screen.');
    for (const s of [reply, 'Hi 👋 there', 'A\n\nB.', '• one\n• two']) expect(speakableText(s)).toBe(speakable(s));
  });
});

describe('readSpeakText', () => {
  it('takes {text}, cleans it and cuts it to a spoken length', () => {
    expect(readSpeakText(JSON.stringify({ text: 'Hello 🌙' }))).toBe('Hello');
    expect(readSpeakText(JSON.stringify({ text: 'a '.repeat(500) }))?.length).toBe(MAX_SPEAK_CHARS);
    expect(readSpeakText('not json')).toBeNull();
    expect(readSpeakText(JSON.stringify({ text: 5 }))).toBeNull();
    expect(readSpeakText(JSON.stringify({ text: 'x'.repeat(5000) }))).toBeNull();
  });
});

describe('speakAllowed', () => {
  it('lets a visitor have sixty lines in ten minutes, then refuses until the window moves on', () => {
    for (let i = 0; i < 60; i++) expect(speakAllowed('ip-limit', 1_000 + i)).toBe(true);
    expect(speakAllowed('ip-limit', 2_000)).toBe(false);
    expect(speakAllowed('ip-other', 2_000)).toBe(true);
    expect(speakAllowed('ip-limit', 1_000 + 10 * 60_000 + 60)).toBe(true);
  });
});

describe('speak', () => {
  it('speaks with Cartesia in Luna’s voice when the key is set, and says which voice it used', async () => {
    const fetcher = vi.fn(async () => mp3()) as unknown as typeof fetch;
    const ai = { run: vi.fn() };
    const res = await speak(
      post({ text: 'Hi, I’m Luna!' }, undefined, 'ip-c'),
      { CARTESIA_API_KEY: 'sk_car_test', AI: ai },
      0,
      fetcher,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(res.headers.get('X-Luna-Voice')).toBe('cartesia');
    expect(ai.run).not.toHaveBeenCalled();
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CARTESIA.url);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_car_test');
    expect(headers['Cartesia-Version']).toBe(CARTESIA.version);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model_id: 'sonic-3.6',
      transcript: 'Hi, I’m Luna!',
      voice: { id: LUNA_VOICE_ID },
      output_format: { container: 'mp3' },
    });
  });

  it('falls back to Aura’s "luna" voice on Workers AI when Cartesia refuses or there is no key', async () => {
    const stream = new Response(new Uint8Array([1, 2, 3])).body;
    const ai = { run: vi.fn(async () => stream) };
    const refused = vi.fn(async () => new Response('{"error":"quota"}', { status: 402 })) as unknown as typeof fetch;
    const res = await speak(post({ text: 'Hello' }, undefined, 'ip-a'), { CARTESIA_API_KEY: 'k', AI: ai }, 0, refused);
    expect(res.headers.get('X-Luna-Voice')).toBe('aura');
    expect(ai.run).toHaveBeenCalledWith(AURA.model, { text: 'Hello', speaker: 'luna', encoding: 'mp3' });
    const noKey = await speak(post({ text: 'Hello' }, undefined, 'ip-a2'), { AI: ai }, 0, refused);
    expect(noKey.headers.get('X-Luna-Voice')).toBe('aura');
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('says no_voice when neither voice answers, so the browser speaks instead', async () => {
    const ai = { run: vi.fn(async () => Promise.reject(new Error('4006: daily free allocation used'))) };
    const res = await speak(post({ text: 'Hello' }, undefined, 'ip-n'), { AI: ai }, 0);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_voice' });
  });

  it('refuses other sites, other methods, bad bodies and empty text', async () => {
    const env = { AI: { run: vi.fn() } };
    expect((await speak(post({ text: 'x' }, 'https://evil.example', 'ip-o'), env)).status).toBe(403);
    const get = new Request('https://siteline.test/api/speak', { headers: { Origin: 'http://localhost:5173' } });
    expect((await speak(get, env)).status).toBe(405);
    expect(await (await speak(post('nope', undefined, 'ip-b'), env)).json()).toEqual({ error: 'bad_request' });
    expect(await (await speak(post({ text: '👋' }, undefined, 'ip-e'), env)).json()).toEqual({ error: 'empty' });
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
