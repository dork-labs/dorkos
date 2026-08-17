import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import {
  collectApprovalReceipts,
  applyApprovalReceipts,
  overlayApprovalReceipts,
} from '../approval-receipt-overlay.js';
import { SessionEventStore } from '../session-event-store.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import {
  setSessionEventStore,
  disposeProjector,
  getOrCreateProjector,
} from '../session-state-projector.js';

// Purpose: a permission prompt is asked and answered entirely inside DorkOS, so
// a runtime that derives its history from its own transcript (claude-code, from
// SDK JSONL) can never report one. This overlay is what puts the answers back
// on reopening — and what must stay silent when there are none.

/** One resolved approval, as the projector records it. */
function resolved(
  id: string,
  resolution: 'approved' | 'denied' | 'expired' | 'cancelled',
  extra: Partial<Extract<SessionEvent, { type: 'interaction_resolved' }>> = {}
): SessionEvent {
  return {
    seq: 3,
    type: 'interaction_resolved',
    id,
    kind: 'approval',
    resolution,
    at: 1_700_000_005_000,
    startedAt: 1_700_000_000_000,
    ...extra,
  } as SessionEvent;
}

/** The same resolution as an adapter hands it to `ingest` (no seq yet). */
function resolvedRaw(id: string, resolution: 'approved' | 'denied'): RawSessionEvent {
  const { seq: _seq, ...rest } = resolved(id, resolution) as Extract<
    SessionEvent,
    { type: 'interaction_resolved' }
  >;
  return rest as RawSessionEvent;
}

/** An assistant history message carrying one tool call, in both shapes. */
function assistantWithTool(toolCallId: string): HistoryMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: 'Running it.',
    toolCalls: [{ toolCallId, toolName: 'Bash', status: 'complete', input: '{}' }],
    parts: [
      { type: 'text', text: 'Running it.' },
      { type: 'tool_call', toolCallId, toolName: 'Bash', status: 'complete', input: '{}' },
    ],
  };
}

afterEach(() => {
  setSessionEventStore(undefined);
  disposeProjector('sess');
});

describe('collectApprovalReceipts', () => {
  it('indexes an answered approval by the tool call it gated', () => {
    const receipts = collectApprovalReceipts([resolved('tc-1', 'approved')]);

    expect(receipts.get('tc-1')).toEqual({
      outcome: 'allowed',
      resolvedAt: 1_700_000_005_000,
      startedAt: 1_700_000_000_000,
    });
  });

  it('ignores a withdrawn APPROVAL — nobody answered it', () => {
    const receipts = collectApprovalReceipts([resolved('tc-1', 'cancelled')]);

    expect(receipts.size).toBe(0);
  });

  it('indexes a resolved QUESTION under its own outcome, not an approval one', () => {
    // A question earns a record for a different reason than an approval does
    // (DOR-1293): the question is already drawn in the transcript, so an ending
    // nobody records leaves it reading as answered. It must NOT arrive wearing
    // `approvalOutcome`, which is what draws "Expired — denied" over a question
    // nobody was asked to approve.
    const receipts = collectApprovalReceipts([resolved('tc-2', 'expired', { kind: 'question' })]);

    expect(receipts.get('tc-2')).toMatchObject({ questionOutcome: 'expired' });
    expect(receipts.get('tc-2')?.outcome).toBeUndefined();
  });

  it('keeps the LAST answer when an id resolves twice', () => {
    const receipts = collectApprovalReceipts([
      resolved('tc-1', 'expired'),
      resolved('tc-1', 'approved', { seq: 9, at: 1_700_000_009_000 }),
    ]);

    expect(receipts.get('tc-1')?.outcome).toBe('allowed');
    expect(receipts.get('tc-1')?.resolvedAt).toBe(1_700_000_009_000);
  });
});

describe('applyApprovalReceipts', () => {
  it('writes the answer onto both shapes of the tool call', () => {
    const [message] = applyApprovalReceipts(
      [assistantWithTool('tc-1')],
      collectApprovalReceipts([resolved('tc-1', 'denied')])
    );

    expect(message.toolCalls?.[0]).toMatchObject({
      approvalOutcome: 'denied',
      approvalResolvedAt: 1_700_000_005_000,
      approvalStartedAt: 1_700_000_000_000,
    });
    // `interactiveType` is what marks the part as a permission prompt at all —
    // carrying the outcome without it restores the data and none of the display.
    expect(message.parts?.[1]).toMatchObject({
      type: 'tool_call',
      interactiveType: 'approval',
      approvalOutcome: 'denied',
    });
  });

  it('returns untouched messages by reference', () => {
    // A history reload must not invalidate the whole transcript's rendering to
    // annotate one tool call.
    const untouched = assistantWithTool('other');
    const messages = [untouched, assistantWithTool('tc-1')];

    const result = applyApprovalReceipts(
      messages,
      collectApprovalReceipts([resolved('tc-1', 'approved')])
    );

    expect(result[0]).toBe(untouched);
    expect(result[1]).not.toBe(messages[1]);
  });

  it('leaves history exactly as it was when nothing was ever asked', () => {
    const messages = [assistantWithTool('tc-1')];
    expect(applyApprovalReceipts(messages, new Map())).toBe(messages);
  });
});

describe('overlayApprovalReceipts', () => {
  it('restores the answers from the durable store on a cold read', () => {
    // THE cold-open property, server side: no live projector, no browser that
    // remembers anything — only the rows the turn left behind.
    const store = new SessionEventStore(createTestDb());
    store.appendTurn('sess', [
      { seq: 1, type: 'turn_start', userMessage: 'run it' } as SessionEvent,
      resolved('tc-1', 'approved'),
      { seq: 4, type: 'turn_end' } as SessionEvent,
    ]);
    setSessionEventStore(store);

    const [message] = overlayApprovalReceipts('sess', [assistantWithTool('tc-1')]);

    expect(message.toolCalls?.[0].approvalOutcome).toBe('allowed');
  });

  it('leaves history unannotated when the session has no recorded answers', () => {
    // Old sessions, pruned rows, a session nobody was ever asked about: history
    // is simply unannotated. Never an error, never an invented receipt.
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const messages = [assistantWithTool('tc-1')];

    expect(overlayApprovalReceipts('sess', messages)).toBe(messages);
  });

  it('works with no durable store wired at all', () => {
    const messages = [assistantWithTool('tc-1')];
    expect(overlayApprovalReceipts('sess', messages)).toBe(messages);
  });

  it('hands back the conversation when the database is locked', () => {
    // This runs on a path that was a pure JSONL read before it existed, and it
    // feeds BOTH the /messages route and the cold-open snapshot. SQLITE_BUSY is
    // an ordinary event on a machine running several agents against one
    // ~/.dork/dork.db — it must cost the annotations and nothing else, or a
    // locked database empties a person's conversation.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSessionEventStore({
      readInteractionResolutions: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    } as unknown as SessionEventStore);
    const messages = [assistantWithTool('tc-1')];

    expect(() => overlayApprovalReceipts('sess', messages)).not.toThrow();
    expect(overlayApprovalReceipts('sess', messages)).toBe(messages);
    warn.mockRestore();
  });

  it('reads the OPEN turn, so an answer given this turn is not waited on', () => {
    // Rows reach the store when a turn ENDS. A reload fired mid-turn (a session
    // settling to `blocked` with a second request still pending) has to see the
    // answers already given, and they exist only on the live projector.
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess');
    projector.ingest({ type: 'turn_start', userMessage: 'run it' } as RawSessionEvent);
    projector.ingest(resolvedRaw('tc-1', 'approved'));

    const [message] = overlayApprovalReceipts('sess', [assistantWithTool('tc-1')]);

    expect(message.toolCalls?.[0].approvalOutcome).toBe('allowed');
  });
});
