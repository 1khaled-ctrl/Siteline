import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../copilot-worker/src/relay';
import { timeoutFor, toolReply, VOICE_INSTRUCTIONS, VOICE_TOOLS } from './voice';

describe('the voice agent', () => {
  it('has exactly the chat relay tools, so voice and chat do the same things', () => {
    expect(VOICE_TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES);
    for (const t of VOICE_TOOLS) expect(t.parameters).toMatchObject({ type: 'object' });
  });

  it('keeps the relay rules, drops the Qwen switch, and adds the spoken ones', () => {
    expect(VOICE_INSTRUCTIONS).toContain('Every number, date and time you write must appear in a tool result');
    expect(VOICE_INSTRUCTIONS).not.toContain('/no_think');
    expect(VOICE_INSTRUCTIONS).toContain('speaking out loud');
  });

  it('gives a search minutes and a view change seconds', () => {
    expect(timeoutFor('find_landing_sites')).toBeGreaterThanOrEqual(180_000);
    expect(timeoutFor('fly_to')).toBeLessThanOrEqual(15_000);
  });

  it('hands the model the data, or the error the browser gave', () => {
    expect(toolReply('{"data":{"verdict":"pass"},"sources":["x"]}')).toBe('{"verdict":"pass"}');
    expect(toolReply('{"error":"no robot called r2d2"}')).toBe('{"error":"no robot called r2d2"}');
    expect(JSON.parse(toolReply('not json'))).toHaveProperty('error');
  });
});
