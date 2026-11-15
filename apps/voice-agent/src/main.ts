/**
 * Ask SiteLine Live: the voice agent. LiveKit sends it into a visitor's room when their browser joins with a token
 * from /api/voice-token. It hears the visitor (STT), thinks (LLM) and speaks (TTS) through LiveKit Inference, and every
 * tool it calls runs in the visitor's own browser over RPC, with the same functions the screen uses: the agent never
 * computes a number itself, and the view moves as it works.
 *
 *   corepack pnpm --filter @siteline/voice-agent dev     (needs apps/voice-agent/.env.local, see CLAUDE.md)
 */
import { fileURLToPath } from 'node:url';
import { cli, defineAgent, inference, type JobContext, llm, ServerOptions, voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { AGENT_NAME } from '../../copilot-worker/src/voiceToken';
import { appStateNote, MODELS, RPC, timeoutFor, toolReply, VOICE_INSTRUCTIONS, VOICE_TOOLS } from './voice';

dotenv.config({ path: fileURLToPath(new URL('../.env.local', import.meta.url)) });

type CallBrowser = (method: string, payload: string, timeoutMs: number) => Promise<string>;

type ToolParameters = NonNullable<Parameters<typeof llm.tool>[0]['parameters']>;

/** The relay's tools, each one forwarded to the browser. A tool that fails there comes back as an error to read. */
function browserTools(callBrowser: CallBrowser) {
  return Object.fromEntries(
    VOICE_TOOLS.map((t) => [
      t.name,
      llm.tool({
        description: t.description,
        parameters: t.parameters as unknown as ToolParameters,
        execute: async (args: unknown) => {
          try {
            const raw = await callBrowser(
              RPC.tool,
              JSON.stringify({ name: t.name, arguments: args ?? {} }),
              timeoutFor(t.name),
            );
            return toolReply(raw);
          } catch (e) {
            return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
          }
        },
      }),
    ]),
  );
}

class SiteLineAgent extends voice.Agent {
  constructor(private readonly callBrowser: CallBrowser) {
    super({ instructions: VOICE_INSTRUCTIONS, tools: browserTools(callBrowser) });
  }

  /** Before each spoken reply: what the visitor's screen shows now (view, site, date, robot, pins). */
  override async onUserTurnCompleted(chatCtx: llm.ChatContext): Promise<void> {
    const state = await this.callBrowser(RPC.state, '{}', 3000).catch(() => undefined);
    if (state) chatCtx.addMessage({ role: 'system', content: appStateNote(state) });
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const visitor = await ctx.waitForParticipant();
    const callBrowser: CallBrowser = (method, payload, timeoutMs) => {
      const me = ctx.room.localParticipant;
      if (!me) return Promise.reject(new Error('not connected'));
      return me.performRpc({ destinationIdentity: visitor.identity, method, payload, responseTimeout: timeoutMs });
    };

    const session = new voice.AgentSession({
      stt: MODELS.stt,
      llm: new inference.LLM({ model: MODELS.llm, strictToolSchema: false }),
      tts: MODELS.tts,
      turnHandling: { turnDetection: 'stt' },
      // Search, maybe search again on another date, select, check the robot: room for the whole plan in one turn.
      maxToolSteps: 6,
    });
    await session.start({ agent: new SiteLineAgent(callBrowser), room: ctx.room });
    session.generateReply({
      instructions: 'Greet the visitor in one short sentence as Ask SiteLine, and offer to find them a landing site.',
    });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
