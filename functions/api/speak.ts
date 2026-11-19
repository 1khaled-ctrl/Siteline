/**
 * Luna's voice on Cloudflare Pages, at /api/speak. The logic is in apps/copilot-worker/src/speak.ts, where the tests
 * reach it; this hands it the request, the Cartesia key the Pages project's settings hold (CARTESIA_API_KEY, a secret)
 * and the Workers AI binding (AI) for the free fallback voice.
 */
import { type SpeakEnv, speak } from '../../apps/copilot-worker/src/speak';

export function onRequest({ request, env }: { request: Request; env: SpeakEnv }): Promise<Response> {
  return speak(request, env);
}
