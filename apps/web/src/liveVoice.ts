import { ConnectionState, type RemoteTrack, Room, RoomEvent, type RpcInvocationData, Track } from 'livekit-client';
import { type ToolCall, visitorText } from './copilotAi';

/**
 * Luna Live in the browser: a LiveKit room with the SiteLine voice agent (apps/voice-agent). The visitor's mic
 * goes to the agent and its voice comes back; both sides' words arrive as transcripts for the chat. When the agent
 * calls a tool, it asks this page over RPC, and the page runs it with the same code the chat uses (agentTools.ts), so
 * the view moves and the numbers are SiteLine's own. Typed messages go to the same agent over the room's chat topic.
 */

/** The RPC methods the agent calls (apps/voice-agent/src/voice.ts). */
export const RPC = { tool: 'siteline.tool', state: 'siteline.state', say: 'siteline.say' } as const;
/** LiveKit's limit on an RPC reply is 15 KiB; a bigger tool result is refused rather than cut. */
const MAX_REPLY_BYTES = 14_000;
const AGENT_STATE = 'lk.agent.state';

export type LiveState = 'connecting' | 'listening' | 'thinking' | 'speaking';

export interface LiveHandlers {
  /** Words from either side, by segment: called as a segment grows, and once more when it is complete. */
  transcript: (segment: { id: string; from: 'you' | 'siteline'; text: string; final: boolean }) => void;
  state: (state: LiveState) => void;
  /** Runs a tool the agent asked for; its data goes back to the agent. */
  tool: (call: ToolCall) => Promise<{ data: unknown }>;
  appState: () => unknown;
  ended: (reason?: string) => void;
  /** The visitor's voice is heard right now: shown at once, before the words arrive from speech-to-text. */
  speaking?: (speaking: boolean) => void;
}

export interface LiveSession {
  /** A typed message, sent with the app's state ahead of it, as the chat sends one to the relay. */
  send: (text: string) => Promise<void>;
  /** A progress line for the agent to speak while a tool is still running. */
  say: (sentence: string) => Promise<void>;
  setMuted: (muted: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

export type TokenReply = { url: string; token: string } | { error: string };

let warmed = false;
/**
 * Starts the browser's WebRTC engine ahead of a call. Chrome's first WebRTC call can hold the page for seconds on some
 * machines (3 to 7 s measured on a Windows laptop, against under 1 s for every later call), and inside a call that
 * wait lands right after the tap. Run once, when the chat has opened and the page is idle, so the wait happens while
 * the visitor reads and "Talk live" connects at once.
 */
export function warmUpWebRtc(): void {
  if (warmed || typeof RTCRtpReceiver === 'undefined') return;
  warmed = true;
  const run = () => {
    try {
      RTCRtpReceiver.getCapabilities('audio');
    } catch {
      // A browser without it fails later, in the call, with a reason to show.
    }
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 1000);
}

export async function fetchVoiceToken(): Promise<TokenReply> {
  try {
    const res = await fetch('/api/voice-token', { method: 'POST' });
    // A Vite server with no Function behind /api answers with its own page.
    if (!(res.headers.get('Content-Type') ?? '').includes('application/json')) return { error: 'no_voice' };
    return (await res.json()) as TokenReply;
  } catch {
    return { error: 'no_voice' };
  }
}

/** The text the agent should read for a tool's result, or an error when it would not fit an RPC reply. */
export function rpcReply(result: { data: unknown } | { error: string }): string {
  const text = JSON.stringify(result);
  if (new TextEncoder().encode(text).length <= MAX_REPLY_BYTES) return text;
  return JSON.stringify({ error: 'the result was too large to send; ask for fewer sites or regions' });
}

/** A tool call from the agent's RPC payload, or an error saying what was wrong with it. */
export function readToolCall(payload: string, requestId: string): ToolCall {
  const v = JSON.parse(payload) as { name?: unknown; arguments?: unknown };
  if (typeof v.name !== 'string' || !v.name) throw new Error('tool call without a name');
  const args = v.arguments && typeof v.arguments === 'object' ? (v.arguments as Record<string, unknown>) : {};
  return { id: requestId, name: v.name, arguments: args };
}

export async function startLive(url: string, token: string, h: LiveHandlers): Promise<LiveSession> {
  const room = new Room({ adaptiveStream: true, dynacast: true });
  const audio: HTMLMediaElement[] = [];
  h.state('connecting');

  // Only the agent may ask this page to act: it is the room's other participant, but it is checked by kind too.
  const fromAgent = (data: RpcInvocationData) => room.remoteParticipants.get(data.callerIdentity)?.isAgent === true;

  room.registerRpcMethod(RPC.tool, async (data) => {
    if (!fromAgent(data)) return rpcReply({ error: 'not allowed' });
    try {
      const call = readToolCall(data.payload, data.requestId);
      return rpcReply({ data: (await h.tool(call)).data });
    } catch (e) {
      return rpcReply({ error: e instanceof Error ? e.message : String(e) });
    }
  });
  room.registerRpcMethod(RPC.state, async (data) =>
    fromAgent(data) ? JSON.stringify(h.appState()) : JSON.stringify({ error: 'not allowed' }),
  );

  room.registerTextStreamHandler('lk.transcription', async (reader, participant) => {
    const attrs = reader.info.attributes ?? {};
    const id = attrs['lk.segment_id'] ?? reader.info.id;
    const from = participant.identity === room.localParticipant.identity ? 'you' : 'siteline';
    let text = '';
    for await (const chunk of reader) {
      text += chunk;
      h.transcript({ id, from, text, final: false });
    }
    h.transcript({ id, from, text, final: attrs['lk.transcription_final'] === 'true' });
  });

  room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.hidden = true;
    document.body.appendChild(el);
    audio.push(el);
  });
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    h.speaking?.(speakers.some((p) => p.identity === room.localParticipant.identity));
  });
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
    const state = changed[AGENT_STATE];
    if (participant.isAgent && (state === 'listening' || state === 'thinking' || state === 'speaking')) h.state(state);
  });
  room.on(RoomEvent.Disconnected, (reason) => {
    for (const el of audio.splice(0)) el.remove();
    h.ended(reason === undefined ? undefined : String(reason));
  });

  await room.connect(url, token);
  // The tap that started the call lets the page play the agent's voice.
  await room.startAudio();
  await room.localParticipant.setMicrophoneEnabled(true);

  return {
    send: async (text) => {
      if (room.state !== ConnectionState.Connected) throw new Error('not connected');
      await room.localParticipant.sendText(
        `<app_state>${JSON.stringify(h.appState())}</app_state>\n${visitorText(text)}`,
        {
          topic: 'lk.chat',
        },
      );
    },
    say: async (sentence) => {
      const agent = [...room.remoteParticipants.values()].find((p) => p.isAgent);
      if (!agent || room.state !== ConnectionState.Connected) return;
      await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: RPC.say,
        payload: sentence,
        responseTimeout: 5000,
      });
    },
    setMuted: async (muted) => {
      await room.localParticipant.setMicrophoneEnabled(!muted);
    },
    stop: async () => {
      await room.disconnect();
    },
  };
}
