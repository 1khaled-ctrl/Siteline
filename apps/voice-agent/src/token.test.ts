import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { AGENT_NAME, voiceToken } from '../../copilot-worker/src/voiceToken';

/**
 * The token endpoint signs its JWT by hand to stay free of SDKs on Cloudflare; this checks LiveKit's own verifier
 * accepts it and reads the grants and the agent dispatch the way LiveKit will.
 */
describe('the /api/voice-token JWT, read by LiveKit', () => {
  it('verifies and carries the room grant and the agent dispatch', async () => {
    const env = {
      LIVEKIT_URL: 'wss://x.livekit.cloud',
      LIVEKIT_API_KEY: 'APIabc',
      LIVEKIT_API_SECRET: 'a-long-secret-0123456789abcdef',
    };
    const req = new Request('https://siteline.test/api/voice-token', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    const { token } = (await (await voiceToken(req, env, Date.now(), 'v9')).json()) as { token: string };
    const claims = await new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).verify(token);
    expect(claims.sub).toBe('visitor-v9');
    expect(claims.video).toMatchObject({ room: 'siteline-v9', roomJoin: true, canPublish: true, canSubscribe: true });
    expect(claims.roomConfig?.agents?.[0]?.agentName).toBe(AGENT_NAME);
  });
});
