import { describe, expect, it } from 'vitest';
import { AGENT_NAME, signJwt, tokenAllowed, visitorClaims, voiceToken } from './voiceToken';

const env = {
  LIVE_VOICE: 'livekit',
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'APIkey',
  LIVEKIT_API_SECRET: 'secret-0123',
};
const post = (origin = 'http://localhost:5173') =>
  new Request('https://siteline.test/api/voice-token', { method: 'POST', headers: { Origin: origin } });

const decode = (part: string) => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));

async function verifies(jwt: string, secret: string): Promise<boolean> {
  const [head, body, sig] = jwt.split('.');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const bytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`${head}.${body}`));
}

describe('signJwt', () => {
  it('signs with HS256 so the secret verifies it and another does not', async () => {
    const jwt = await signJwt({ sub: 'a' }, 'secret-0123');
    expect(decode(jwt.split('.')[0])).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(await verifies(jwt, 'secret-0123')).toBe(true);
    expect(await verifies(jwt, 'other')).toBe(false);
  });
});

describe('visitorClaims', () => {
  it('gives each visitor a room of their own and dispatches the SiteLine agent into it', () => {
    const c = visitorClaims('APIkey', 'abc', 1_000);
    expect(c).toMatchObject({ iss: 'APIkey', sub: 'visitor-abc', nbf: 1_000, exp: 1_600 });
    expect(c.video).toEqual({
      room: 'siteline-abc',
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    expect(c.roomConfig).toEqual({
      agents: [{ agentName: AGENT_NAME }],
      maxParticipants: 2,
      emptyTimeout: 60,
      departureTimeout: 20,
    });
  });
});

describe('tokenAllowed', () => {
  it('gives one visitor five calls in ten minutes, then refuses until the window moves on', () => {
    const got = Array.from({ length: 6 }, (_, i) => tokenAllowed('ip-a', 1_000 + i));
    expect(got).toEqual([true, true, true, true, true, false]);
    expect(tokenAllowed('ip-b', 1_000)).toBe(true);
    expect(tokenAllowed('ip-a', 1_000 + 10 * 60_000 + 10)).toBe(true);
  });
});

describe('voiceToken', () => {
  it('hands our own page a signed token and the server URL', async () => {
    const res = await voiceToken(post(), env, 2_000_000, 'v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; token: string; room: string; identity: string };
    expect(body).toMatchObject({ url: env.LIVEKIT_URL, room: 'siteline-v1', identity: 'visitor-v1' });
    expect(await verifies(body.token, env.LIVEKIT_API_SECRET)).toBe(true);
    expect(decode(body.token.split('.')[1])).toMatchObject({ sub: 'visitor-v1', exp: 2_000 + 600 });
  });

  it('refuses other sites, other methods, and runs without its secrets', async () => {
    expect((await voiceToken(post('https://evil.example'), env)).status).toBe(403);
    expect((await voiceToken(new Request('https://siteline.test/api/voice-token'), env)).status).toBe(405);
    const off = await voiceToken(post(), {});
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: 'no_voice' });
  });

  it('keeps LiveKit off unless LIVE_VOICE is "livekit", even with its secrets set', async () => {
    const { LIVE_VOICE: _on, ...secretsOnly } = env;
    for (const e of [secretsOnly, { ...secretsOnly, LIVE_VOICE: 'off' }]) {
      const res = await voiceToken(post(), e, 2_000_000, 'v-off');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'no_voice' });
    }
  });
});
