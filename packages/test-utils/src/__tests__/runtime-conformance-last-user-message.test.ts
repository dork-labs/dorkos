/**
 * Proof that the conformance suite's `Session.lastUserMessageAt` gate can FAIL.
 *
 * The suite only ever runs against adapters that are supposed to pass, so a
 * green conformance run is no evidence these rules fired — the same blind spot
 * that let a claude-code case report 21/21 while asserting nothing (DOR-1085).
 * These tests drive the exported evaluators directly with the sessions a wrong
 * implementation would produce: the field missing, the field relabelled from
 * `updatedAt`, the field set to a null-ish placeholder by a runtime that said it
 * could not answer.
 *
 * Nothing here re-implements the rules; the suite calls the same three
 * functions (spec `sidebar-now-today-library` BC-16).
 */
import { describe, expect, it } from 'vitest';
import type { Session } from '@dorkos/shared/types';
import {
  chooseLastUserMessageAtArm,
  evaluateLastUserMessageAtOmission,
  evaluateLastUserMessageAtPresence,
} from '../runtime-conformance.js';

/** The conversation shape the presence probe must produce: person, then agent. */
const PERSON_WROTE_AT = '2026-03-01T09:00:00.000Z';
const AGENT_STOPPED_AT = '2026-03-01T11:00:00.000Z';

/** A Session in the shape a runtime returns, with the field under test overridable. */
function session(overrides: Partial<Session> = {}): Session {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'conformance',
    createdAt: '2026-03-01T08:00:00.000Z',
    updatedAt: AGENT_STOPPED_AT,
    permissionMode: 'default',
    runtime: 'fake',
    lastUserMessageAt: PERSON_WROTE_AT,
    ...overrides,
  };
}

describe('choosing an arm', () => {
  it('accepts a runtime that supplies the field', () => {
    expect(chooseLastUserMessageAtArm(true, undefined)).toBeNull();
  });

  it('accepts a runtime that declares in a sentence why it cannot', () => {
    expect(chooseLastUserMessageAtArm(false, 'the SDK exposes no thread read API')).toBeNull();
  });

  it('rejects a runtime that chose neither', () => {
    expect(chooseLastUserMessageAtArm(false, undefined)).toMatch(/must either supply/);
  });

  it('rejects whitespace as a declaration', () => {
    // Same rule as autonomyDefaultReason: the waiver is a sentence somebody
    // wrote, not a flag somebody flipped.
    expect(chooseLastUserMessageAtArm(false, '   \n ')).toMatch(/must either supply/);
  });

  it('rejects a runtime that both supplies the field and claims it cannot', () => {
    expect(chooseLastUserMessageAtArm(true, 'no thread read API')).toMatch(/Pick one/);
  });
});

describe('the presence half', () => {
  it('accepts a real instant that precedes the agent’s last write', () => {
    expect(evaluateLastUserMessageAtPresence(session())).toBeNull();
  });

  it('rejects a runtime that reports nothing after declaring it can', () => {
    expect(evaluateLastUserMessageAtPresence(session({ lastUserMessageAt: undefined }))).toMatch(
      /reports nothing/
    );
  });

  it('rejects `updatedAt` returned under a second name', () => {
    // The defect this whole gate exists for: a field that is really the row's
    // mtime moves every time the AGENT writes, which is exactly the reordering
    // BC-16 forbids.
    expect(
      evaluateLastUserMessageAtPresence(session({ lastUserMessageAt: AGENT_STOPPED_AT }))
    ).toMatch(/not EARLIER than updatedAt/);
  });

  it('rejects a reading LATER than updatedAt', () => {
    expect(
      evaluateLastUserMessageAtPresence(session({ lastUserMessageAt: '2026-03-01T12:00:00.000Z' }))
    ).toMatch(/not EARLIER than updatedAt/);
  });

  it('rejects a probe fixture with no agent activity after the person’s turn', () => {
    // Not a runtime defect but a test-design one: such a fixture cannot tell a
    // real derivation apart from a rename, so it fails rather than passing.
    expect(
      evaluateLastUserMessageAtPresence(
        session({ lastUserMessageAt: PERSON_WROTE_AT, updatedAt: PERSON_WROTE_AT })
      )
    ).toMatch(/not EARLIER than updatedAt/);
  });

  it('rejects a value that is not a date', () => {
    expect(evaluateLastUserMessageAtPresence(session({ lastUserMessageAt: 'recently' }))).toMatch(
      /is not a date/
    );
  });
});

describe('the omission half', () => {
  const reason = 'the SDK exposes no thread read API';

  it('accepts a runtime that says nothing', () => {
    expect(
      evaluateLastUserMessageAtOmission(session({ lastUserMessageAt: undefined }), reason)
    ).toBeNull();
  });

  it('rejects a placeholder from a runtime that declared it cannot answer', () => {
    expect(evaluateLastUserMessageAtOmission(session({ lastUserMessageAt: '' }), reason)).toMatch(
      /but reported/
    );
  });

  it('rejects a null smuggled in where the field should be absent', () => {
    expect(
      evaluateLastUserMessageAtOmission(
        session({ lastUserMessageAt: null as unknown as undefined }),
        reason
      )
    ).toMatch(/but reported/);
  });

  it('rejects `updatedAt` quietly filling the gap', () => {
    expect(
      evaluateLastUserMessageAtOmission(session({ lastUserMessageAt: AGENT_STOPPED_AT }), reason)
    ).toMatch(/but reported/);
  });

  it('rejects a null session — a completed turn it cannot resolve asserts nothing', () => {
    expect(evaluateLastUserMessageAtOmission(null, reason)).toMatch(/asserted nothing/);
  });
});
