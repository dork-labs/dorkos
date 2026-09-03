/**
 * The stop-requested rule, asserted rather than grepped for (spec
 * `runtime-interrupt-receipts` AC-6).
 *
 * The whole reason the copy lives in one module is that "'stopped' is only ever
 * said about an ending DorkOS observed" is a property of the MAPPING, and a
 * property of a mapping can be tested over the whole mapping. A test that
 * checked one sentence at a time would go green with a sixth outcome silently
 * saying anything at all.
 */
import { describe, it, expect } from 'vitest';
import type { InterruptOutcome, InterruptReceipt } from '@dorkos/shared/types';
import { shouldReofferStop, stopNotice } from '../lib/stop-copy';

const OUTCOMES: InterruptOutcome[] = ['acked', 'closed', 'not-running', 'unconfirmed', 'failed'];

/** The two endings DorkOS observed, and the only two allowed to say "stopped". */
const OBSERVED: InterruptOutcome[] = ['acked', 'closed'];

function receipt(outcome: InterruptOutcome, runtime = 'claude-code'): InterruptReceipt {
  return { outcome, runtime };
}

describe('stopNotice — the stop-requested rule', () => {
  it('says "stopped" for acked and closed, and for nothing else', () => {
    for (const outcome of OUTCOMES) {
      const message = stopNotice(receipt(outcome)).message ?? '';
      const saysStopped = /\bstopped\b/i.test(message);
      expect(
        saysStopped,
        `"${outcome}" ${saysStopped ? 'said' : 'did not say'} "stopped" — the word may only be ` +
          `used about an ending DorkOS observed (acked, closed). Message: ${JSON.stringify(message)}`
      ).toBe(OBSERVED.includes(outcome));
    }
  });

  it('says "stop requested" for the two endings that left the turn running', () => {
    for (const outcome of ['unconfirmed', 'failed'] as const) {
      const message = stopNotice(receipt(outcome)).message ?? '';
      expect(
        message.length,
        `"${outcome}" must say SOMETHING: it is one of the two endings where the person has to ` +
          'act, and silence would leave them believing the agent stopped'
      ).toBeGreaterThan(0);
      expect(/\bstopped\b/i.test(message)).toBe(false);
    }
    expect(stopNotice(receipt('unconfirmed')).message).toContain('Stop requested');
  });

  it('stays silent about not-running — nothing happened, so nothing is reported', () => {
    expect(stopNotice(receipt('not-running')).message).toBeNull();
  });

  it('reads as a failure only for `failed` — a closed turn is a success', () => {
    for (const outcome of OUTCOMES) {
      expect(
        stopNotice(receipt(outcome)).isFailure,
        `"${outcome}" — only \`failed\` is an error state. \`closed\` cost the agent its ` +
          'wind-down, which is one sentence of UI and not a red card'
      ).toBe(outcome === 'failed');
    }
  });

  it('names the runtime that could not confirm, in words a person recognises', () => {
    expect(stopNotice(receipt('unconfirmed', 'opencode')).message).toContain('OpenCode');
    expect(stopNotice(receipt('unconfirmed', 'codex')).message).toContain('Codex');
    expect(stopNotice(receipt('unconfirmed', 'claude-code')).message).toContain('Claude Code');
    // An adapter nobody has heard of still reads as English rather than leaking
    // an internal id into the sentence.
    const unknown = stopNotice(receipt('unconfirmed', 'some-future-runtime')).message ?? '';
    expect(unknown).toContain('The runtime');
    expect(unknown).not.toContain('some-future-runtime');
  });
});

describe('shouldReofferStop — the re-enable predicate over all five outcomes', () => {
  // The full cross product of §5.1, because the interesting cell is the one
  // where the runtime and the client DISAGREE: `not-running` while the client
  // still believes it is streaming.
  const EXPECTED: Record<InterruptOutcome, { streaming: boolean; settled: boolean }> = {
    acked: { streaming: false, settled: false },
    closed: { streaming: false, settled: false },
    'not-running': { streaming: true, settled: false },
    unconfirmed: { streaming: true, settled: true },
    failed: { streaming: true, settled: true },
  };

  for (const outcome of OUTCOMES) {
    it(`${outcome}: re-offers while streaming = ${EXPECTED[outcome].streaming}, once settled = ${EXPECTED[outcome].settled}`, () => {
      expect(shouldReofferStop(receipt(outcome), true)).toBe(EXPECTED[outcome].streaming);
      expect(shouldReofferStop(receipt(outcome), false)).toBe(EXPECTED[outcome].settled);
    });
  }

  it('never re-offers an ending DorkOS observed the turn end on', () => {
    // The half that keeps a settled turn from growing a Stop button back: the
    // turn's own settle takes it away, and a receipt must not put it back.
    for (const outcome of OBSERVED) {
      expect(shouldReofferStop(receipt(outcome), true)).toBe(false);
      expect(shouldReofferStop(receipt(outcome), false)).toBe(false);
    }
  });
});
