/**
 * Ask SiteLine Live's token endpoint (POST /api/voice-token). A visitor who taps "Talk live" gets a short-lived
 * LiveKit access token for a room of their own, and the token itself asks LiveKit to send the SiteLine voice agent
 * (apps/voice-agent) into that room. The API key and secret stay here, set as secrets on the Pages project
 * (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`); the browser only ever sees the signed token.
 *
 * The token is a JWT signed with HMAC-SHA256 through WebCrypto, so the Function needs no LiveKit SDK. Its claims follow
 * LiveKit's AccessToken: `video` holds the room grant and `roomConfig.agents` dispatches the agent by name.
 */
import { allowedOrigin, underLimit } from './relay';

export interface VoiceEnv {
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

/** The name the voice agent registers under (ServerOptions.agentName), so only it is dispatched. */
export const AGENT_NAME = 'siteline';
/** Long enough to join; LiveKit keeps a joined visitor connected after the token expires. */
const TOKEN_TTL_S = 10 * 60;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const jsonPart = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

/** A JWT over `claims`, signed with HS256. */
export async function signJwt(claims: Record<string, unknown>, secret: string): Promise<string> {
  const unsigned = `${jsonPart({ alg: 'HS256', typ: 'JWT' })}.${jsonPart(claims)}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

/** The claims for one visitor: their own room, publish and subscribe rights, and the agent sent in with them. */
export function visitorClaims(apiKey: string, visitorId: string, nowS: number) {
  return {
    iss: apiKey,
    sub: `visitor-${visitorId}`,
    name: 'Visitor',
    nbf: nowS,
    exp: nowS + TOKEN_TTL_S,
    video: {
      room: `siteline-${visitorId}`,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
    roomConfig: { agents: [{ agentName: AGENT_NAME }] },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/**
 * One token request. Errors come back with a short `error` code the chat turns into words: `no_voice` (the LiveKit
 * secrets aren't set, as on a plain Vite server or before setup), `rate_limited`, `origin` and `method`.
 */
export async function voiceToken(
  request: Request,
  env: VoiceEnv,
  nowMs = Date.now(),
  visitorId: string = crypto.randomUUID().slice(0, 12),
): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!allowedOrigin(request)) return json({ error: 'origin' }, 403);
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: apiKey, LIVEKIT_API_SECRET: secret } = env;
  if (!url || !apiKey || !secret) return json({ error: 'no_voice' }, 503);
  const visitor = `voice:${request.headers.get('CF-Connecting-IP') ?? 'local'}`;
  if (!underLimit(visitor, nowMs)) return json({ error: 'rate_limited' }, 429);
  const claims = visitorClaims(apiKey, visitorId, Math.floor(nowMs / 1000));
  return json({ url, token: await signJwt(claims, secret), room: claims.video.room, identity: claims.sub });
}
