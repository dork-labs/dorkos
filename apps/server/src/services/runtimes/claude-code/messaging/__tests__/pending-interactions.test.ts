import { describe, it, expect } from 'vitest';
import type { QuestionItem } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../../config/constants.js';
import type { InteractiveSession, PendingInteraction } from '../interactive-handlers.js';
import { listPendingInteractions } from '../pending-interactions.js';

const TIMEOUT = SESSIONS.INTERACTION_TIMEOUT_MS;

/**
 * Build a minimal InteractiveSession from raw pending entries. The selector
 * only reads `pendingInteractions`, so resolve/reject/timeout/toolCallId are
 * cast away — we supply just `type`, `startedAt`, and `snapshot`.
 */
function makeSession(
  entries: Array<[string, Pick<PendingInteraction, 'type' | 'startedAt' | 'snapshot'>]>
): InteractiveSession {
  return {
    pendingInteractions: new Map(
      entries.map(([id, partial]) => [id, partial as unknown as PendingInteraction])
    ),
    eventQueue: [],
  };
}

const approvalEntry = (startedAt: number) =>
  ({
    type: 'approval',
    startedAt,
    snapshot: {
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      title: 'Run command',
      hasSuggestions: false,
    },
  }) as const;

describe('listPendingInteractions', () => {
  it('computes remainingMs from injected now and flattens the snapshot', () => {
    // Purpose: remainingMs math — server-authoritative countdown derived from now - startedAt.
    const session = makeSession([['call-1', approvalEntry(1000)]]);

    const dtos = listPendingInteractions(session, 61000);

    expect(dtos).toHaveLength(1);
    const dto = dtos[0];
    expect(dto.id).toBe('call-1');
    expect(dto.type).toBe('approval');
    expect(dto.startedAt).toBe(1000);
    expect(dto.remainingMs).toBe(TIMEOUT - 60000);
    // Flattened snapshot fields are present on the DTO.
    expect(dto).toMatchObject({
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      title: 'Run command',
      hasSuggestions: false,
    });
  });

  it('excludes an interaction whose elapsed time equals the timeout exactly', () => {
    // Purpose: expiry boundary exclusive — remainingMs === 0 is dropped.
    const startedAt = 5000;
    const session = makeSession([['call-1', approvalEntry(startedAt)]]);

    const dtos = listPendingInteractions(session, startedAt + TIMEOUT);

    expect(dtos).toEqual([]);
  });

  it('excludes an interaction that elapsed past the timeout', () => {
    // Purpose: expired never re-presented — overshooting the timeout stays excluded.
    const startedAt = 5000;
    const session = makeSession([['call-1', approvalEntry(startedAt)]]);

    const dtos = listPendingInteractions(session, startedAt + TIMEOUT + 60000);

    expect(dtos).toEqual([]);
  });

  it('returns an empty array when there are no pending interactions', () => {
    // Purpose: none-case — empty map yields empty list.
    const session = makeSession([]);

    expect(listPendingInteractions(session, 123456)).toEqual([]);
  });

  it('maps approval, question, and elicitation to their discriminated DTO shapes', () => {
    // Purpose: all three types — each branch produces the correct discriminated DTO.
    const startedAt = 1000;
    const now = 1000; // remainingMs === TIMEOUT for all, none expired.

    const questions: QuestionItem[] = [
      { question: 'Pick one', options: ['a', 'b'] } as unknown as QuestionItem,
    ];

    const session = makeSession([
      ['approval-id', approvalEntry(startedAt)],
      ['question-id', { type: 'question', startedAt, snapshot: { questions } } as const],
      [
        'elicitation-id',
        {
          type: 'elicitation',
          startedAt,
          snapshot: {
            serverName: 'mcp-server',
            message: 'Provide a value',
            mode: 'form',
            elicitationId: 'elicit-1',
            requestedSchema: { type: 'object' },
          },
        } as const,
      ],
    ]);

    const dtos = listPendingInteractions(session, now);

    expect(dtos).toHaveLength(3);
    const byId = Object.fromEntries(dtos.map((d) => [d.id, d]));

    const approval = byId['approval-id'];
    expect(approval).toMatchObject({
      type: 'approval',
      id: 'approval-id',
      startedAt,
      remainingMs: TIMEOUT,
      toolName: 'Bash',
      hasSuggestions: false,
    });

    const question = byId['question-id'];
    expect(question).toMatchObject({
      type: 'question',
      id: 'question-id',
      startedAt,
      remainingMs: TIMEOUT,
      questions,
    });

    const elicitation = byId['elicitation-id'];
    expect(elicitation).toMatchObject({
      type: 'elicitation',
      id: 'elicitation-id',
      startedAt,
      remainingMs: TIMEOUT,
      serverName: 'mcp-server',
      message: 'Provide a value',
      mode: 'form',
      elicitationId: 'elicit-1',
      requestedSchema: { type: 'object' },
    });
  });
});
