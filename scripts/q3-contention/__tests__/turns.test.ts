import { describe, it, expect } from 'vitest';
import {
  countCrossedTokens,
  drainFrames,
  parseMarker,
  realRuntimePrompt,
  summarize,
  type TurnState,
} from '../turns.js';
import type { AgentPlan } from '../plan.js';

const AGENT: AgentPlan = { index: 0, vocab: 'cats', tree: 'a' };

/** A turn state with a clean scenario transcript, overridable per test. */
function stateWith(text: string, overrides: Partial<TurnState> = {}): TurnState {
  return {
    text,
    firstDeltaAtMs: 5_000,
    observedEndMs: 9_000,
    terminalReason: 'ok',
    ended: true,
    ...overrides,
  };
}

const GOOD_TRANSCRIPT =
  '[q3-start] vocab=cats startedAt=1700000000000\n' +
  'cats:TABBY#00000 cats:CALICO#00001 \n' +
  '[q3-summary] vocab=cats startedAt=1700000000000 endedAt=1700000030000 ticks=60 appends=58 canaryErrors=2\n';

describe('parseMarker', () => {
  it('reads key=value pairs off the marker line', () => {
    expect(parseMarker(GOOD_TRANSCRIPT, '[q3-summary]')).toEqual({
      vocab: 'cats',
      startedAt: '1700000000000',
      endedAt: '1700000030000',
      ticks: '60',
      appends: '58',
      canaryErrors: '2',
    });
  });

  it('returns null when the marker is absent', () => {
    expect(parseMarker('no markers here', '[q3-summary]')).toBeNull();
  });

  it('reads the LAST marker when a transcript carries several', () => {
    const text = '[q3-summary] ticks=1\nmore\n[q3-summary] ticks=2\n';
    expect(parseMarker(text, '[q3-summary]')?.ticks).toBe('2');
  });

  it('drops an empty value rather than storing it', () => {
    // Number('') is 0 and Number.isFinite(0) is true, so storing '' would let a
    // truncated marker masquerade as a real timestamp downstream.
    expect(parseMarker('[q3-summary] vocab=cats startedAt= ticks=3', '[q3-summary]')).toEqual({
      vocab: 'cats',
      ticks: '3',
    });
  });
});

describe('summarize', () => {
  it('uses the agent clock when both endpoints parse', () => {
    const result = summarize(AGENT, 'sid', 4_000, stateWith(GOOD_TRANSCRIPT));
    expect(result.timestampSource).toBe('agent');
    expect(result.startedAtMs).toBe(1_700_000_000_000);
    expect(result.endedAtMs).toBe(1_700_000_030_000);
    expect(result.ticks).toBe(60);
    expect(result.appends).toBe(58);
    expect(result.canaryErrors).toBe(2);
  });

  it('never lets a truncated startedAt produce an epoch-0 interval', () => {
    // The trap: '' → Number('') === 0 → isFinite → an interval starting at the
    // epoch, wide enough to overlap every other agent and pass the proof.
    const result = summarize(
      AGENT,
      'sid',
      4_000,
      stateWith('[q3-summary] vocab=cats startedAt= endedAt=1700000030000 ticks=6 appends=6\n')
    );
    expect(result.startedAtMs).not.toBe(0);
    expect(result.timestampSource).toBe('harness');
    expect(result.startedAtMs).toBe(5_000);
    expect(result.endedAtMs).toBe(9_000);
  });

  it('rejects a non-numeric timestamp instead of coercing it', () => {
    const result = summarize(
      AGENT,
      'sid',
      4_000,
      stateWith('[q3-summary] vocab=cats startedAt=soon endedAt=later ticks=6 appends=6\n')
    );
    expect(result.timestampSource).toBe('harness');
  });

  it('rejects an inverted agent interval', () => {
    const result = summarize(
      AGENT,
      'sid',
      4_000,
      stateWith('[q3-summary] vocab=cats startedAt=900 endedAt=100 ticks=6 appends=6\n')
    );
    expect(result.timestampSource).toBe('harness');
  });

  it('falls back to the harness clock when no marker arrived at all', () => {
    const result = summarize(AGENT, 'sid', 4_000, stateWith('just some prose\n'));
    expect(result.timestampSource).toBe('harness');
    expect(result.startedAtMs).toBe(5_000);
    expect(result.ticks).toBe(-1);
    expect(result.appends).toBe(-1);
  });

  it('uses the fire time when the stream produced no deltas', () => {
    const result = summarize(AGENT, 'sid', 4_000, stateWith('', { firstDeltaAtMs: 0 }));
    expect(result.startedAtMs).toBe(4_000);
  });

  it('reports unreported counts as -1 so the work proof can catch them', () => {
    const result = summarize(AGENT, 'sid', 4_000, stateWith('[q3-summary] vocab=cats\n'));
    expect(result.ticks).toBe(-1);
    expect(result.appends).toBe(-1);
  });
});

describe('countCrossedTokens', () => {
  it('counts zero when every token carries the session own vocabulary', () => {
    expect(countCrossedTokens(GOOD_TRANSCRIPT, 'cats')).toBe(0);
  });

  it('counts tokens that leaked in from another agent', () => {
    const text = 'cats:TABBY#00000 dogs:BEAGLE#00004 cats:SPHYNX#00001 birds:WREN#00009';
    expect(countCrossedTokens(text, 'cats')).toBe(2);
  });

  it('ignores prose that is not a tagged token', () => {
    expect(countCrossedTokens('the dogs: were loud, TABBY#1 too', 'cats')).toBe(0);
  });
});

describe('drainFrames', () => {
  it('parses complete frames and returns the unconsumed tail', () => {
    const { frames, rest } = drainFrames(
      'event: text_delta\ndata: {"text":"hi"}\n\nevent: turn_end\ndata: {"terminalRea'
    );
    expect(frames).toEqual([{ event: 'text_delta', data: { text: 'hi' } }]);
    expect(rest).toBe('event: turn_end\ndata: {"terminalRea');
  });

  it('reassembles a frame split across two chunks', () => {
    const first = drainFrames('event: text_delta\ndata: {"text":"a');
    expect(first.frames).toEqual([]);
    const second = drainFrames(`${first.rest}bc"}\n\n`);
    expect(second.frames).toEqual([{ event: 'text_delta', data: { text: 'abc' } }]);
  });

  it('skips an unparseable frame without abandoning the rest of the stream', () => {
    const { frames } = drainFrames(
      'event: text_delta\ndata: {broken\n\nevent: turn_end\ndata: {"terminalReason":"ok"}\n\n'
    );
    expect(frames).toEqual([{ event: 'turn_end', data: { terminalReason: 'ok' } }]);
  });

  it('ignores a block with no event or no data line', () => {
    expect(drainFrames(': keep-alive comment\n\ndata: {"orphan":true}\n\n').frames).toEqual([]);
  });
});

describe('realRuntimePrompt', () => {
  it('asks the real agent for the timestamps the overlap proof needs', () => {
    // Without these the interval collapses to the harness request window, which
    // overlaps trivially and would let the proof pass on work never done.
    const prompt = realRuntimePrompt(AGENT, '/tmp/run/trees/a/q3-canary.log', 40);
    expect(prompt).toContain('startedAt=<START>');
    expect(prompt).toContain('endedAt=<END>');
    expect(prompt).toContain('appends=<lines you wrote>');
    expect(prompt).toContain('/tmp/run/trees/a/q3-canary.log');
  });

  it('spells out the non-atomic write the measurement depends on', () => {
    const prompt = realRuntimePrompt(AGENT, '/tmp/c.log', 5);
    expect(prompt).toContain('Do not use append mode, a lock, or an atomic rename');
    expect(prompt).toContain('Report what actually happened, not what was requested.');
  });
});
