import { describe, it, expect, vi } from 'vitest';
import { logger } from '../../../../../lib/logger.js';
import {
  createCanUseTool,
  handleAskUserQuestion,
  handleElicitation,
  handleToolApproval,
  resolveModeDecision,
  type InteractiveSession,
  type PendingInteraction,
  type ToolApprovalContext,
} from '../interactive-handlers.js';
import { resolveApprovalDecision } from '../../../opencode/approvals.js';
import type { StreamEvent, QuestionItem } from '@dorkos/shared/types';
import { PermissionModeSchema, type PermissionMode } from '@dorkos/shared/schemas';
import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';

/** Build a minimal interactive session with a configurable permission mode. */
function makeSession(
  permissionMode: PermissionMode
): InteractiveSession & { permissionMode: PermissionMode } {
  return {
    permissionMode,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  };
}

/** Minimal SDK approval context — an unaborted signal is all the gate needs. */
function makeContext(toolUseID: string): ToolApprovalContext {
  return {
    signal: new AbortController().signal,
    toolUseID,
  };
}

const noopLog = { debug: () => {}, info: () => {} };

describe('createCanUseTool — approval gate', () => {
  const NON_SAFE_TOOL = 'Bash';

  it('routes a non-safe tool to approval (not auto-allow) in default mode', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);

    // handleToolApproval never resolves until the user responds, so we race the
    // pending promise against a microtask and assert it stayed pending while
    // pushing an approval_required event to the queue.
    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-1'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-1')).toBe(true);
  });

  it('routes a non-safe tool to approval (not auto-allow) in auto mode', async () => {
    const session = makeSession('auto');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-2'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('tool-2')).toBe(true);
  });

  // DOR-604. This is the security regression test: a Slack/Telegram message
  // routed through a binding lands on `acceptEdits`, and `Bash` used to be
  // auto-allowed from there — an off-machine message ran a local shell command
  // with nobody asked. `acceptEdits` ships the description "Auto-accept file
  // edits; still prompt for other tools"; `Bash` is an other tool.
  it('raises an approval card for Bash in acceptEdits mode instead of running it', async () => {
    const session = makeSession('acceptEdits');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool('Bash', { command: 'rm -rf ~/x' }, makeContext('tool-3'));
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.eventQueue[0].data).toMatchObject({ toolName: 'Bash' });
    expect(session.pendingInteractions.has('tool-3')).toBe(true);
  });

  // An edit tool only reaches `canUseTool` under `acceptEdits` when the CLI
  // escalated it — its own engine already auto-allowed every write inside the
  // allowed working directories, so what arrives here failed that check
  // ("Path is outside allowed working directories"). Auto-accepting it would
  // rubber-stamp the escape: `~/.ssh/authorized_keys` is the concrete case.
  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])(
    'raises an approval card for the escalated edit-family tool %s in acceptEdits mode',
    async (toolName) => {
      const session = makeSession('acceptEdits');
      const canUseTool = createCanUseTool(session, noopLog);

      const result = canUseTool(
        toolName,
        { file_path: '/Users/someone/.ssh/authorized_keys' },
        makeContext('tool-e')
      );
      const settled = await Promise.race([
        result.then(() => 'settled' as const),
        Promise.resolve('pending' as const),
      ]);

      expect(settled).toBe('pending');
      expect(session.eventQueue).toHaveLength(1);
      expect(session.eventQueue[0].type).toBe('approval_required');
      expect(session.pendingInteractions.has('tool-e')).toBe(true);
    }
  );

  it('auto-allows a non-safe tool in bypassPermissions mode', async () => {
    const session = makeSession('bypassPermissions');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool(NON_SAFE_TOOL, { command: 'ls' }, makeContext('tool-4'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(session.eventQueue).toHaveLength(0);
    expect(session.pendingInteractions.size).toBe(0);
  });

  it('auto-allows read-only tools even in auto mode', async () => {
    const session = makeSession('auto');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = await canUseTool('Read', { file_path: '/tmp/x' }, makeContext('tool-5'));

    expect(result).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/x' } });
    expect(session.eventQueue).toHaveLength(0);
  });

  // DOR-782. A stale comment in message-sender claimed `canUseTool` never sees
  // subagent tool use, and a turn killed by the stall watchdog was misdiagnosed
  // on the strength of it. At SDK 0.3.177 a foreground `Task` subagent's tool
  // calls arrive on THIS callback, tagged with `agentID` (sdk.d.ts `CanUseTool`).
  // This pins that DorkOS's gate treats such a call like any other — it raises a
  // real card, which is what pauses the watchdog. If a future SDK genuinely
  // stops routing subagent calls here, this test is the thing that should be
  // re-read, but only a live SDK change can make it red.
  it('raises a normal approval card for a call made from inside a subagent', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);

    const result = canUseTool(NON_SAFE_TOOL, { command: 'ls' }, {
      ...makeContext('subagent-tool-1'),
      agentID: 'agent_01HZ',
    } as ToolApprovalContext);
    const settled = await Promise.race([
      result.then(() => 'settled' as const),
      Promise.resolve('pending' as const),
    ]);

    expect(settled).toBe('pending');
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.pendingInteractions.has('subagent-tool-1')).toBe(true);
  });

  // DOR-1229. A room triggers a turn INTO THE DARK — nobody holds that session's
  // stream — and it runs under `default`, the strictest mode. So a card raised for
  // the agent's own room verbs is a card nobody is positioned to answer: measured
  // live on 2026-08-16, `search_room_history` asked at 15s and the turn made no
  // further progress until the interaction window auto-denied it ten minutes
  // later. Each of the four is asserted by name rather than by iterating the
  // safe-list, so removing one from `DORKOS_AGENT_TOOLS` is red here rather than a
  // test that shrinks quietly with the list it reads.
  it.each([
    ['mcp__dorkos__post_to_room', { roomId: 'room-1', text: 'on it' }],
    ['mcp__dorkos__react_to_room_entry', { roomId: 'room-1', entryId: 'e-1', emoji: '🎉' }],
    ['mcp__dorkos__read_room_history', { roomId: 'room-1' }],
    ['mcp__dorkos__search_room_history', { roomId: 'room-1', query: 'deploy' }],
  ])(
    'lets a room turn use its own room verb %s without a card nobody can answer',
    async (toolName, input) => {
      const session = makeSession('default');
      const canUseTool = createCanUseTool(session, noopLog);

      const result = await canUseTool(toolName, input, makeContext(`rooms-${toolName}`));

      expect(result).toEqual({ behavior: 'allow', updatedInput: input });
      expect(session.eventQueue).toHaveLength(0);
      expect(session.pendingInteractions.size).toBe(0);
    }
  );

  it('logs an approval request at info and routine verdicts at debug', async () => {
    // A turn parked on a card makes no further progress, so the line explaining
    // WHY has to survive the default production log level (DOR-782). The
    // per-call auto-allow chatter must not.
    const log = { debug: vi.fn(), info: vi.fn() };
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, log);

    await canUseTool('Read', { file_path: '/tmp/x' }, makeContext('quiet-1'));
    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      '[canUseTool] auto-allow safe tool',
      expect.objectContaining({ toolName: 'Read' })
    );

    void canUseTool(NON_SAFE_TOOL, { command: 'ls' }, {
      ...makeContext('loud-1'),
      agentID: 'agent_01HZ',
    } as ToolApprovalContext);
    expect(log.info).toHaveBeenCalledWith('[canUseTool] requesting approval', {
      toolName: NON_SAFE_TOOL,
      permissionMode: 'default',
      toolUseID: 'loud-1',
      agentID: 'agent_01HZ',
    });
  });
});

/**
 * DOR-625 — the reproduction, and then the whole surface it belongs to.
 *
 * `mcp__dorkos__control_ui` sits in {@link DORKOS_AGENT_TOOLS}, which
 * `createCanUseTool` short-circuits on BEFORE `resolveModeDecision` runs, so the
 * session's permission mode never gets a vote. It was put there under the comment
 * "pure client-side UI mutations, no system access", and for 21 of its 22 actions
 * that is true.
 *
 * `apply_layout` is the twenty-second. The cockpit answers it by POSTing
 * `/api/shapes/:name/apply`, and applying a Shape creates that Shape's schedules
 * ENABLED, each carrying the permission mode the Shape's own manifest chose —
 * `bypassPermissions` is in `SHAPE_SCHEDULE_PERMISSION_MODES`. So one auto-allowed
 * tool call armed a recurring unattended run with every safety prompt off, in
 * plain `default` mode, with nobody asked.
 *
 * `control_ui` is the only MULTIPLEXER on the auto-allow list: one tool name, 22
 * different effects, one blanket decision. These tests are per-ACTION for that
 * reason — a tool-name-level assertion is exactly what could not see this.
 */
describe('control_ui is auto-allowed per action, not per tool (DOR-625)', () => {
  const CONTROL_UI = 'mcp__dorkos__control_ui';

  /** Run one control_ui command through the gate and say what the gate did. */
  async function gate(
    mode: PermissionMode,
    input: Record<string, unknown>
  ): Promise<{ outcome: 'allowed' | 'asked'; session: ReturnType<typeof makeSession> }> {
    const session = makeSession(mode);
    const canUseTool = createCanUseTool(session, noopLog);
    const pending = canUseTool(CONTROL_UI, input, makeContext('ui-1'));
    // Raced against a MACROtask, not `Promise.resolve()`: an auto-allow resolves
    // on a microtask, so an already-resolved rival would always win and every
    // call would read as "asked" — a green that means nothing.
    const outcome = await Promise.race([
      pending.then(() => 'allowed' as const),
      new Promise<'asked'>((resolve) => setTimeout(() => resolve('asked'), 0)),
    ]);
    return { outcome, session };
  }

  it('raises an approval card for apply_layout in default mode', async () => {
    const { outcome, session } = await gate('default', {
      action: 'apply_layout',
      shape: 'linear-ops',
    });

    expect(outcome).toBe('asked');
    expect(session.eventQueue).toHaveLength(1);
    expect(session.eventQueue[0].type).toBe('approval_required');
    expect(session.eventQueue[0].data).toMatchObject({ toolName: CONTROL_UI });
  });

  // The mode is the point: the short-circuit ran ahead of `resolveModeDecision`,
  // so `plan` — a mode whose whole promise is that nothing executes — auto-allowed
  // this too.
  it.each(['default', 'acceptEdits', 'auto', 'plan'] as const)(
    'raises an approval card for apply_layout in %s mode',
    async (mode) => {
      const { outcome } = await gate(mode, { action: 'apply_layout', shape: 'linear-ops' });
      expect(outcome).toBe('asked');
    }
  );

  it('still auto-allows the client-only actions, so the nicety keeps working', async () => {
    for (const input of [
      { action: 'open_panel', panel: 'tasks' },
      { action: 'close_sidebar' },
      { action: 'scroll_to_message' },
      { action: 'show_toast', message: 'hi' },
      { action: 'celebrate' },
      { action: 'switch_agent', cwd: '/tmp/project' },
    ]) {
      const { outcome, session } = await gate('default', input);
      expect(outcome, `${String(input.action)} should not raise a card`).toBe('allowed');
      expect(session.eventQueue).toHaveLength(0);
    }
  });

  it('asks rather than guesses when the command does not parse', async () => {
    // Fail closed. An input the union rejects has no known action, so there is no
    // classification to read and "no rule" must never mean "allowed".
    const { outcome } = await gate('default', { action: 'not_a_real_action' });
    expect(outcome).toBe('asked');
  });

  it('leaves get_ui_state alone — reading the UI asks nobody', async () => {
    const session = makeSession('default');
    const canUseTool = createCanUseTool(session, noopLog);
    const result = await canUseTool('mcp__dorkos__get_ui_state', {}, makeContext('ui-2'));
    expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
  });
});

describe('resolveModeDecision — the gate closes on non-match (DOR-604)', () => {
  /**
   * The whole decision table, written out. Each entry names the mode, the tool,
   * and the expected decision, so a regression says which cell moved.
   */
  const TABLE: ReadonlyArray<[PermissionMode, 'allow' | 'ask']> = [
    // bypassPermissions IS consent — this is the mode's documented meaning, and
    // the CLI resolves it upstream without ever consulting this callback.
    ['bypassPermissions', 'allow'],
    // Every other mode asks, because the CLI only round-trips to `canUseTool`
    // for calls its own engine already decided need asking. Reaching here at all
    // means "the upstream gate escalated this".
    ['default', 'ask'],
    ['acceptEdits', 'ask'],
    ['auto', 'ask'],
    ['plan', 'ask'],
    ['dontAsk', 'ask'],
  ];

  it.each(TABLE)('%s -> %s', (mode, expected) => {
    expect(resolveModeDecision(mode)).toBe(expected);
  });

  /**
   * The runtime counterpart of the `never` check in the switch's `default` arm.
   * `tsc` catches a new mode that no arm handles; this catches a new mode that
   * an arm handles but nobody decided about, by failing until the table above
   * covers it. Driven off the Zod schema, never a hand-copied list.
   */
  it('decides every mode in the PermissionMode union', () => {
    const decided = new Set(TABLE.map(([mode]) => mode));
    expect([...PermissionModeSchema.options].sort()).toEqual([...decided].sort());
  });

  /**
   * Only `bypassPermissions` may auto-run a shell command. Stated as its own
   * assertion so the security property does not depend on reading the table.
   */
  it('allows Bash under exactly one mode: bypassPermissions', () => {
    const allowBash = PermissionModeSchema.options.filter(
      (mode) => resolveModeDecision(mode) === 'allow'
    );
    expect(allowBash).toEqual(['bypassPermissions']);
  });
});

describe('claude-code and opencode agree where they must (DOR-604)', () => {
  /** Modes both runtimes surface (opencode/runtime-constants.ts). */
  const SHARED_MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;

  const asDecision = (type: string, mode: PermissionMode) =>
    resolveApprovalDecision(mode, type) === 'auto-approve' ? 'allow' : 'ask';

  /**
   * The security-critical agreement: neither runtime may auto-run a shell
   * command or a network fetch under a mode the other one prompts for. A mode
   * that runs `bash` in one runtime and prompts in the other is a bug.
   */
  it.each(SHARED_MODES.flatMap((mode) => ['bash', 'webfetch'].map((t) => [mode, t] as const)))(
    '%s: opencode %s matches claude-code',
    (mode, type) => {
      expect(asDecision(type, mode)).toBe(resolveModeDecision(mode));
    }
  );

  /**
   * The one deliberate divergence, pinned so it cannot drift unnoticed.
   *
   * Under `acceptEdits` opencode auto-approves an `edit` and claude-code asks.
   * That is not an inconsistency in the promise both runtimes make — it is where
   * the promise is kept. The Claude Code CLI auto-accepts in-workspace writes
   * itself and only escalates a write that left the working directory, so an
   * edit reaching claude-code's callback has already failed that check and must
   * ask. OpenCode's sidecar forwards every permission request unfiltered, so its
   * adapter is the layer that has to auto-approve edits for the mode to mean
   * anything. Same operator experience, different layer.
   *
   * If either side changes, this test fails and the reasoning above gets
   * re-examined rather than silently lost.
   */
  it('diverges on acceptEdits + edit, and only there, by design', () => {
    expect(asDecision('edit', 'acceptEdits')).toBe('allow');
    expect(resolveModeDecision('acceptEdits')).toBe('ask');

    // Everywhere else in the shared surface the two agree.
    expect(asDecision('edit', 'default')).toBe(resolveModeDecision('default'));
    expect(asDecision('edit', 'bypassPermissions')).toBe(resolveModeDecision('bypassPermissions'));
  });
});

/** A bare session literal — no SDK mock, just the map + queue the handlers touch. */
function makeBareSession(): InteractiveSession {
  return {
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    sdkSessionId: 'session-under-test',
  };
}

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

  it('captures a question snapshot deep-equal to the input questions', () => {
    // Purpose: question snapshot fidelity — the stored questions match input.
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

    const pending = session.pendingInteractions.get('question-1');
    expect(pending?.type).toBe('question');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toEqual({ questions });
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
      vi.advanceTimersByTime(10 * 60 * 1000);

      await expect(result).resolves.toMatchObject({ behavior: 'deny' });
      expect(session.pendingInteractions.has('tool-timeout-1')).toBe(false);
      // DOR-1158: a timeout also pushes an operator-facing notice, AFTER
      // interaction_cancelled so the card's removal can't wipe it in the same
      // frame (mirrors the phantom-notice ordering in message-sender.ts).
      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'approval_required',
        'interaction_cancelled',
        'system_status',
      ]);
      expect(session.eventQueue[1].data).toEqual({
        interactionId: 'tool-timeout-1',
        reason: 'timeout',
      });
      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('Bash');
      expect(notice.message).toContain('10 minutes');
      // Never the tool's arguments — they can carry secrets.
      expect(notice.message).not.toContain('rm -rf');
      expect(notice.message).not.toContain('secret-project');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says in the log that nobody answered, for every kind of prompt', async () => {
    // **The only trace an expired prompt leaves.** All three handlers hand the
    // model a denial ten minutes on and used to write nothing anywhere: the
    // card vanished from any client that happened to be watching, the turn
    // carried on as though a person had refused, and nothing recorded that the
    // refusal was a clock rather than a decision. Reconstructing the
    // 2026-07-31 incident — two agents, two expired approvals each, forty-one
    // minutes of silence — needed the SDK transcripts, because the server log
    // held nothing at all (DOR-784).
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const approval = handleToolApproval(
        session,
        'tool-1',
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseID: 'tool-1' }
      );
      const question = handleAskUserQuestion(session, 'tool-2', {
        questions: [{ question: 'which branch?', header: 'Branch', options: [] }],
      });
      const elicitation = handleElicitation(
        session,
        { serverName: 'test-mcp', message: 'sign in', mode: 'url' } as ElicitationRequest,
        new AbortController().signal
      );
      vi.advanceTimersByTime(10 * 60 * 1000);
      await Promise.all([approval, question, elicitation]);

      const said = warn.mock.calls.filter(
        ([message]) => message === '[claude-code] nobody answered in time, so this was denied'
      );
      // `warn` is not incidental — it is the refusal rule. `visibility: 'silent'`
      // says no notice was written anywhere, which is what makes this line the
      // only record, and the level follows from that.
      expect(said.map(([, fields]) => fields)).toEqual([
        {
          sessionId: 'session-under-test',
          interactionId: 'tool-1',
          kind: 'approval',
          toolName: 'Bash',
          waitedMs: 10 * 60 * 1000,
          reason: 'interaction_expired',
          visibility: 'silent',
        },
        {
          sessionId: 'session-under-test',
          interactionId: 'tool-2',
          kind: 'question',
          waitedMs: 10 * 60 * 1000,
          reason: 'interaction_expired',
          visibility: 'silent',
        },
        {
          sessionId: 'session-under-test',
          interactionId: expect.any(String),
          kind: 'elicitation',
          waitedMs: 10 * 60 * 1000,
          reason: 'interaction_expired',
          visibility: 'silent',
        },
      ]);
      // Nothing from the prompt's input: a tool's arguments are file paths,
      // commands and occasionally secrets, and none of that belongs in a log.
      expect(JSON.stringify(said)).not.toContain('ls');
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
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

  it('captures an elicitation snapshot matching the request', () => {
    // Purpose: elicitation snapshot fidelity — serverName/message match request.
    const session = makeBareSession();
    const request: ElicitationRequest = {
      serverName: 'test-mcp',
      message: 'Please authenticate',
      mode: 'url',
      url: 'https://auth.example.com',
      elicitationId: 'elicit-snap-1',
    };

    void handleElicitation(session, request, new AbortController().signal);

    const pending = session.pendingInteractions.get('elicit-snap-1');
    expect(pending?.type).toBe('elicitation');
    expect(typeof pending?.startedAt).toBe('number');
    expect(pending?.snapshot).toMatchObject({
      serverName: 'test-mcp',
      message: 'Please authenticate',
    });
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
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'question_prompt',
        'interaction_cancelled',
        'system_status',
      ]);
      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('Which model should win the bake-off — GPT-5 or Opus?');
      expect(notice.message).toContain('10 minutes');
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates a long question to exactly 120 characters plus an ellipsis', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      // No whitespace at the 120-char cut point, so the truncator's trailing
      // trimEnd() can't shorten it further — the boundary is deterministic.
      const longQuestion = `Which model wins the bake-off? ${'x'.repeat(200)}`;
      const questions: QuestionItem[] = [
        { header: 'Long', question: longQuestion, multiSelect: false, options: [] },
      ];

      const result = handleAskUserQuestion(session, 'question-timeout-long-1', { questions });
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).not.toContain(longQuestion);
      expect(notice.message).toContain('Which model wins the bake-off?');
      const quoted = notice.message.split('The question was: ')[1];
      // Exactly 120 characters of the question, then one ellipsis, wrapped in
      // the message's own quote marks — not "somewhere under a generous bound".
      expect(quoted).toBe(`"${longQuestion.slice(0, 120)}…"`);
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
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('Bash');
      // Never the tool's arguments — they can carry secrets.
      expect(notice.message).not.toContain('secret-project');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers displayName over the raw tool name in the approval timeout notice', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const context: ToolApprovalContext = {
        signal: new AbortController().signal,
        toolUseID: 'tool-timeout-display-1',
        displayName: 'Delete secret project',
      };

      const result = handleToolApproval(
        session,
        'tool-timeout-display-1',
        'Bash',
        { command: 'rm -rf /secret-project' },
        context
      );
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('Delete secret project');
      expect(notice.message).not.toContain('Bash');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the raw tool name when displayName is blank, not "undefined" or empty', async () => {
    vi.useFakeTimers();
    try {
      const session = makeBareSession();
      const context: ToolApprovalContext = {
        signal: new AbortController().signal,
        toolUseID: 'tool-timeout-blank-display-1',
        displayName: '   ',
      };

      const result = handleToolApproval(
        session,
        'tool-timeout-blank-display-1',
        'Bash',
        { command: 'ls' },
        context
      );
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('I asked to run Bash and waited');
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
      vi.advanceTimersByTime(10 * 60 * 1000);
      await result;

      expect(session.eventQueue.map((e) => e.type)).toEqual([
        'elicitation_prompt',
        'interaction_cancelled',
        'system_status',
      ]);
      const notice = session.eventQueue[2].data as { message: string };
      expect(notice.message).toContain('stripe-mcp');
      expect(notice.message).toContain('10 minutes');
      // Never the elicitation's message body — it can carry sensitive detail.
      expect(notice.message).not.toContain('$15-40');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT push a notice when an elicitation is resolved by a person, not a timeout', async () => {
    const session = makeBareSession();
    const request: ElicitationRequest = {
      serverName: 'stripe-mcp',
      message: 'Confirm the charge',
      mode: 'url',
      elicitationId: 'elicit-resolved-1',
    };

    const result = handleElicitation(session, request, new AbortController().signal);
    const pending = session.pendingInteractions.get('elicit-resolved-1');
    if (pending?.type !== 'elicitation') throw new Error('expected a pending elicitation');
    pending.resolve({ action: 'accept', content: {} });
    await result;

    expect(session.eventQueue.map((e) => e.type)).toEqual(['elicitation_prompt']);
  });

  it('does NOT push a notice when an elicitation is aborted, not timed out', async () => {
    const session = makeBareSession();
    const abort = new AbortController();
    const request: ElicitationRequest = {
      serverName: 'stripe-mcp',
      message: 'Confirm the charge',
      mode: 'url',
    } as ElicitationRequest;

    const result = handleElicitation(session, request, abort.signal);
    abort.abort();
    await result;

    expect(session.eventQueue.map((e) => e.type)).toEqual([
      'elicitation_prompt',
      'interaction_cancelled',
    ]);
  });
});
