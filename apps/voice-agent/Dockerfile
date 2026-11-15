# Luna Live, the voice agent, as LiveKit Cloud runs it. LiveKit builds this from apps/voice-agent alone, so the agent is
# first bundled into dist/main.js with the chat relay's prompt and tools (apps/copilot-worker/src), which live outside
# this folder: `corepack pnpm --filter @siteline/voice-agent deploy:cloud` bundles, then deploys.
FROM node:24-slim

# The system's root certificates: LiveKit's native room client (@livekit/rtc-node) verifies TLS against them.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 agent
WORKDIR /app

# The packages stay outside the bundle (one has native code); package.json pins each of them.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY dist ./dist
ENV NODE_ENV=production
USER agent
# LiveKit Cloud supplies LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET; the models run on LiveKit Inference.
CMD ["node", "dist/main.js", "start"]
