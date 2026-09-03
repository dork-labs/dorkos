import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import {
  applyPermissionDenials,
  overlayPermissionDenials,
} from '../overlays/permission-denial-overlay.js';
import { SessionEventStore, type RecordedPermissionDenial } from '../session-event-store.js';
import type { RawSessionEvent } from '../session-state-projector.js';
import {
  setSessionEventStore,
  disposeProjector,
  getOrCreateProjector,
} from '../session-state-projector.js';

// Purpose (DOR-795): a BACKGROUNDED subagent's tool call is auto-denied by the
// CLI and the refusal is written into the CHILD's transcript, which nobody
// opens. Without this overlay the parent conversation reopens showing an agent
// that quietly stopped making progress, with no reason anywhere.

afterEach(() => {
  setSessionEventStore(undefined);
  disposeProjector('sess');
  vi.restoreAllMocks();
});

/** One recorded denial, as the projector wrote it. */
function denial(
  seq: number,
  toolCallId: string,
  createdAt: string,
  extra: Partial<Extract<SessionEvent, { type: 'permission_denied' }>> = {}
): RecordedPermissionDenial {
  return {
    event: {
      seq,
      type: 'permission_denied',
      toolCallId,
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
      ...extra,
    } as Extract<SessionEvent, { type: 'permission_denied' }>,
    createdAt,
  };
}

/** An assistant history message, optionally carrying one tool call. */
function assistant(id: string, timestamp: string, toolCallId?: string): HistoryMessage {
  return {
    id,
    role: 'assistant',
    content: 'Working on it.',
    timestamp,
    ...(toolCallId !== undefined
      ? {
          toolCalls: [{ toolCallId, toolName: 'Bash', status: 'complete', input: '{}' }],
          parts: [
            { type: 'text', text: 'Working on it.' },
            { type: 'tool_call', toolCallId, toolName: 'Bash', status: 'complete', input: '{}' },
          ],
        }
      : {}),
  } as HistoryMessage;
}

describe('applyPermissionDenials', () => {
  it('adds a row for a denial the transcript has no tool call for', () => {
    // THE bug: the denied call is in a child transcript, so the parent history
    // that this overlay receives contains nothing about it at all.
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];

    const out = applyPermissionDenials(messages, [
      denial(7, 'toolu_async_1', '2026-09-01T10:00:05.000Z'),
    ]);

    expect(out).toHaveLength(2);
    expect(out[1].id).toBe('permission-denied-7');
    expect(out[1].parts).toEqual([
      {
        type: 'permission_denied',
        toolCallId: 'toolu_async_1',
        toolName: 'Bash',
        message: 'Backgrounded agents cannot request permission.',
        reasonType: 'asyncAgent',
        agentId: 'agent_child_7',
      },
    ]);
  });

  it('does NOT double-report a denial the transcript already shows', () => {
    // A main-thread classifier denial has its tool_use and its rejection
    // tool_result in the JSONL, so that row already tells the story.
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z', 'toolu_seen')];

    const out = applyPermissionDenials(messages, [
      denial(7, 'toolu_seen', '2026-09-01T10:00:05.000Z', { reasonType: 'classifier' }),
    ]);

    expect(out).toBe(messages);
  });

  it('places the denial in the transcript where it happened, not at the end', () => {
    const messages = [
      assistant('a-1', '2026-09-01T10:00:00.000Z'),
      assistant('a-2', '2026-09-01T12:00:00.000Z'),
    ];

    const out = applyPermissionDenials(messages, [
      denial(7, 'toolu_async_1', '2026-09-01T10:30:00.000Z'),
    ]);

    expect(out.map((m) => m.id)).toEqual(['a-1', 'permission-denied-7', 'a-2']);
  });

  it('keeps a denial dated after the whole transcript at the end', () => {
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];

    const out = applyPermissionDenials(messages, [
      denial(7, 'toolu_async_1', '2026-09-01T23:00:00.000Z'),
    ]);

    expect(out.map((m) => m.id)).toEqual(['a-1', 'permission-denied-7']);
  });

  it('appends when the transcript carries no timestamps to compare against', () => {
    // The parser omits `timestamp` for records that carry none. An undated
    // message must never displace a denial on its own.
    const messages = [{ id: 'a-1', role: 'assistant', content: 'hi' } as HistoryMessage];

    const out = applyPermissionDenials(messages, [
      denial(7, 'toolu_async_1', '2026-09-01T10:00:00.000Z'),
    ]);

    expect(out.map((m) => m.id)).toEqual(['a-1', 'permission-denied-7']);
  });

  it('returns history by reference when there is nothing to add', () => {
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];
    expect(applyPermissionDenials(messages, [])).toBe(messages);
  });
});

describe('overlayPermissionDenials', () => {
  it('survives a reload: the denial comes back from the durable store alone', () => {
    // The cold-open property, driven through the REAL seam — projector ingest,
    // `'record'` persistence, a real SQLite store — rather than a hand-built
    // row. No live client, no browser that remembers anything.
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest({
      type: 'permission_denied',
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    // The live projector is gone — this is a reopened conversation.
    disposeProjector('sess');

    const out = overlayPermissionDenials('sess', [assistant('a-1', '2026-09-01T10:00:00.000Z')]);

    expect(out).toHaveLength(2);
    const [part] = out[1].parts ?? [];
    expect(part).toMatchObject({
      type: 'permission_denied',
      toolName: 'Bash',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    });
  });

  it('survives a turn that NEVER ENDS — a denial beside a parked ask (DOR-1439 shape)', () => {
    // The review's reproduction. A backgrounded child refuses INSTEAD of asking
    // while the main thread parks on an ask of its own, so the turn can outlive
    // the process: no `turn_end`, no turn-granular flush. The ask row was always
    // on disk (it is eager); the denial was not, and reopening the session showed
    // the ask with no trace of the work that was silently lost.
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest({
      type: 'permission_denied',
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    } as RawSessionEvent);
    projector.ingest({
      type: 'approval_required',
      id: 'toolu_ask_1',
      toolName: 'Edit',
      input: '{}',
      hasSuggestions: false,
      startedAt: 1_700_000_000_000,
      remainingMs: 0,
    } as RawSessionEvent);
    // The process dies with the turn still open — never a `turn_end`.
    disposeProjector('sess');

    const out = overlayPermissionDenials('sess', [assistant('a-1', '2026-09-01T10:00:00.000Z')]);

    expect(out.filter((m) => m.id.startsWith('permission-denied-'))).toHaveLength(1);
  });

  it('does not draw a denial twice while its own turn is still open', () => {
    // The cost of writing eagerly: for the length of the turn one denial exists
    // both on the live stream (already folded into the streaming bubble) and as
    // a durable row. The open turn is read to SUBTRACT so it is drawn once.
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest({
      type: 'permission_denied',
      toolCallId: 'toolu_async_1',
      toolName: 'Bash',
      message: 'Backgrounded agents cannot request permission.',
      reasonType: 'asyncAgent',
      agentId: 'agent_child_7',
    } as RawSessionEvent);

    // Live: the bubble has it, so history must not.
    const live = overlayPermissionDenials('sess', [assistant('a-1', '2026-09-01T10:00:00.000Z')]);
    expect(live.filter((m) => m.id.startsWith('permission-denied-'))).toHaveLength(0);
    expect(
      projector.peekInProgressTurn()?.filter((e) => e.type === 'permission_denied')
    ).toHaveLength(1);

    // Turn closed, bubble rebuilt from history: now history is the one place it lives.
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    const settled = overlayPermissionDenials('sess', [
      assistant('a-1', '2026-09-01T10:00:00.000Z'),
    ]);
    expect(settled.filter((m) => m.id.startsWith('permission-denied-'))).toHaveLength(1);
  });

  it('a main-thread denial stays live-only, because the transcript anchors it', () => {
    // Intended, not incidental. A classifier or deny-rule refusal on the main
    // thread has its `tool_use` and its rejection `tool_result` in the JSONL, so
    // on reload the tool card carries the whole story — the chip is a live
    // extra, and re-adding it beside the card would report one refusal twice.
    // Only a denial the transcript CANNOT anchor becomes a durable row.
    const store = new SessionEventStore(createTestDb());
    setSessionEventStore(store);
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'go' } as RawSessionEvent);
    projector.ingest({
      type: 'permission_denied',
      toolCallId: 'toolu_main_1',
      toolName: 'Bash',
      message: 'Blocked by the safety classifier.',
      reasonType: 'classifier',
    } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    disposeProjector('sess');

    // The transcript DOES carry the call, so nothing is spliced.
    const anchored = [assistant('a-1', '2026-09-01T10:00:00.000Z', 'toolu_main_1')];
    expect(overlayPermissionDenials('sess', anchored)).toBe(anchored);
    // The row is on disk either way — the skip is a rendering decision here,
    // not a gap in the record.
    expect(store.readPermissionDenials('sess')).toHaveLength(1);
  });

  it('leaves history alone when the session was never refused anything', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];

    expect(overlayPermissionDenials('sess', messages)).toBe(messages);
  });

  it('works with no durable store wired at all', () => {
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];
    expect(overlayPermissionDenials('sess', messages)).toBe(messages);
  });

  it('hands back the conversation when the database is locked', () => {
    // Same contract as the receipt overlay: a SQLITE_BUSY on a machine running
    // several agents must cost the annotation, never a person's conversation.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setSessionEventStore({
      readPermissionDenials: () => {
        throw new Error('SQLITE_BUSY: database is locked');
      },
    } as unknown as SessionEventStore);
    const messages = [assistant('a-1', '2026-09-01T10:00:00.000Z')];

    expect(() => overlayPermissionDenials('sess', messages)).not.toThrow();
    expect(overlayPermissionDenials('sess', messages)).toBe(messages);
    warn.mockRestore();
  });
});
