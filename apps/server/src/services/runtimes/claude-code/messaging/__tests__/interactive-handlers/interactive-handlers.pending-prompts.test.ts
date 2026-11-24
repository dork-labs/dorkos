/**
 * interactive-handlers: pending prompts. Shared setup lives in `./interactive-handlers.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleAskUserQuestion,
  handleElicitation,
  handleToolApproval,
  type ToolApprovalContext,
} from '../../interactive-handlers.js';
import { toRawSessionEvent } from '../../../../../session/session-event-normalizer.js';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import { COUNTDOWN_MS, CEILING_MS, makeBareSession } from './interactive-handlers.fixtures.js';

describe('pending interaction snapshots', () => {
  it('captures an approval snapshot at registration', () => {
    // Purpose: snapshot captured at registration carries the serializable
    // approval payload (toolName, JSON-stringified input, hasSuggestions).
    const session = makeBareSession();
    const context: ToolApprovalContext = {
      signal: new AbortController().signal,
      toolUseID: 'tool-approval-1',
    };

    // Fire-and-forget: the returned promise stays pending until the user responds.
    void handleToolApproval(session, 'tool-approval-1', 'Bash', { command: 'ls' }, context);

    const pending = session.pendingInteractions.get('tool-approval-1');
    expect(pending?.type).toBe('approval');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toMatchObject({
      toolName: 'Bash',
      input: JSON.stringify({ command: 'ls' }),
      hasSuggestions: false,
    });
  });

  it('pushes a LIVE question_prompt event carrying a real deadline, not remainingMs: 0 (DOR-1323)', () => {
    // Flag-on finding: a live question_prompt reached the client with
    // remainingMs: 0 while the recovery snapshot for the SAME interaction
    // carried the real countdown. `handleToolApproval` pushes both
    // `startedAt`/`timeoutMs` on the event `data` — the normalizer
    // (`toQuestionEvent` in session-event-normalizer.ts) falls back to
    // `remainingMs ?? timeoutMs ?? 0`, so a question missing BOTH landed dead on
    // arrival. This handler was the one that omitted them. (All three handlers
    // stamp the pair now; the elicitation's own case is below.)
    const session = makeBareSession();
    const questions: QuestionItem[] = [
      {
        header: 'Pick',
        question: 'Which one?',
        multiSelect: false,
        options: [{ label: 'A', description: 'first' }],
      },
    ];

    void handleAskUserQuestion(session, 'question-1', { questions });

    const pushed = session.eventQueue.find((e) => e.type === 'question_prompt');
    expect(pushed?.type).toBe('question_prompt');
    const data = pushed?.data as { startedAt?: number; timeoutMs?: number } | undefined;
    expect(typeof data?.startedAt).toBe('number');
    // The budget itself — this is what the normalizer's fallback needs present
    // to compute a nonzero `remainingMs` on the live event. `0`, `undefined`,
    // or absent all reproduce the flag-on symptom.
    expect(data?.timeoutMs).toBeGreaterThan(0);

    // …and through the seam the client actually reads. Asserting only on the
    // raw `eventQueue` payload stops one hop short: the normalizer is what
    // decides which of those fields reach the durable member, and it silently
    // dropped `timeoutMs` for questions while keeping it for approvals — so the
    // raw event could be perfect and the card still land anchored to nothing
    // (DOR-1442).
    const member = toRawSessionEvent(pushed as StreamEvent);
    expect(member).toMatchObject({
      type: 'question_prompt',
      id: 'question-1',
      startedAt: data?.startedAt,
      timeoutMs: data?.timeoutMs,
    });
    // The countdown is a real one, anchored at the start rather than counting
    // from whenever the card happened to be built.
    expect(member).not.toBeNull();
    const timed = member as unknown as { remainingMs: number };
    expect(timed.remainingMs).toBeGreaterThan(0);
  });

  it('fills multiSelect and header on a LIVE question the model sent without them (DOR-2075)', () => {
    // The model's raw input can omit both. Cast straight through, the live
    // question_prompt failed the client's schema and never showed, and the
    // parked notice and snapshot read `multiSelect` as undefined.
    const session = makeBareSession();
    const rawQuestions = [{ question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }];

    void handleAskUserQuestion(session, 'question-live-defaults', { questions: rawQuestions });

    const pushed = session.eventQueue.find((e) => e.type === 'question_prompt');
    const data = pushed?.data as { questions?: QuestionItem[] } | undefined;
    expect(data?.questions?.[0]).toMatchObject({ multiSelect: false, header: '' });

    const member = toRawSessionEvent(pushed as StreamEvent) as unknown as {
      questions?: QuestionItem[];
    };
    expect(member.questions?.[0]).toMatchObject({ multiSelect: false, header: '' });

    const snapshot = session.pendingInteractions.get('question-live-defaults')?.snapshot as
      { questions?: QuestionItem[] } | undefined;
    expect(snapshot?.questions?.[0]).toMatchObject({ multiSelect: false, header: '' });
  });

  it('cancels a pending question when the SDK aborts it (F5 — steer/interrupt)', async () => {
    // Acceptance run 20260610-173202, F5: a mid-turn steered message cancels a
    // pending AskUserQuestion SDK-side. This handler had NO abort wiring, so
    // the record lingered for the full 10-minute expiry and a refresh
    // resurrected an answerable ghost card. The abort must clear the record,
    // deny the SDK promise, and push an interaction_cancelled event so every
    // projection drops the card.
    const session = makeBareSession();
    const abort = new AbortController();
    const questions: QuestionItem[] = [
      { header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A' }] },
    ];

    const result = handleAskUserQuestion(session, 'question-abort-1', { questions }, abort.signal);
    expect(session.pendingInteractions.has('question-abort-1')).toBe(true);

    abort.abort();

    await expect(result).resolves.toEqual({ behavior: 'deny', message: 'Question cancelled' });
    expect(session.pendingInteractions.has('question-abort-1')).toBe(false);
    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'question_prompt',
      'interaction_cancelled',
    ]);
    expect(session.eventQueue[1].data).toEqual({
      interactionId: 'question-abort-1',
      reason: 'aborted',
    });
  });

  it('pushes interaction_cancelled when an approval is aborted (F5)', async () => {
    const session = makeBareSession();
    const abort = new AbortController();
    const context: ToolApprovalContext = { signal: abort.signal, toolUseID: 'tool-abort-1' };

    const result = handleToolApproval(session, 'tool-abort-1', 'Bash', { command: 'ls' }, context);
    abort.abort();

    await expect(result).resolves.toEqual({
      behavior: 'deny',
      message: 'Tool approval aborted',
    });
    expect(session.pendingInteractions.has('tool-abort-1')).toBe(false);
    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'approval_required',
      'interaction_cancelled',
    ]);
    expect(session.eventQueue[1].data).toEqual({
      interactionId: 'tool-abort-1',
      reason: 'aborted',
    });
  });

  it('pushes interaction_cancelled when an approval times out (F5)', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const context: ToolApprovalContext = {
        signal: new AbortController().signal,
        toolUseID: 'tool-timeout-1',
      };

      const result = handleToolApproval(
        session,
        'tool-timeout-1',
        'Bash',
        { command: 'rm -rf /secret-project' },
        context
      );
      vi.advanceTimersByTime(CEILING_MS);

      await expect(result).resolves.toMatchObject({ behavior: 'deny' });
      expect(session.pendingInteractions.has('tool-timeout-1')).toBe(false);
      // DOR-1158: a timeout also pushes an operator-facing notice, AFTER
      // interaction_cancelled so the card's removal can't wipe it in the same
      // frame (mirrors the phantom-notice ordering in message-sender.ts). The
      // first `system_status` is the park at ten minutes; the refusal is four
      // hours later (spec `ask-parks-on-timeout`).
      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'approval_required',
        'system_status',
        'interaction_cancelled',
        'system_status',
      ]);
      expect(session.eventQueue[2].data).toEqual({
        interactionId: 'tool-timeout-1',
        reason: 'timeout',
      });
      const notice = session.eventQueue[3].data as { message: string };
      expect(notice.message).toContain('Bash');
      expect(notice.message).toContain('4 hours');
      // Never the tool's arguments — they can carry secrets.
      expect(notice.message).not.toContain('rm -rf');
      expect(notice.message).not.toContain('secret-project');
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the agent WHY it was refused, when the person said why (DOR-809)', async () => {
    // The refusal the model reads is the whole feature. Without the reason the
    // agent is told only "denied" and typically retries the same call; with it
    // it can adjust. The message must CONTAIN the person's words verbatim —
    // asserting on the exact sentence would pin prose, asserting containment
    // pins the contract.
    const session = makeBareSession();
    const result = handleToolApproval(
      session,
      'tool-deny-reason-1',
      'Bash',
      { command: 'rm -rf node_modules' },
      { signal: new AbortController().signal, toolUseID: 'tool-deny-reason-1' }
    );

    const pending = session.pendingInteractions.get('tool-deny-reason-1');
    if (pending?.type !== 'approval') throw new Error('expected a pending approval');
    pending.resolve(false, 'Use pnpm prune instead — that folder is symlinked');

    const denial = (await result) as { behavior: string; message: string };
    expect(denial.behavior).toBe('deny');
    expect(denial.message).toContain('Use pnpm prune instead — that folder is symlinked');
  });

  it('says only that it was denied when no reason was given', async () => {
    // No reason means no reason: the message must not invent one, because the
    // receipt's "agent was told why" clause is keyed to a reason existing.
    const session = makeBareSession();
    const result = handleToolApproval(
      session,
      'tool-deny-bare-1',
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tool-deny-bare-1' }
    );

    const pending = session.pendingInteractions.get('tool-deny-bare-1');
    if (pending?.type !== 'approval') throw new Error('expected a pending approval');
    pending.resolve(false);

    await expect(result).resolves.toEqual({
      behavior: 'deny',
      message: 'User denied tool execution',
    });
  });

  it('anchors the LIVE elicitation_prompt where it was RAISED, not where it was normalized (DOR-1442)', () => {
    // The mirror of the question case above, for the member that was actually
    // short a field: `startedAt` reached only the pending-interaction record, so
    // the pushed event carried no anchor and the normalizer substituted its own
    // `Date.now()`. The durable member and the recovery DTO for the SAME prompt
    // then disagreed about when the clock started. Asserted through
    // `toRawSessionEvent` as well as on the raw payload, because the normalizer
    // is the seam that decides which of these fields survive.
    const session = makeBareSession();
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Please authenticate',
      elicitationId: 'elicit-timer-1',
    };

    void handleElicitation(session, request, new AbortController().signal);

    const pushed = session.eventQueue.find((e) => e.type === 'elicitation_prompt');
    const data = pushed?.data as { startedAt?: number; timeoutMs?: number } | undefined;
    expect(typeof data?.startedAt).toBe('number');
    expect(data?.timeoutMs).toBeGreaterThan(0);
    // The handler's own clock, the same one the pending record was stamped with.
    expect(data?.startedAt).toBe(session.pendingInteractions.get('elicit-timer-1')?.startedAt);

    const member = toRawSessionEvent(pushed as StreamEvent);
    expect(member).toMatchObject({
      type: 'elicitation_prompt',
      id: 'elicit-timer-1',
      startedAt: data?.startedAt,
      timeoutMs: data?.timeoutMs,
    });
    expect(member).not.toBeNull();
    const timed = member as unknown as { remainingMs: number };
    expect(timed.remainingMs).toBeGreaterThan(0);
  });
});

/**
 * DOR-1158. Before this, an expired interactive prompt left NO operator-visible
 * trace: the card vanished (`interaction_cancelled`), the model was told "User
 * did not respond", and a `warn`-level log nobody watches was the only record
 * (see {@link logInteractionTimeout}'s TSDoc). Happened twice on 2026-08-11 with
 * the operator active in another session — one was a $15-40 spend decision.
 *
 * TIMEOUT is the only trigger: a person resolving the prompt, or the SDK
 * aborting it (steer/interrupt), is not a silence and gets no notice.
 */
describe('operator-facing timeout notice (DOR-1158)', () => {
  it('names the question and says how long it waited, on question timeout', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const questions: QuestionItem[] = [
        {
          header: 'Bake-off',
          question: 'Which model should win the bake-off — GPT-5 or Opus?',
          multiSelect: false,
          options: [{ label: 'GPT-5' }, { label: 'Opus' }],
        },
      ];

      const result = handleAskUserQuestion(session, 'question-timeout-1', { questions });
      vi.advanceTimersByTime(COUNTDOWN_MS);
      // The park names the question, because that is the notice a person who is
      // still coming back will read.
      const parked = session.eventQueue[1].data as { message: string };
      expect(parked.message).toContain('Which model should win the bake-off — GPT-5 or Opus?');
      expect(parked.message).toContain('10 minutes');

      vi.advanceTimersByTime(CEILING_MS - COUNTDOWN_MS);
      await result;

      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'question_prompt',
        'system_status',
        'interaction_cancelled',
        'system_status',
      ]);
      const notice = session.eventQueue[3].data as { message: string };
      expect(notice.message).toContain('4 hours');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT push a notice when a question is answered by a person, not a timeout', async () => {
    const session = makeBareSession();
    const questions: QuestionItem[] = [
      { header: 'Pick', question: 'Which one?', multiSelect: false, options: [{ label: 'A' }] },
    ];

    const result = handleAskUserQuestion(session, 'question-resolved-1', { questions });
    const pending = session.pendingInteractions.get('question-resolved-1');
    if (pending?.type !== 'question') throw new Error('expected a pending question');
    pending.resolve({ '0': 'A' });
    await result;

    expect(session.eventQueue.map((e) => e.type)).toEqual(['question_prompt']);
  });

  it('names the tool and says how long it waited, on approval timeout', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const context: ToolApprovalContext = {
        signal: new AbortController().signal,
        toolUseID: 'tool-timeout-notice-1',
      };

      const result = handleToolApproval(
        session,
        'tool-timeout-notice-1',
        'Bash',
        { command: 'rm -rf /secret-project' },
        context
      );
      vi.advanceTimersByTime(CEILING_MS);
      await result;

      const notice = session.eventQueue[3].data as { message: string };
      expect(notice.message).toContain('Bash');
      expect(notice.message).toContain('4 hours');
      // Never the tool's arguments — they can carry secrets.
      expect(notice.message).not.toContain('secret-project');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT push a notice when an approval is resolved by a person, not a timeout', async () => {
    const session = makeBareSession();
    const context: ToolApprovalContext = {
      signal: new AbortController().signal,
      toolUseID: 'tool-resolved-notice-1',
    };

    const result = handleToolApproval(session, 'tool-resolved-notice-1', 'Bash', {}, context);
    const pending = session.pendingInteractions.get('tool-resolved-notice-1');
    if (pending?.type !== 'approval') throw new Error('expected a pending approval');
    pending.resolve(true);
    await result;

    expect(session.eventQueue.map((e) => e.type)).toEqual(['approval_required']);
  });

  it('names the MCP server and says how long it waited, on elicitation timeout', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const request: ElicitationRequest = {
        serverName: 'stripe-mcp',
        message: 'Confirm the $15-40 charge for the bake-off',
        mode: 'url',
      } as ElicitationRequest;

      const result = handleElicitation(session, request, new AbortController().signal);
      vi.advanceTimersByTime(CEILING_MS);
      await result;

      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'elicitation_prompt',
        'system_status',
        'interaction_cancelled',
        'system_status',
      ]);
      const notice = session.eventQueue[3].data as { message: string };
      expect(notice.message).toContain('stripe-mcp');
      expect(notice.message).toContain('4 hours');
      // Never the elicitation's message body — it can carry sensitive detail.
      expect(notice.message).not.toContain('$15-40');
    } finally {
      vi.useRealTimers();
    }
  });
});
