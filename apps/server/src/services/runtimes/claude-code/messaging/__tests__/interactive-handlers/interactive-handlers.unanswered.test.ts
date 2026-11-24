/**
 * interactive-handlers: unanswered. Shared setup lives in `./interactive-handlers.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createCanUseTool,
  handleAskUserQuestion,
  handleElicitation,
  handleToolApproval,
  type ToolApprovalContext,
} from '../../interactive-handlers.js';
import type { InteractiveSession } from '../../interaction-wait.js';
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import {
  makeContext,
  noopLog,
  COUNTDOWN_MS,
  CEILING_MS,
  makeBareSession,
  settlementOf,
} from './interactive-handlers.fixtures.js';

/**
 * The two-stage wait (spec `ask-parks-on-timeout`): a prompt nobody answers
 * PARKS at ten minutes and is refused four hours later.
 *
 * The failure this suite exists for is the one the old code shipped: the model
 * was handed a denial nobody gave, ten minutes into a lunch, and the only trace
 * was a silent log line. So the sharpest assertion here is a negative one — at
 * ten minutes the promise has NOT settled and the tool call is still held.
 */
describe('a prompt nobody answers parks, then is refused', () => {
  it('leaves the promise unsettled and the entry pending at ten minutes', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const result = handleToolApproval(session, 'park-1', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'park-1',
      } as ToolApprovalContext);

      vi.advanceTimersByTime(COUNTDOWN_MS);

      expect(await settlementOf(result)).toBe('pending');
      expect(session.pendingInteractions.has('park-1')).toBe(true);

      // Settle it so the test leaves nothing armed.
      session.pendingInteractions.get('park-1')?.reject('done');
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses at four hours, naming the wait in hours', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const result = handleToolApproval(session, 'park-3', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'park-3',
      } as ToolApprovalContext);

      vi.advanceTimersByTime(CEILING_MS - 1);
      expect(await settlementOf(result)).toBe('pending');

      vi.advanceTimersByTime(1);

      await expect(result).resolves.toEqual({
        behavior: 'deny',
        message: 'Tool approval timed out after 4 hours',
      });
      expect(session.eventQueue[2]).toEqual({
        type: 'interaction_cancelled',
        data: { interactionId: 'park-3', reason: 'timeout' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the ceiling timer when a parked prompt is finally answered', async () => {
    // The one correctness trap in the change: the entry's timer is REPLACED
    // when the prompt parks, so a `clearTimeout` over the first timer clears
    // one that has already fired and leaves the ceiling armed on an interaction
    // somebody answered. It would then refuse a tool call that already ran.
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const result = handleToolApproval(session, 'park-4', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'park-4',
      } as ToolApprovalContext);

      vi.advanceTimersByTime(COUNTDOWN_MS + 60_000);
      const pending = session.pendingInteractions.get('park-4');
      if (pending?.type !== 'approval') throw new Error('expected a pending approval');
      pending.resolve(true);
      await expect(result).resolves.toEqual({
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      });
      const afterAnswer = session.eventQueue.length;

      vi.advanceTimersByTime(CEILING_MS);

      expect(session.eventQueue).toHaveLength(afterAnswer);
      expect(session.eventQueue.map((e) => e.type)).toEqual(['approval_required', 'system_status']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the ceiling timer when the SDK aborts a parked prompt', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const abort = new AbortController();
      const result = handleToolApproval(session, 'park-5', 'Bash', { command: 'ls' }, {
        signal: abort.signal,
        toolUseID: 'park-5',
      } as ToolApprovalContext);

      vi.advanceTimersByTime(COUNTDOWN_MS + 60_000);
      abort.abort();
      await expect(result).resolves.toEqual({
        behavior: 'deny',
        message: 'Tool approval aborted',
      });
      const afterAbort = session.eventQueue.length;

      vi.advanceTimersByTime(CEILING_MS);

      expect(session.eventQueue).toHaveLength(afterAbort);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('an ask nobody can answer is refused the moment it is raised', () => {
  const DENIAL =
    'Nobody is available to approve this right now. ' +
    'Do what you can without it and say what you skipped.';

  /** The refusal record a handler pushed, if it pushed one. */
  function deniedEvent(session: InteractiveSession): Record<string, unknown> | undefined {
    const event = session.eventQueue.find((e) => e.type === 'permission_denied');
    return event?.data as Record<string, unknown> | undefined;
  }

  it('refuses a tool approval without arming any wait', async () => {
    // The ten minutes this replaces bought a chance that somebody answers, on
    // the one surface where by construction nobody is there — and held a run
    // slot for the whole of it. Fake timers with NOTHING advanced is the proof:
    // a refusal that still went through a timer would never resolve here, and
    // the test would time out rather than pass.
    vi.useFakeTimers();
    try {
      const session = makeBareSession({ unattended: true });
      const result = handleToolApproval(session, 'deny-1', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'deny-1',
      } as ToolApprovalContext);

      await expect(result).resolves.toEqual({ behavior: 'deny', message: DENIAL });
      // No card was ever pushed, so there is nothing to cancel and nothing for a
      // client to render as answerable.
      expect(session.eventQueue.map((e) => e.type)).toEqual(['permission_denied']);
      expect(session.pendingInteractions.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses in a turn nobody is watching, and asks again in the next one', async () => {
    // An automatic carry-over's first turn has nobody to ask; the person who
    // opens that session next does. The flag is the turn's, not the session's.
    const session = makeBareSession({ unattendedTurn: true });
    await expect(
      handleToolApproval(session, 'turn-1', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'turn-1',
      } as ToolApprovalContext)
    ).resolves.toEqual({ behavior: 'deny', message: DENIAL });

    // The next send reassigns it; that turn's approval waits for its person.
    session.unattendedTurn = false;
    void handleToolApproval(session, 'turn-2', 'Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'turn-2',
    } as ToolApprovalContext);
    expect(session.pendingInteractions.get('turn-2')?.type).toBe('approval');
  });

  it('records the refusal under a reason only DorkOS writes', async () => {
    // The stamp is what lets a run summary say "nobody was there to approve it"
    // without qualifying it: the SDK's own denials (classifier, rule,
    // asyncAgent) describe decisions that would have gone the same way with a
    // person present, and they carry other discriminators.
    const session = makeBareSession({ unattended: true });
    await handleToolApproval(session, 'deny-2', 'Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'deny-2',
    } as ToolApprovalContext);

    expect(deniedEvent(session)).toEqual({
      toolCallId: 'deny-2',
      toolName: 'Bash',
      reasonType: 'no_approval_surface',
      // Stamped beside the reason, and load-bearing: this is the one of the
      // three refused asks that is a TOOL the run lost, and the only one the
      // `blocked` run outcome counts (DOR-2101).
      askKind: 'tool',
      reason: 'nobody was available to approve this tool',
      message: DENIAL,
    });
    // Nothing from the prompt's INPUT: a tool's arguments are paths, commands
    // and occasionally secrets, and this record reaches the transcript.
    expect(JSON.stringify(deniedEvent(session))).not.toContain('ls');
  });

  it('refuses a question and an elicitation the same way', async () => {
    const session = makeBareSession({ unattended: true });

    const question = handleAskUserQuestion(session, 'deny-q', {
      questions: [{ question: 'which branch?', header: 'Branch', options: [] }],
    });
    const elicitation = handleElicitation(
      session,
      { serverName: 'stripe-mcp', message: 'sign in', mode: 'url' } as ElicitationRequest,
      new AbortController().signal
    );

    await expect(question).resolves.toEqual({ behavior: 'deny', message: DENIAL });
    // An MCP server's request declines rather than denies — that is the shape
    // its own protocol takes — but it settles just as immediately.
    await expect(elicitation).resolves.toEqual({ action: 'decline' });
    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'permission_denied',
      'permission_denied',
    ]);
    // The MCP server is named where a tool name would go, because it is what the
    // person reading the run has to recognise.
    expect(session.eventQueue.map((e) => (e.data as { toolName: string }).toolName)).toEqual([
      'AskUserQuestion',
      'stripe-mcp',
    ]);
    // NEITHER is stamped as a tool, and that is what keeps a run that did its
    // work and then asked a question from being recorded as one that could not
    // use its tools (DOR-2101).
    expect(session.eventQueue.map((e) => (e.data as { askKind?: string }).askKind)).toEqual([
      'question',
      'elicitation',
    ]);
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('leaves an ordinary session waiting exactly as before', async () => {
    // The flag is the whole difference. A session a person can reach keeps the
    // two-stage wait, which is what stops this from being a change to every
    // approval card in the app.
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const result = handleToolApproval(session, 'wait-1', 'Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'wait-1',
      } as ToolApprovalContext);

      expect(await settlementOf(result)).toBe('pending');
      expect(session.eventQueue.map((e) => e.type)).toEqual(['approval_required']);

      session.pendingInteractions.get('wait-1')?.reject('done');
      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still auto-allows what it always auto-allowed, without a card or a refusal', async () => {
    // The refusal sits BEHIND the gate, not in front of it: `isAutoAllowedCall`,
    // the safe lists and `resolveModeDecision` all run first and are untouched,
    // so a scheduled run keeps every tool it never had to ask about (DOR-1229).
    const session = {
      ...makeBareSession({ unattended: true }),
      permissionMode: 'default' as const,
      cwd: '/tmp',
    };
    const canUseTool = createCanUseTool(session, noopLog);

    const read = await canUseTool('Read', { file_path: '/tmp/x' }, makeContext('allow-1'));

    expect(read).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/x' } });
    expect(session.eventQueue).toEqual([]);
  });

  it('still allows what bypassPermissions allows, rather than refusing it', async () => {
    // A schedule can hold `bypassPermissions`, and under it `resolveModeDecision`
    // answers `allow` for the few calls the CLI escalates anyway. Refusing those
    // would have narrowed a mode the operator deliberately chose.
    const session = {
      ...makeBareSession({ unattended: true }),
      permissionMode: 'bypassPermissions' as const,
    };
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool('Bash', { command: 'rm -rf build' }, makeContext('bypass-1'));

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf build' },
    });
    expect(session.eventQueue).toEqual([]);
  });
});
