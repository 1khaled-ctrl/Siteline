import { describe, expect, it } from 'vitest';
import { askAi, type ChatMessage, numbersIn, type Relay, type ToolCall, unverifiedNumbers } from './copilotAi';

describe('numbersIn', () => {
  it('reads numbers as written, with thousands commas and decimals', () => {
    expect(numbersIn('Earth is in view 55.9% of 2,054 hours in 2028.')).toEqual(['55.9', '2,054', '2028']);
  });
});

describe('unverifiedNumbers', () => {
  const sources = ['{"earthPct":55.93,"sunMinPct":0,"slope100mDeg":4.1}'];
  it('finds a number that a source rounds to, at the precision it is written', () => {
    expect(unverifiedNumbers('Earth is in view 56% (55.9%) of the stay; slope 4.1°.', sources)).toEqual([]);
  });
  it('flags a number no source holds', () => {
    expect(unverifiedNumbers('Earth is in view 57% of the stay, and the slope is 7°.', sources)).toEqual(['57', '7']);
  });
});

/** A relay that plays back a script of replies, and records what it was sent. */
function scripted(replies: Awaited<ReturnType<Relay>>[]) {
  const sent: ChatMessage[][] = [];
  const relay: Relay = async (messages) => {
    sent.push(messages);
    const next = replies.shift();
    if (!next) throw new Error('script ran out');
    return next;
  };
  return { relay, sent };
}
const tool = async (call: ToolCall) => ({
  data: call.name === 'analyze_site' ? { verdict: 'fail', earthPct: 55.93 } : { ok: true },
  call: `${call.name}()`,
  sources: ['spice-de440s'],
});

describe('askAi', () => {
  it('runs the tools the model asks for and returns its answer, citing their sources', async () => {
    const { relay, sent } = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'analyze_site', arguments: {} }] },
      { text: 'It fails: Earth is in view only 56% of the stay.', toolCalls: [] },
    ]);
    const out = await askAi('Does it pass?', { view: 'pole' }, [], tool, relay);
    expect(out).toMatchObject({ ok: true, calls: ['analyze_site()'], sources: ['spice-de440s'], unverified: [] });
    // The second request carries the call and its result, matched by id.
    expect(sent[1].at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1' }] });
    expect(sent[1].at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: '{"verdict":"fail","earthPct":55.93}',
    });
    expect(sent[0][0]).toMatchObject({ role: 'user', content: expect.stringContaining('<app_state>{"view":"pole"}') });
  });

  it('flags a number in the answer that no tool gave', async () => {
    const { relay } = scripted([{ text: 'It is about 42 km from the pole.', toolCalls: [] }]);
    const out = await askAi('How far?', {}, [], tool, relay);
    expect(out).toMatchObject({ ok: true, unverified: ['42'] });
  });

  it('hands a failed tool back to the model as an error rather than stopping', async () => {
    const { relay, sent } = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'robot_fit', arguments: {} }] },
      { text: 'I could not read that robot.', toolCalls: [] },
    ]);
    const out = await askAi(
      'Robot?',
      {},
      [],
      async () => {
        throw new Error('no such robot');
      },
      relay,
    );
    expect(out.ok).toBe(true);
    expect(sent[1].at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"error":"no such robot"}' });
  });

  it('gives up, so the matcher can answer, when the relay is missing, busy or out of allowance', async () => {
    for (const error of ['no_ai', 'rate_limited', 'quota', 'http_404']) {
      const { relay } = scripted([{ error }]);
      expect(await askAi('hi', {}, [], tool, relay)).toEqual({ ok: false, reason: error });
    }
    const down: Relay = async () => {
      throw new Error('network down');
    };
    expect(await askAi('hi', {}, [], tool, down)).toEqual({ ok: false, reason: 'network down' });
  });

  it('stops a model that keeps calling tools', async () => {
    const loop = Array.from({ length: 5 }, () => ({
      text: '',
      toolCalls: [{ id: 'c', name: 'analyze_site', arguments: {} }],
    }));
    const { relay } = scripted(loop);
    expect(await askAi('hi', {}, [], tool, relay)).toEqual({ ok: false, reason: 'too_many_rounds' });
  });

  it('starts a long chat over instead of trimming it', async () => {
    const long: ChatMessage[] = Array.from({ length: 17 }, () => ({ role: 'user' as const, content: 'x' }));
    const { relay, sent } = scripted([{ text: 'ok', toolCalls: [] }]);
    await askAi('hi', {}, long, tool, relay);
    expect(sent[0]).toHaveLength(1);
  });
});
