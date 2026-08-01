import { describe, it, expect } from 'vitest';
import type { QuestionItem } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { listPendingInteractions, type PendingInteractionEntry } from '../pending-interactions.js';

const TIMEOUT = SESSIONS.INTERACTION_TIMEOUT_MS;

/** Build the interactions map the selector reads from raw pending entries. */
function makeInteractions(
  entries: Array<[string, PendingInteractionEntry]>
): Map<string, PendingInteractionEntry> {
  return new Map(entries);
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
    const interactions = makeInteractions([['call-1', approvalEntry(1000)]]);

    const dtos = listPendingInteractions(interactions, 61000);

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

  it('measures the remainder against the interaction OWN budget, not the global one', () => {
    // DOR-810. The DTO carries the budget the raising runtime declared, and the
    // card draws its bar against that — so a remainder measured against the
    // global constant contradicts the very field it ships beside it. Measured
    // in a browser before this was fixed: a 120s ask announced "9 minutes 22
    // seconds remaining" and rendered aria-valuenow=562 against valuemax=120.
    const startedAt = 1_000;
    const ownBudget = 120_000;
    const interactions = makeInteractions([
      [
        'call-1',
        {
          type: 'approval',
          startedAt,
          snapshot: { toolName: 'Bash', input: '{}', hasSuggestions: false, timeoutMs: ownBudget },
        } as const,
      ],
    ]);

    const dto = listPendingInteractions(interactions, startedAt + 60_000)[0];

    expect(dto.remainingMs).toBe(60_000);
    expect(dto).toMatchObject({ timeoutMs: ownBudget });
  });

  it('expires an interaction on its OWN budget, not the global one', () => {
    // The same disagreement at the boundary: a short-budget ask that has run
    // out must not be re-presented just because the global clock has time left.
    const startedAt = 1_000;
    const interactions = makeInteractions([
      [
        'call-1',
        {
          type: 'approval',
          startedAt,
          snapshot: { toolName: 'Bash', input: '{}', hasSuggestions: false, timeoutMs: 120_000 },
        } as const,
      ],
    ]);

    expect(listPendingInteractions(interactions, startedAt + 120_000)).toEqual([]);
  });

  it('falls back to the global budget for an interaction that declares none', () => {
    // Questions and elicitations ship no budget of their own; the server-wide
    // auto-deny is the honest answer for them.
    const interactions = makeInteractions([
      ['q-1', { type: 'question', startedAt: 1_000, snapshot: { questions: [] } } as const],
    ]);

    expect(listPendingInteractions(interactions, 61_000)[0].remainingMs).toBe(TIMEOUT - 60_000);
  });

  it('excludes an interaction whose elapsed time equals the timeout exactly', () => {
    // Purpose: expiry boundary exclusive — remainingMs === 0 is dropped.
    const startedAt = 5000;
    const interactions = makeInteractions([['call-1', approvalEntry(startedAt)]]);

    const dtos = listPendingInteractions(interactions, startedAt + TIMEOUT);

    expect(dtos).toEqual([]);
  });

  it('excludes an interaction that elapsed past the timeout', () => {
    // Purpose: expired never re-presented — overshooting the timeout stays excluded.
    const startedAt = 5000;
    const interactions = makeInteractions([['call-1', approvalEntry(startedAt)]]);

    const dtos = listPendingInteractions(interactions, startedAt + TIMEOUT + 60000);

    expect(dtos).toEqual([]);
  });

  it('returns an empty array when there are no pending interactions', () => {
    // Purpose: none-case — empty map yields empty list.
    const interactions = makeInteractions([]);

    expect(listPendingInteractions(interactions, 123456)).toEqual([]);
  });

  it('maps approval, question, and elicitation to their discriminated DTO shapes', () => {
    // Purpose: all three types — each branch produces the correct discriminated DTO.
    const startedAt = 1000;
    const now = 1000; // remainingMs === TIMEOUT for all, none expired.

    const questions: QuestionItem[] = [
      { question: 'Pick one', options: ['a', 'b'] } as unknown as QuestionItem,
    ];

    const interactions = makeInteractions([
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

    const dtos = listPendingInteractions(interactions, now);

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
