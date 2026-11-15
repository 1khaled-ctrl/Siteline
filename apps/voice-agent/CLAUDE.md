# apps/voice-agent: Ask SiteLine Live

Owner: Copilot and quality (feature 25, with apps/copilot-worker).

The voice agent behind the chat's **Talk live** button. It's a LiveKit Agents worker (Node, `@livekit/agents` 1.9.5, pinned) that LiveKit Cloud sends into a visitor's room when their browser joins.

## How it fits together

1. The browser asks `/api/voice-token` (`functions/api/voice-token.ts`, logic in `apps/copilot-worker/src/voiceToken.ts`) for a token. The token gives the visitor a room of their own, and its `roomConfig` dispatches the agent named `siteline`.
2. The browser (`apps/web/src/liveVoice.ts`) joins, publishes the mic, plays the agent's voice and shows both sides' transcripts in the chat (`lk.transcription` text streams). Typed messages go to the agent on `lk.chat`.
3. The agent (`src/main.ts`) hears, thinks and speaks through **LiveKit Inference**: Deepgram Flux for STT (it also decides when the visitor has finished), `openai/gpt-4.1-mini` for the LLM and Cartesia Sonic 3 for TTS, in the team's chosen Cartesia voice (`db6b0ed5-…`), with Deepgram Aura 2 as LiveKit's fallback if Cartesia fails. No provider keys are needed, only the LiveKit project's. Override with `SITELINE_STT`, `SITELINE_LLM`, `SITELINE_TTS` and `SITELINE_TTS_VOICE`.
4. Every tool call goes to the browser by RPC (`siteline.tool`) and runs through the same `runAgentTool` as the chat, so the view moves and every number is SiteLine's own. Before each spoken reply the agent reads the screen's state (`siteline.state`).

The tools and the base prompt are the chat relay's own (`TOOLS` and `SYSTEM_PROMPT` in `apps/copilot-worker/src/relay.ts`). `src/voice.ts` only adds the spoken rules. Change a tool in the relay and voice gets it too; `src/voice.test.ts` checks they match.

## Setup

1. Make a LiveKit Cloud project. From its settings, take the URL (`wss://….livekit.cloud`), an API key and its secret.
2. `apps/voice-agent/.env.local` (git ignores it):
   ```
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=...
   LIVEKIT_API_SECRET=...
   ```
3. `.dev.vars` at the repository root, for the token Function under Wrangler (git ignores it), with the same three lines.
4. Run three things: `corepack pnpm dev` (the app), `corepack pnpm copilot` (the Functions on 8788, which serve `/api/copilot` and `/api/voice-token`) and `corepack pnpm voice-agent` (this worker).
5. On the deployed site, add the three values to the Pages project as encrypted variables, and run the worker somewhere that stays up: `lk agent create` deploys it to LiveKit Cloud. Set a spending limit in the LiveKit project.

Without the secrets, `/api/voice-token` answers `no_voice` and the chat says live voice isn't set up. The mic button keeps working with the browser's own speech.

## Rules

- The agent never computes or recalls a number. It reads tool results only, and the prompt says so.
- Keep RPC replies under LiveKit's 15 KiB limit. `liveVoice.ts` refuses a bigger result with an error the model can act on.
- The browser answers RPC only from the room's agent participant.
- The pnpm `allowBuilds` entries in `pnpm-workspace.yaml` skip install scripts this package's dependencies ask for. None is needed while the agent uses LiveKit Inference and no local models.
