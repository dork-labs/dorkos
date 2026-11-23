/**
 * An empty ceiling (`[]`) means "restrictive, unknown" to the runtime, but the carry join drops it.
 * So every point where a saved hand-off joins a ceiling refuses one instead of treating it as no
 * bound at all: the envelope decoder, the replay join and the protected notice join (DOR-3816).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stableStringify } from '@dorkos/shared/capabilities';
import { decodeHandoffEnvelope, joinHandoffCurrentCarry } from '../handoff-envelope.js';
import { joinProtectedHandoffCarry } from '../../../session/launch/dispatch-options.js';

const AT = '2026-11-21T12:00:00.000Z';
const READ_ASK = { asks: 'always', reach: 'read' } as const;

/** A well-formed saved hand-off, with the carry's ceiling swapped in. */
function envelopeJson(permissionCeiling: unknown): string {
  const facts = {
    sessionId: 'drafting-chat',
    createdAt: AT,
    agentId: 'casey-agent',
    agentPath: '/agents/casey',
    authorId: 'casey',
    runtime: 'claude-code',
    launchOrigin: null,
    requiredLaunchId: null,
  };
  const digest = createHash('sha256').update(stableStringify(facts)).digest('hex');
  return JSON.stringify({
    version: 2,
    evidence: {
      state: 'recorded-transfer',
      wordEvidence: 'recorded',
      sessionId: 'drafting-chat',
      turnSerial: 1,
    },
    source: { id: 'handoff-1', callerSessionId: 'drafting-chat', agentPath: '/agents/casey' },
    recipient: { ...facts, digest },
    seat: {
      roomId: 'room-1',
      authorId: 'casey',
      sessionId: 'seat',
      canonicalSessionId: 'seat',
      joinedAt: AT,
      agentPath: '/agents/casey',
    },
    enqueuedAt: 1000,
    waitDeadlineAt: 2000,
    carry: {
      externalAuthor: false,
      permissionCeiling,
      outsider: false,
      outsideWords: false,
      teammate: false,
    },
  });
}

describe('an empty ceiling is refused wherever a saved hand-off joins one', () => {
  it('the envelope decoder refuses a saved empty ceiling and keeps a real one', () => {
    expect(() => decodeHandoffEnvelope(envelopeJson([]))).toThrow();
    expect(decodeHandoffEnvelope(envelopeJson([READ_ASK])).carry.permissionCeiling).toEqual([
      READ_ASK,
    ]);
  });

  it('the replay join refuses an empty current ceiling and keeps the saved bound otherwise', () => {
    const saved = decodeHandoffEnvelope(envelopeJson(READ_ASK));
    expect(() =>
      joinHandoffCurrentCarry(saved, { externalAuthor: false, permissionCeiling: [] })
    ).toThrow('Empty current ceiling is unsupported.');
    // The join returns its bounds as a list that must all hold: here, just the saved one.
    expect(joinHandoffCurrentCarry(saved, { externalAuthor: false }).permissionCeiling).toEqual([
      READ_ASK,
    ]);
  });

  it('the protected notice join refuses an empty current ceiling and keeps the saved bound otherwise', () => {
    const saved = { externalAuthor: false, permissionCeiling: READ_ASK };
    expect(() => joinProtectedHandoffCarry({ permissionCeiling: [] }, saved)).toThrow(
      'Empty current ceiling is unsupported for handoff notices.'
    );
    expect(joinProtectedHandoffCarry({}, saved)?.permissionCeiling).toEqual([READ_ASK]);
    expect(joinProtectedHandoffCarry({ permissionCeiling: [] }, undefined)).toBeUndefined();
  });
});
