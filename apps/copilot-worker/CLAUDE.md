# apps/copilot-worker: the copilot relay

**What's built (14 Nov 2026):** the relay runs on a free model, not Claude, to keep the project at no cost. `src/relay.ts` (tested in `relay.test.ts`) is served by the Pages Function `functions/api/copilot.ts` and calls `@cf/qwen/qwen3-30b-a3b-fp8` through the Pages project's Workers AI binding `AI`: no API key, and on Cloudflare's free plan, usage past the 10,000-neuron daily allocation fails rather than being billed. The browser half is `apps/web/src/copilotAi.ts`; it falls back to the keyword matcher whenever the relay isn't reachable. Locally: `npx wrangler login` once, then `corepack pnpm copilot` beside `corepack pnpm dev`. The notes below were written for Claude and still hold for the request rules, tools-in-the-browser design and number check.


Owner: Copilot and quality. This is feature 25. Build it last, in stages, and only after the other 29 must-haves have shipped.

- The Worker only relays messages. Tools run in the browser with the same functions the UI uses, so the copilot can never show a number the screen doesn't.
- `ANTHROPIC_API_KEY` lives only in the Worker (`wrangler secret put`). The Worker:
  - accepts requests only from our own origins,
  - caps `max_tokens` per reply,
  - limits each visitor to 20 requests per 10 minutes, plus a daily total.

  A spend limit is also set in the Claude Console.
- Models: `claude-sonnet-5-5` for chat and tools, `claude-haiku-5-5` for side jobs. Use `@anthropic-ai/sdk` and pin its version on day one.

## Claude Sonnet 5.5 behaviour (checked November 2026)

- Forced `tool_choice` (`any` or a named `tool`) returns a 400. Use `auto`, set `strict: true` on every tool, and steer tool choice from the system prompt.
- `thinking: {type: "disabled"}` returns a 400. Control speed with `output_config.effort`. Start at `low` for chat and measure against the 3-second first-words budget. If that's still too slow, `thinking: {type: "between_tools"}` turns thinking off; it only works at effort `high` or below.
- Check `stop_reason` before reading the content, and handle `refusal`. Turn on server-side fallbacks with `fallbacks: "default"` and the beta `server-side-fallback-2026-07-01`.
- Keep each conversation append-only. Send assistant turns back unchanged, including thinking blocks. Never trim or edit earlier turns: history edits can be rejected on newly created API accounts. To cap length, start a new conversation instead.
- Return all tool results from one assistant turn in a single user message. A failed tool returns `is_error: true`.

## Prompt caching

- The cached prefix is ordered tools, then system, then messages. Keep the system prompt and the tool list byte-identical between requests: fixed tool order, and no dates or ids. Mark both for caching.
- The `<app_state>` block changes every turn, so put it after the cached prefix (in the user turn, or a mid-conversation system message), never in the top-level system prompt.
- Confirm caching works by checking that `usage.cache_read_input_tokens` is above zero from the second request on.

## Number check

Every number in a reply must appear in a tool result from the same turn. In development, flag any that don't; in production, log them.
