/**
 * Ask SiteLine Live's token endpoint on Cloudflare Pages, at /api/voice-token. The logic is in
 * apps/copilot-worker/src/voiceToken.ts, where the tests reach it; this hands it the request and the LiveKit secrets
 * the Pages project's settings hold (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).
 */
import { type VoiceEnv, voiceToken } from '../../apps/copilot-worker/src/voiceToken';

export function onRequest({ request, env }: { request: Request; env: VoiceEnv }): Promise<Response> {
  return voiceToken(request, env);
}
