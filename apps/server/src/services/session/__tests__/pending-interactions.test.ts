import { describe, it, expect } from 'vitest';
import type { QuestionItem } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { listPendingInteractions, type PendingInteractionEntry } from '../pending-interactions.js';

const TIMEOUT = SESSIONS.INTERACTION_TIMEOUT_MS;
const CEILING = SESSIONS.INTERACTION_PARK_CEILING_MS;

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
    // Inside its budget nothing about the first ten minutes moved: it counts
    // down against the budget it ships and is not parked.
    expect(dto.timeoutMs).toBe(TIMEOUT);
    expect(dto.parked).toBeUndefined();
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
    expect(dto.parked).toBeUndefined();
  });

  it('parks an interaction on its OWN budget, not the global one', () => {
    // The same disagreement at the boundary, now on the park: a short-budget
    // ask that has run its countdown out is waiting, not counting down, even
    // though the global clock still has nine minutes on it. Guards the DOR-810
    // regression from the other side (spec `ask-parks-on-timeout`).
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

    const dto = listPendingInteractions(interactions, startedAt + 180_000)[0];

    expect(dto.parked).toBe(true);
    expect(dto.timeoutMs).toBeUndefined();
    expect(dto.remainingMs).toBe(CEILING - 180_000);
  });

  it('falls back to the global budget for an interaction that declares none', () => {
    // Questions and elicitations ship no budget of their own; the server-wide
    // auto-deny is the honest answer for them.
    const interactions = makeInteractions([
      ['q-1', { type: 'question', startedAt: 1_000, snapshot: { questions: [] } } as const],
    ]);

    expect(listPendingInteractions(interactions, 61_000)[0].remainingMs).toBe(TIMEOUT - 60_000);
  });

  it('parks an interaction whose elapsed time equals the countdown exactly', () => {
    // Purpose: countdown boundary — at the budget the prompt stops counting
    // down and starts waiting, rather than being dropped as it once was.
    const startedAt = 5000;
    const interactions = makeInteractions([['call-1', approvalEntry(startedAt)]]);

    const dto = listPendingInteractions(interactions, startedAt + TIMEOUT)[0];

    expect(dto.parked).toBe(true);
    expect(dto.remainingMs).toBe(CEILING - TIMEOUT);
  });

  it('parks an interaction past its budget, drops its timeoutMs, and counts down to the ceiling', () => {
    // Purpose: the park. Eleven minutes in, the agent is waiting: the DTO says
    // so, ships no budget for a card to draw a bar against, and its remainder
    // runs to the park ceiling measured from `startedAt`.
    const startedAt = 5_000;
    const elapsed = 11 * 60_000;
    const interactions = makeInteractions([['call-1', approvalEntry(startedAt)]]);

    const dto = listPendingInteractions(interactions, startedAt + elapsed)[0];

    expect(dto.parked).toBe(true);
    expect(dto.timeoutMs).toBeUndefined();
    expect(dto.remainingMs).toBe(CEILING - elapsed);
  });

  it('excludes an interaction that elapsed past the park ceiling', () => {
    // Purpose: the bound that stops a STRANDED entry pausing the stall watchdog
    // and holding the session write-lock forever. The park widens that window;
    // it does not open it.
    const startedAt = 5000;
    const interactions = makeInteractions([['call-1', approvalEntry(startedAt)]]);

    expect(listPendingInteractions(interactions, startedAt + CEILING + 60_000)).toEqual([]);
    expect(listPendingInteractions(interactions, startedAt + CEILING)).toEqual([]);
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
