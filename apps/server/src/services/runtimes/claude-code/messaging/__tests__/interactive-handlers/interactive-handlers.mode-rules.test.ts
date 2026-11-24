/**
 * interactive-handlers: mode rules. Shared setup lives in `./interactive-handlers.fixtures.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCanUseTool,
  handleToolApproval,
  type ToolApprovalContext,
} from '../../interactive-handlers.js';
import { resolveModeDecision } from '../../../turn-permission.js';
import {
  autoModeStopStats,
  resetAutoModeStops,
} from '../../../../../observability/auto-mode-stops.js';
import { resolveApprovalDecision } from '../../../../opencode/messaging/approvals.js';
import { toRawSessionEvent } from '../../../../../session/session-event-normalizer.js';
import { PermissionModeSchema, type PermissionMode } from '@dorkos/shared/schemas';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import {
  makeSession,
  makeContext,
  noopLog,
  makeBareSession,
} from './interactive-handlers.fixtures.js';

/**
 * DOR-625 — the reproduction, and then the whole surface it belongs to.
 *
 * `mcp__dorkos__control_ui` sits in {@link DORKOS_AGENT_TOOLS}, which
 * `createCanUseTool` short-circuits on BEFORE `resolveModeDecision` runs, so the
 * session's permission mode never gets a vote. It was put there under the comment
 * "pure client-side UI mutations, no system access", and for 20 of its 21 actions
 * that is true.
 *
 * `apply_layout` is the exception. The client answers it by POSTing
 * `/api/shapes/:name/apply`, and applying a Shape writes a `SKILL.md` into the
 * person's own skills root for every schedule the Shape declares, records a
 * receipt naming what it wrote, rewrites `ui.shapes.active` in
 * `~/.dork/config.json`, creates, rebinds and deletes scheduled tasks, and turns
 * extensions on and off. So one auto-allowed tool call rewrote a person's files
 * and configuration, in plain `default` mode, with nobody asked.
 *
 * It could not, and cannot, hand those schedules a mode nobody granted: a
 * manifest's `bypassPermissions` is clamped to `acceptEdits` (DOR-607) and the
 * row parks at `pending_approval` until a person approves it (DOR-1486). This
 * comment claimed otherwise until DOR-1713; the card is warranted by the writing.
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

// Trust never extends to strangers (DOR-2790). A turn another agent or an outside
// sender started carries a ceiling, and from such a turn the chat verbs that cut
// into another chat's running turn ask; the ones that only add a message do not.
describe('chat verbs under a turn ceiling', () => {
  /** Run one chat call through the gate and say what the gate did. */
  async function gate(
    toolName: string,
    input: Record<string, unknown>,
    withCeiling: boolean
  ): Promise<'allowed' | 'asked'> {
    const session = {
      ...makeSession('default'),
      ...(withCeiling ? { turnPermissionCeiling: 'runtime-default' as const } : {}),
    };
    const canUseTool = createCanUseTool(session, noopLog, undefined, async () => ({
      identity: { agentPath: '/agents/a' },
    }));
    // A macrotask rival, so an auto-allow (a microtask) cannot lose the race.
    return Promise.race([
      canUseTool(toolName, input, makeContext('chat-1')).then(() => 'allowed' as const),
      new Promise<'asked'>((resolve) => setTimeout(() => resolve('asked'), 0)),
    ]);
  }

  const SEND = 'mcp__dorkos__chat_send';
  const STOP = 'mcp__dorkos__chat_stop';
  const READ = 'mcp__dorkos__chat_read';

  it.each([
    ['chat_stop', STOP, { chat: 'c1' }],
    ['chat_send interrupt', SEND, { to: 'c1', message: 'hi', delivery: 'interrupt' }],
    ['chat_send steer', SEND, { to: 'c1', message: 'hi', delivery: 'steer' }],
    ['chat_send with an unknown delivery', SEND, { to: 'c1', message: 'hi', delivery: 'x' }],
  ])('asks for %s in a turn held to a ceiling', async (_label, tool, input) => {
    expect(await gate(tool, input, true)).toBe('asked');
  });

  it.each([
    ['chat_send with no delivery', SEND, { to: 'c1', message: 'hi' }],
    ['chat_send queue', SEND, { to: 'c1', message: 'hi', delivery: 'queue' }],
    ['chat_read', READ, { chat: 'c1' }],
  ])('still auto-allows %s in a turn held to a ceiling', async (_label, tool, input) => {
    expect(await gate(tool, input, true)).toBe('allowed');
  });

  it.each([
    ['chat_stop', STOP, { chat: 'c1' }],
    ['chat_send interrupt', SEND, { to: 'c1', message: 'hi', delivery: 'interrupt' }],
  ])('auto-allows %s in a turn with no ceiling', async (_label, tool, input) => {
    expect(await gate(tool, input, false)).toBe('allowed');
  });
});

// Spec `official-community-space` D10. The CLI asks about a read only when it reaches past the
// agent's folder, or the web. A stranger's turn must not be waved through on those: any member of
// a space could otherwise make an agent read the computer and post what it found. Each case fails
// if the `'stranger'` rule in `isAutoAllowedCall` is removed, or widened to every ceiling.
describe('read-only tools under a stranger’s ceiling', () => {
  async function gate(
    toolName: string,
    ceilings: {
      turnPermissionCeiling?: 'runtime-default' | { asks: 'when-risky'; reach: 'workspace' };
      backgroundPermissionCeiling?: 'runtime-default';
    }
  ): Promise<'allowed' | 'asked'> {
    // Default, not Full: a chat set to Full never asks (DOR-3394), which this used until then.
    // Standing in the folder it reads, so only the ceiling decides (DOR-3300 has its own tests).
    const session = { ...makeSession('default'), cwd: '/etc', ...ceilings };
    const canUseTool = createCanUseTool(session, noopLog);
    return Promise.race([
      canUseTool(
        toolName,
        { file_path: '/etc/hosts', url: 'https://x' },
        makeContext('read-1')
      ).then(() => 'allowed' as const),
      new Promise<'asked'>((resolve) => setTimeout(() => resolve('asked'), 0)),
    ]);
  }

  it.each(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])(
    'asks for %s on a stranger’s turn',
    async (tool) => {
      expect(await gate(tool, { turnPermissionCeiling: 'runtime-default' })).toBe('asked');
    }
  );

  it('asks for one from background work a stranger’s turn left running', async () => {
    expect(await gate('Read', { backgroundPermissionCeiling: 'runtime-default' })).toBe('asked');
  });

  it('still auto-allows one under another agent’s ceiling, and with no ceiling', async () => {
    const agentLevel = { asks: 'when-risky', reach: 'workspace' } as const;
    expect(await gate('Read', { turnPermissionCeiling: agentLevel })).toBe('allowed');
    expect(await gate('Read', {})).toBe('allowed');
  });
});

describe('resolveModeDecision — the gate closes on non-match (DOR-604)', () => {
  /**
   * The whole decision table, written out. Each entry names the mode, the tool,
   * and the expected decision, so a regression says which cell moved.
   */
  const TABLE: ReadonlyArray<[PermissionMode, 'allow' | 'ask' | 'refuse']> = [
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
    // "Never ask" refuses what every other mode asks about (DOR-2838).
    ['dontAsk', 'refuse'],
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

describe('the scope an "Always Allow" card names (DOR-1462)', () => {
  /** A tool rule bound for one settings destination, as a real card carries it. */
  function rule(destination: PermissionUpdate['destination']): PermissionUpdate {
    return {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
      behavior: 'allow',
      destination,
    };
  }

  /** Raise one approval card and hand back everything it produced. */
  function raise(suggestions?: PermissionUpdate[]) {
    const session = makeBareSession();
    const context = {
      signal: new AbortController().signal,
      toolUseID: 'scope-1',
      ...(suggestions !== undefined ? { suggestions } : {}),
    } as ToolApprovalContext;
    void handleToolApproval(session, 'scope-1', 'Bash', { command: 'ls' }, context);
    const pushed = session.eventQueue.find((e) => e.type === 'approval_required');
    return {
      data: pushed?.data as Record<string, unknown> | undefined,
      snapshot: session.pendingInteractions.get('scope-1')?.snapshot as
        Record<string, unknown> | undefined,
      // The normalizer is the seam that decides which fields survive to the
      // client, so the assertion runs through the real one rather than stopping
      // at the raw payload.
      member: pushed ? toRawSessionEvent(pushed) : null,
    };
  }

  it('names the operator’s global settings when the batch would write them', () => {
    // The bug this closes: a card offering a `userSettings` suggestion moved the
    // operator's global CLI defaults on one click, and said only "Always Allow".
    const { data, snapshot, member } = raise([
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      rule('userSettings'),
    ]);

    expect(data).toMatchObject({ hasSuggestions: true, alwaysAllowScope: 'user' });
    // And on the recovery snapshot too, or a reloaded tab would draw the same
    // button with the scope silently gone.
    expect(snapshot).toMatchObject({ hasSuggestions: true, alwaysAllowScope: 'user' });
    expect(member).toMatchObject({ type: 'approval_required', alwaysAllowScope: 'user' });
  });

  it('says when an MCP card’s Always Allow would cover the whole server, and only then (DOR-4101)', () => {
    const raiseMcp = (toolName: string) => {
      const session = makeBareSession();
      const context = {
        signal: new AbortController().signal,
        toolUseID: 'breadth-1',
        suggestions: [{ ...rule('localSettings'), rules: [{ toolName }] }],
      } as ToolApprovalContext;
      void handleToolApproval(session, 'breadth-1', 'mcp__made-up__list', {}, context);
      const pushed = session.eventQueue.find((e) => e.type === 'approval_required')!;
      return {
        data: pushed.data as Record<string, unknown>,
        snapshot: session.pendingInteractions.get('breadth-1')?.snapshot,
        member: toRawSessionEvent(pushed),
      };
    };
    const wide = raiseMcp('mcp__made-up');
    expect(wide.data).toMatchObject({ alwaysAllowBreadth: 'server' });
    expect(wide.snapshot).toMatchObject({ alwaysAllowBreadth: 'server' });
    expect(wide.member).toMatchObject({ alwaysAllowBreadth: 'server' });
    const one = raiseMcp('mcp__made-up__list');
    expect(one.member).toMatchObject({ alwaysAllowBreadth: 'tool' });
    expect(raise([rule('localSettings')]).member).not.toHaveProperty('alwaysAllowBreadth');
  });
});

describe('counting the stops auto mode makes on DorkOS tools', () => {
  /**
   * The measurement half of spec `auto-mode-classifier-context`.
   *
   * Reaching the approval card in AUTO mode with a DorkOS tool means the
   * runtime's own classifier decided the call deserved a person, and DorkOS's
   * auto-allow list did not cover it — the exact stop the host-context note
   * exists to remove. Counting it here, rather than off a log grep afterwards,
   * is what makes "did it work" answerable at all.
   */
  const DORKOS_TOOL = 'mcp__dorkos__tasks_delete';

  beforeEach(() => {
    resetAutoModeStops();
  });

  it('counts a DorkOS tool that auto mode stopped on', () => {
    const session = makeSession('auto');
    void createCanUseTool(session, noopLog)(DORKOS_TOOL, { id: 'x' }, makeContext('tool-a'));

    const stats = autoModeStopStats();
    expect(stats.stops).toBe(1);
    expect(stats.stopsByTool).toEqual({ [DORKOS_TOOL]: 1 });
  });
});
