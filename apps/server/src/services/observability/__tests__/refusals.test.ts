/**
 * The refusal rule, pinned at the one function every refusal goes through.
 *
 * The rule that would have changed the 2026-07-31 incident is narrow: a refusal
 * the person could see is `info`, and a refusal that was damped or silent is
 * `warn`, because the log line is then the only record that anything happened.
 * Both invisible ten-minute silences in that incident were the second kind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../../../lib/logger.js';
import { logRefusal, REFUSAL_REASONS, type RefusalReason } from '../refusals.js';
import { runInDispatch } from '../../../lib/dispatch-context.js';
import { recentRefusals, resetDispatchBuffers } from '../dispatch-buffers.js';

// File-level, not per-describe: `vi.spyOn` on an already-spied method hands
// back the SAME spy, so a describe without its own restore inherits the
// previous block's recorded calls and reads `calls[0]` from another test.
beforeEach(() => {
  resetDispatchBuffers();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDispatchBuffers();
});

describe('logRefusal', () => {
  it('files a refusal the person saw at info', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logRefusal('[rooms] an agent did not answer', {
      reason: 'agent_busy',
      visibility: 'shown',
      roomId: 'r1',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('[rooms] an agent did not answer', {
      roomId: 'r1',
      reason: 'agent_busy',
      visibility: 'shown',
    });
  });

  it.each(['damped', 'silent'] as const)('files a %s refusal at warn', (visibility) => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logRefusal('[rooms] an agent did not answer', {
      reason: 'agent_busy',
      visibility,
      roomId: 'r1',
    });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[rooms] an agent did not answer', {
      roomId: 'r1',
      reason: 'agent_busy',
      visibility,
    });
  });

  it('drops undefined fields rather than writing nulls into the line', () => {
    // `jq 'select(.sessionId)'` should not match a room refusal that has none.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logRefusal('[relay] an inbound chat message was dropped', {
      reason: 'binding_paused',
      visibility: 'silent',
      roomId: undefined,
      detail: { bindingId: 'b1', cause: undefined },
    });
    const fields = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(['bindingId', 'reason', 'visibility']);
  });

  it('keeps reason and visibility authoritative over a colliding detail key', () => {
    // `detail` is caller-supplied; the two fields the whole rule turns on must
    // not be overwritable by one.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logRefusal('[rooms] an agent did not answer', {
      reason: 'turn_failed',
      visibility: 'silent',
      detail: { reason: 'something-else', visibility: 'shown' },
    });
    expect(warn.mock.calls[0][1]).toMatchObject({
      reason: 'turn_failed',
      visibility: 'silent',
    });
  });
});

describe('which dispatch a refusal belongs to', () => {
  it('inherits the ambient one when the caller does not say', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    runInDispatch({ dispatchId: 'dsp_AMBIENT', origin: 'room' }, () => {
      logRefusal('[rooms] an agent did not answer', {
        reason: 'agent_busy',
        visibility: 'silent',
      });
    });
    expect(warn.mock.calls[0][1]).toMatchObject({ dispatchId: 'dsp_AMBIENT' });
    expect(recentRefusals(1)[0]).toMatchObject({ dispatchId: 'dsp_AMBIENT', origin: 'room' });
  });

  it('takes an explicitly named dispatch over the ambient one', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    runInDispatch({ dispatchId: 'dsp_AMBIENT', origin: 'room' }, () => {
      logRefusal('[rooms] the room is out of automatic turns', {
        reason: 'room_budget',
        visibility: 'silent',
        dispatchId: 'dsp_MINE',
      });
    });
    expect(warn.mock.calls[0][1]).toMatchObject({ dispatchId: 'dsp_MINE' });
    const [kept] = recentRefusals(1);
    expect(kept.dispatchId).toBe('dsp_MINE');
    // The origin describes the AMBIENT scope, which is a different dispatch —
    // so it does not ride along. The same substitution the id refuses, one
    // field over.
    expect(kept.origin).toBeUndefined();
  });

  it('refuses the ambient id when the caller says there is none', () => {
    // The wrong-id case. A cascade refusal decided inside the replying agent's
    // scope must not be filed under that agent's dispatch.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    runInDispatch({ dispatchId: 'dsp_BYSTANDER', origin: 'room' }, () => {
      logRefusal('[rooms] the guard stopped an exchange', {
        reason: 'cascade_depth',
        visibility: 'silent',
        dispatchId: null,
      });
    });
    // Present as a KEY so the reporter cannot inject the ambient one, and
    // `undefined` so `JSON.stringify` drops it from the written line.
    const fields = warn.mock.calls[0][1] as Record<string, unknown>;
    expect('dispatchId' in fields).toBe(true);
    expect(fields.dispatchId).toBeUndefined();
    expect(recentRefusals(1)[0].dispatchId).toBeUndefined();
  });

  it('says nothing about a dispatch when there is no ambient one to suppress', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    logRefusal('[relay] nothing connects this chat to an agent', {
      reason: 'no_binding',
      visibility: 'silent',
      dispatchId: null,
    });
    expect('dispatchId' in (warn.mock.calls[0][1] as object)).toBe(false);
  });
});

describe('the reason union', () => {
  it('is lower_snake and unique, so jq can group on it', () => {
    // Free-form reasons drift into three spellings of one refusal across three
    // files. The union is the thing that stops that; this asserts its shape.
    const reasons = Object.keys(REFUSAL_REASONS) as RefusalReason[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const reason of reasons) expect(reason).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
  });

  it('describes every reason in plain words, for the guide', () => {
    for (const [reason, meaning] of Object.entries(REFUSAL_REASONS)) {
      expect(meaning, reason).toMatch(/^[a-z]/);
      expect(meaning.length, reason).toBeGreaterThan(10);
    }
  });
});
