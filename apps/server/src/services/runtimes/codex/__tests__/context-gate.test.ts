/**
 * The Codex context gate (DOR-477) — which half of the runtime-neutral append a
 * turn owes, and when that debt is considered paid.
 *
 * The adapter-level proof that a resumed Codex turn stops repeating the identity
 * blocks lives in `agent-context.test.ts`, which drives the real runtime. This
 * file pins the two properties that file cannot reach: the digest is taken over
 * the STABLE half only, and nothing is recorded until the caller says the prompt
 * was actually dispatched.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { AgentContextAppend } from '../../shared/agent-context.js';
import { CodexContextGate } from '../context-gate.js';

/** An append with a given stable half and memory block. */
function append(stable: string, memory = ''): AgentContextAppend {
  return { stable, memory, text: [stable, memory].filter(Boolean).join('\n\n') };
}

describe('CodexContextGate', () => {
  it('sends the whole append the first time a session asks', () => {
    const gate = new CodexContextGate();
    const selection = gate.select('s1', append('<agent_identity>who</agent_identity>'));

    expect(selection.text).toContain('<agent_identity>');
  });

  it('sends only the memory block once the thread holds the stable half', () => {
    const gate = new CodexContextGate();
    const first = gate.select('s1', append('<agent_identity>who</agent_identity>', '<mem>a</mem>'));
    first.commit();

    const second = gate.select(
      's1',
      append('<agent_identity>who</agent_identity>', '<mem>b</mem>')
    );

    // The notes the agent wrote between the two turns, and nothing it already has.
    expect(second.text).toBe('<mem>b</mem>');
  });

  it('ignores the memory block when deciding, so saving a note never re-anchors', () => {
    // The digest must be taken over `stable` alone. Digesting `text` would let
    // agent-written bytes — which are room-influenceable — decide when the
    // identity blocks are re-sent, the same boundary `agent-context.ts` refuses
    // to let them move.
    const gate = new CodexContextGate();
    gate.select('s1', append('<agent_identity>who</agent_identity>', '<mem>a</mem>')).commit();

    const next = gate.select('s1', append('<agent_identity>who</agent_identity>', '<mem>b</mem>'));

    expect(next.text).not.toContain('<agent_identity>');
  });

  it('re-anchors when the stable half itself changed', () => {
    const gate = new CodexContextGate();
    gate.select('s1', append('<agent_identity>who</agent_identity>')).commit();

    const edited = gate.select('s1', append('<agent_identity>somebody else</agent_identity>'));

    expect(edited.text).toContain('somebody else');
  });

  it('records nothing until the caller commits', () => {
    // The turn that threw on the way to Codex. Its prompt never landed in the
    // rollout, so the next turn still owes the whole append.
    const gate = new CodexContextGate();
    gate.select('s1', append('<agent_identity>who</agent_identity>')); // dispatch failed

    const retry = gate.select('s1', append('<agent_identity>who</agent_identity>'));

    expect(retry.text).toContain('<agent_identity>');
  });

  it('keeps one session out of another session thread', () => {
    const gate = new CodexContextGate();
    gate.select('s1', append('<agent_identity>who</agent_identity>')).commit();

    expect(gate.select('s2', append('<agent_identity>who</agent_identity>')).text).toContain(
      '<agent_identity>'
    );
  });

  it('re-anchors a session it was told to forget', () => {
    const gate = new CodexContextGate();
    gate.select('s1', append('<agent_identity>who</agent_identity>')).commit();

    gate.forget('s1');

    expect(gate.select('s1', append('<agent_identity>who</agent_identity>')).text).toContain(
      '<agent_identity>'
    );
  });
});
