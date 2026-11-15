import { describe, expect, it } from 'vitest';
import { readToolCall, rpcReply } from './liveVoice';

describe('readToolCall', () => {
  it('reads the agent tool call, using the RPC request id as the call id', () => {
    expect(readToolCall('{"name":"fly_to","arguments":{"target":"mars"}}', 'r1')).toEqual({
      id: 'r1',
      name: 'fly_to',
      arguments: { target: 'mars' },
    });
    expect(readToolCall('{"name":"analyze_site"}', 'r2').arguments).toEqual({});
  });
  it('refuses a call with no name', () => {
    expect(() => readToolCall('{"arguments":{}}', 'r')).toThrow(/name/);
  });
});

describe('rpcReply', () => {
  it('passes a result that fits an RPC reply', () => {
    expect(rpcReply({ data: { verdict: 'pass' } })).toBe('{"data":{"verdict":"pass"}}');
  });
  it('turns one too large for LiveKit into an error the agent can act on', () => {
    const big = rpcReply({ data: 'x'.repeat(20_000) });
    expect(JSON.parse(big)).toHaveProperty('error');
  });
});
