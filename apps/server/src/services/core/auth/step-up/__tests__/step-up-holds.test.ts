/**
 * The actions waiting on a step-up (DOR-3234): bound to one action, two
 * minutes, single use, and a statement that can never pass for the relay's
 * approval statement, nor the reverse.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepUpStatementV1Schema } from '@dork-labs/cloud-api';
import { STEP_UP_MAX_PASSWORD_TRIES, STEP_UP_TTL_MS } from '@dorkos/shared/step-up';

import {
  issueApprovalChallenge,
  newApprovalChallengeBook,
} from '../../../session-relay/approval-challenges.js';
import {
  MAX_HELD_STEP_UPS,
  cancelHeldStepUp,
  holdStepUp,
  parseLocalStepUpStatement,
  peekHeldStepUp,
  resetHeldStepUpsForTests,
  spendStepUpTry,
  stepUpActionHash,
  takeHeldStepUp,
  type StepUpActionInput,
} from '../step-up-holds.js';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');

function action(overrides: Partial<StepUpActionInput> = {}): StepUpActionInput {
  return {
    kind: 'mcp-server.allow-global',
    target: 'github',
    input: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    reason: 'Confirm it’s you to add github for all your agents.',
    commit: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    ...overrides,
  };
}

/** A real relay approval statement, as this computer issues one. */
function relayStatement() {
  const book = newApprovalChallengeBook();
  const issued = issueApprovalChallenge(book, {
    pin: {
      computerId: 'computer-1',
      computerName: 'Studio Mac',
      hubOrigin: 'https://me.dorkos.test',
    },
    keys: {
      v: 1,
      rpId: 'me.dorkos.test',
      origin: 'https://me.dorkos.test',
      userHandle: 'dXNlcg',
      keys: [
        {
          credentialId: 'Y3JlZGVudGlhbC0x',
          cosePublicKey: 'a2V5',
          alg: -7,
          signCount: 0,
          label: 'Passkey 1',
          addedAt: '2026-10-19T10:00:00.000Z',
        },
      ],
    } as Parameters<typeof issueApprovalChallenge>[1]['keys'],
    sessionId: '0b5e8a52-3c1d-4f6a-9e2b-7d4c1a9f0e33',
    toolCallId: 'tool-1',
    decision: 'approve',
    pending: { toolName: 'Bash', input: '{"command":"ls"}' },
    now: new Date(NOW),
  });
  if (!issued.ok) throw new Error('no relay challenge');
  return [...book.live.values()][0]!.statement;
}

afterEach(() => resetHeldStepUpsForTests());

describe('holdStepUp', () => {
  it('binds a statement to the action’s kind, target and input, for two minutes', () => {
    const statement = holdStepUp(action(), 'session-a', NOW);
    expect(statement).toMatchObject({
      t: 'dorkos.local.step-up.v1',
      purpose: 'step-up',
      kind: 'mcp-server.allow-global',
      target: 'github',
      inputSha256: stepUpActionHash(action()),
      issuedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + STEP_UP_TTL_MS).toISOString(),
    });
    expect(parseLocalStepUpStatement(statement)).toEqual(statement);
  });

  it('hashes a different input, target or kind differently', () => {
    const base = stepUpActionHash(action());
    expect(stepUpActionHash(action({ input: { command: 'npx', args: ['-y', 'other'] } }))).not.toBe(
      base
    );
    expect(stepUpActionHash(action({ target: 'gitlab' }))).not.toBe(base);
    expect(stepUpActionHash(action({ kind: 'own-browser.add-site' }))).not.toBe(base);
  });

  it('refuses an input that is not plain JSON, rather than binding part of it', () => {
    expect(() => holdStepUp(action({ input: { when: new Date() } }), 'session-a', NOW)).toThrow(
      /cannot be bound/
    );
  });

  it('replaces the same action held again by the same browser, and only that', () => {
    const first = holdStepUp(action(), 'session-a', NOW);
    const other = holdStepUp(action(), 'session-b', NOW);
    const second = holdStepUp(action(), 'session-a', NOW);
    expect(peekHeldStepUp(first.heldActionId, NOW)).toBeUndefined();
    expect(peekHeldStepUp(second.heldActionId, NOW)).toBeDefined();
    expect(peekHeldStepUp(other.heldActionId, NOW)).toBeDefined();
  });

  it('drops the oldest once too many are held', () => {
    const first = holdStepUp(action({ target: 't-0' }), 'session-a', NOW);
    for (let i = 1; i <= MAX_HELD_STEP_UPS; i++) {
      holdStepUp(action({ target: `t-${i}` }), 'session-a', NOW);
    }
    expect(peekHeldStepUp(first.heldActionId, NOW)).toBeUndefined();
  });
});

describe('a held action', () => {
  it('expires after two minutes', () => {
    const { heldActionId } = holdStepUp(action(), 'session-a', NOW);
    expect(peekHeldStepUp(heldActionId, NOW + STEP_UP_TTL_MS - 1)).toBeDefined();
    expect(peekHeldStepUp(heldActionId, NOW + STEP_UP_TTL_MS)).toBeUndefined();
    expect(takeHeldStepUp(heldActionId, NOW)).toBeUndefined();
  });

  it('can be taken once', () => {
    const { heldActionId } = holdStepUp(action(), 'session-a', NOW);
    expect(takeHeldStepUp(heldActionId, NOW)).toBeDefined();
    expect(takeHeldStepUp(heldActionId, NOW)).toBeUndefined();
  });

  it('is dropped on its last wrong password', () => {
    const { heldActionId } = holdStepUp(action(), 'session-a', NOW);
    for (let left = STEP_UP_MAX_PASSWORD_TRIES - 1; left > 0; left--) {
      expect(spendStepUpTry(heldActionId)).toBe(left);
    }
    expect(spendStepUpTry(heldActionId)).toBe(0);
    expect(peekHeldStepUp(heldActionId, NOW)).toBeUndefined();
  });

  it('is gone after a cancel, and its commit never ran', () => {
    const held = action();
    const { heldActionId } = holdStepUp(held, 'session-a', NOW);
    cancelHeldStepUp(heldActionId);
    expect(peekHeldStepUp(heldActionId, NOW)).toBeUndefined();
    expect(held.commit).not.toHaveBeenCalled();
  });
});

// Security's rule (10-22): each verifier refuses the other's statement, tested both ways.
describe('domain separation from the relay’s approval statement', () => {
  it('a relay approval statement is not a local step-up statement', () => {
    const relay = relayStatement();
    expect(StepUpStatementV1Schema.safeParse(relay).success).toBe(true);
    expect(parseLocalStepUpStatement(relay)).toBeNull();
    // Even dressed with the local fields, it is still refused.
    expect(
      parseLocalStepUpStatement({ ...relay, purpose: 'step-up', heldActionId: relay.challengeId })
    ).toBeNull();
  });

  it('a local step-up statement is not a relay approval statement', () => {
    const local = holdStepUp(action(), 'session-a', NOW);
    expect(StepUpStatementV1Schema.safeParse(local).success).toBe(false);
    const relay = relayStatement();
    // Nor is it one with the relay's own type written over it.
    expect(StepUpStatementV1Schema.safeParse({ ...local, t: relay.t }).success).toBe(false);
  });

  it('refuses a statement with the right type and the wrong purpose', () => {
    const local = holdStepUp(action(), 'session-a', NOW);
    expect(parseLocalStepUpStatement({ ...local, purpose: 'relay-approval' })).toBeNull();
  });
});
