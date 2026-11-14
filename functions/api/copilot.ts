/**
 * Ask SiteLine's relay on Cloudflare Pages, at /api/copilot. The logic is in apps/copilot-worker/src/relay.ts, where
 * the tests reach it; this only hands it the request and the project's Workers AI binding (`AI`), which the Pages
 * project's settings add. There is no API key: on Cloudflare's free plan the model is free up to a daily allocation.
 */
import { type Env, relay } from '../../apps/copilot-worker/src/relay';

export function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  return relay(request, env);
}
