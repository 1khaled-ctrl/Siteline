import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { greetingWatch, readToolCall, rpcReply } from './liveVoice';

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

describe('greetingWatch', () => {
  const times = { joinMs: 15_000, greetMs: 8_000 };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives up once when the agent joins and never speaks', () => {
    const onSilent = vi.fn();
    const watch = greetingWatch(onSilent, times);
    vi.advanceTimersByTime(2_000);
    watch.joined();
    vi.advanceTimersByTime(7_999);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilent).toHaveBeenCalledTimes(1);
    expect(watch.silent()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('stays out of the way when Luna greets the caller', () => {
    const onSilent = vi.fn();
    const watch = greetingWatch(onSilent, times);
    watch.joined();
    vi.advanceTimersByTime(1_500);
    watch.heard();
    vi.advanceTimersByTime(60_000);
    expect(onSilent).not.toHaveBeenCalled();
    expect(watch.silent()).toBe(false);
  });

  it('gives up when the agent never joins', () => {
    const onSilent = vi.fn();
    greetingWatch(onSilent, times);
    vi.advanceTimersByTime(14_999);
    expect(onSilent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it("doesn't let later state changes push the deadline back", () => {
    const onSilent = vi.fn();
    const watch = greetingWatch(onSilent, times);
    watch.joined();
    for (let i = 0; i < 7; i++) {
      vi.advanceTimersByTime(1_000);
      watch.joined();
    }
    vi.advanceTimersByTime(1_000);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('does nothing once the call is cancelled', () => {
    const onSilent = vi.fn();
    const watch = greetingWatch(onSilent, times);
    watch.joined();
    watch.cancel();
    vi.advanceTimersByTime(60_000);
    expect(onSilent).not.toHaveBeenCalled();
  });
});
