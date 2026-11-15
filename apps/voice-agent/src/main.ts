/**
 * Luna Live: the voice agent. LiveKit sends it into a visitor's room when their browser joins with a token
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
import {
  appStateNote,
  GOODBYE,
  GREETING,
  MAX_CALL_MS,
  MAX_SAY_CHARS,
  MIN_SAY_GAP_MS,
  MODELS,
  RPC,
  timeoutFor,
  toolReply,
  VOICE_INSTRUCTIONS,
  VOICE_TOOLS,
} from './voice';

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
    // A visitor who leaves before the agent arrives ends the job quietly.
    const visitor = await ctx.waitForParticipant().catch(() => undefined);
    if (!visitor) return;
    const callBrowser: CallBrowser = (method, payload, timeoutMs) => {
      const me = ctx.room.localParticipant;
      if (!me) return Promise.reject(new Error('not connected'));
      return me.performRpc({ destinationIdentity: visitor.identity, method, payload, responseTimeout: timeoutMs });
    };

    const session = new voice.AgentSession({
      stt: MODELS.stt,
      llm: new inference.LLM({ model: MODELS.llm, strictToolSchema: false }),
      tts: new inference.TTS({
        model: MODELS.tts,
        voice: MODELS.ttsVoice,
        // Start speaking as soon as a phrase is ready, not after Cartesia's default wait for more text.
        modelOptions: { max_buffer_delay_ms: 200 },
        fallback: MODELS.ttsFallback,
      }),
      turnHandling: { turnDetection: 'stt' },
      // Search, maybe search again on another date, select, check the robot: room for the whole plan in one turn.
      maxToolSteps: 6,
    });
    await session.start({ agent: new SiteLineAgent(callBrowser), room: ctx.room });
    // Progress the browser reports while a tool runs (a site found, how far a search has got), spoken as it comes.
    let lastSayMs = 0;
    ctx.room.localParticipant?.registerRpcMethod(RPC.say, async (data) => {
      if (data.callerIdentity !== visitor.identity) return 'not allowed';
      const now = Date.now();
      if (now - lastSayMs < MIN_SAY_GAP_MS) return 'skipped';
      lastSayMs = now;
      const sentence = data.payload.trim().slice(0, MAX_SAY_CHARS);
      if (sentence) session.say(sentence, { addToChatCtx: false });
      return 'ok';
    });
    // Every call has an end: after MAX_CALL_MS Luna says goodbye and leaves, which closes the room.
    const limit = setTimeout(async () => {
      await session
        .say(GOODBYE, { allowInterruptions: false })
        .waitForPlayout()
        .catch(() => undefined);
      ctx.shutdown('call time limit');
    }, MAX_CALL_MS);
    ctx.addShutdownCallback(async () => clearTimeout(limit));
    // A fixed greeting goes straight to speech, without waiting on the model.
    session.say(GREETING);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    // One process kept ready, so a call doesn't wait seconds for a new one to start (dev mode keeps none).
    numIdleProcesses: 1,
  }),
);
