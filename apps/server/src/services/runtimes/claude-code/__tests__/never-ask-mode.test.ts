/**
 * Claude Code's "Never ask" mode (`dontAsk`, DOR-2838) can only REFUSE: it never runs a call
 * another mode would have asked about, never ranks looser than Default anywhere a level is
 * weighed, and a stranger's turn keeps it (spec `official-community-space` D10, D11). The
 * official space's host agent runs in it, so every post it answers is a stranger's.
 *
 * Each block names the guard it pins; removing that guard turns the block red.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  PermissionModeDescriptor,
  TurnPermissionCeiling,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import {
  actsWithoutAsking,
  clampModeToCeiling,
  isDivergent,
  isNoLooserThan,
  levelOfMode,
  resolveTrustStops,
} from '@dorkos/shared/permission-semantics';
import type { StreamEvent } from '@dorkos/shared/types';
import { runningPermissionMode } from '../mcp-tools/session-start-permission.js';
import { createCanUseTool } from '../messaging/interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../messaging/interaction-wait.js';
import { CLAUDE_CODE_CAPABILITIES, NEVER_ASK_MODE_ID } from '../runtime-constants.js';
import { classifyToolResult, NEVER_ASK_DENIAL } from '../sessions/tool-result-outcome.js';
import {
  clampClaudeMode,
  gatePermissionMode,
  neverAsks,
  resolveModeDecision,
  turnPermissionMode,
} from '../turn-permission.js';
import { CODEX_CAPABILITIES } from '../../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../opencode/runtime-constants.js';
import { resolveApprovalDecision } from '../../opencode/messaging/approvals.js';
import { MODE_TO_SANDBOX } from '../../codex/turn-input.js';
import { rejectUndeclaredPermissionMode } from '../../../../routes/session-model-gate.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';

const CLAUDE = CLAUDE_CODE_CAPABILITIES.permissionModes;
const descriptor = (id: string): PermissionModeDescriptor =>
  CLAUDE.values.find((m) => m.id === id)!;
const NEVER = descriptor(NEVER_ASK_MODE_ID);
const PLAN: TurnPermissionLevel = { asks: 'always', reach: 'read' };
const DEFAULT = descriptor('default');

/** Every level the semantics can express, plus the stranger bound and a mixed list. */
const ASKS = ['always', 'when-risky', 'never'] as const;
const REACH = ['read', 'edit', 'workspace', 'everything'] as const;
const LEVELS: TurnPermissionLevel[] = ASKS.flatMap((asks) =>
  REACH.flatMap((reach) => [
    { asks, reach },
    { asks, reach, auto: true as const },
  ])
);
const CEILINGS: TurnPermissionCeiling[] = [
  ...LEVELS,
  'runtime-default',
  ['runtime-default', { asks: 'never', reach: 'everything' }],
];

describe('the Never ask descriptor', () => {
  it('is declared, at Default’s level, as a switch inside the Ask stop', () => {
    expect(NEVER).toMatchObject({ stop: 'ask', asks: DEFAULT.asks, reach: DEFAULT.reach });
    const ask = resolveTrustStops(CLAUDE.values).find((s) => s.stop === 'ask')!;
    expect(ask.mode.id).toBe('default');
    expect(ask.refinements.map((r) => r.id)).toEqual([NEVER_ASK_MODE_ID]);
  });

  it('ranks exactly as Default: no looser, and not flagged as acting without asking', () => {
    expect(isNoLooserThan(DEFAULT, NEVER)).toBe(true);
    expect(isNoLooserThan(NEVER, DEFAULT)).toBe(true);
    expect(actsWithoutAsking(NEVER)).toBe(false);
    expect(isDivergent(NEVER)).toBe(false);
    expect(levelOfMode(CLAUDE, NEVER_ASK_MODE_ID)).toEqual(levelOfMode(CLAUDE, 'default'));
  });

  it('is never where a Claude Code session is born', () => {
    expect(CLAUDE.default).toBe('default');
  });
});

describe('a ceiling never loosens Never ask (clampModeToCeiling)', () => {
  it.each(CEILINGS.map((c) => [JSON.stringify(c), c] as const))(
    'under %s it stays Never ask or drops to Plan',
    (_label, ceiling) => {
      expect([NEVER_ASK_MODE_ID, 'plan']).toContain(clampClaudeMode(NEVER_ASK_MODE_ID, ceiling));
    }
  );

  it('keeps Never ask on a stranger’s turn, the official host’s every turn', () => {
    expect(
      turnPermissionMode({
        permissionMode: NEVER_ASK_MODE_ID,
        turnPermissionCeiling: 'runtime-default',
      })
    ).toBe(NEVER_ASK_MODE_ID);
    const session = {
      permissionMode: NEVER_ASK_MODE_ID,
      turnPermissionCeiling: 'runtime-default' as const,
      backgroundPermissionCeiling: 'runtime-default' as const,
    };
    expect(gatePermissionMode(session)).toBe(NEVER_ASK_MODE_ID);
    expect(runningPermissionMode(session)).toBe(NEVER_ASK_MODE_ID);
    expect(neverAsks(session)).toBe(true);
  });

  it('is still held down by a ceiling stricter than Default, such as Plan', () => {
    expect(clampClaudeMode(NEVER_ASK_MODE_ID, PLAN)).toBe('plan');
    // Held to Plan, which asks, a chat set to never ask still asks nobody.
    expect(neverAsks({ permissionMode: NEVER_ASK_MODE_ID, turnPermissionCeiling: PLAN })).toBe(
      true
    );
    expect(neverAsks({ permissionMode: 'default', turnPermissionCeiling: PLAN })).toBe(false);
  });

  it('is never the stand-in for another mode a ceiling refuses', () => {
    for (const mode of CLAUDE.values.filter((m) => m.id !== NEVER_ASK_MODE_ID)) {
      for (const ceiling of CEILINGS) {
        expect(clampClaudeMode(mode.id, ceiling)).not.toBe(NEVER_ASK_MODE_ID);
      }
    }
    expect(clampClaudeMode('made-up', 'runtime-default')).toBe('default');
  });
});

describe('a ceiling recorded from Never ask widens nothing downstream', () => {
  const runtimes = [
    CLAUDE,
    CODEX_CAPABILITIES.permissionModes,
    OPENCODE_CAPABILITIES.permissionModes,
  ];
  const neverLevel = levelOfMode(CLAUDE, NEVER_ASK_MODE_ID)!;
  const defaultLevel = levelOfMode(CLAUDE, 'default')!;

  it('admits on every runtime exactly what Default’s level admits', () => {
    for (const declared of runtimes) {
      for (const mode of declared.values) {
        expect(clampModeToCeiling(declared, mode.id, neverLevel)).toBe(
          clampModeToCeiling(declared, mode.id, defaultLevel)
        );
      }
    }
  });
});

/** A bare interactive session at a mode, with the ceilings a test adds. */
function session(
  permissionMode: string,
  extra: Partial<{ turnPermissionCeiling: TurnPermissionCeiling }> = {}
): InteractiveSession & { permissionMode: string } {
  return {
    permissionMode,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    ...extra,
  };
}

const context = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });
const log = { debug: () => {}, info: () => {} };
const identity = async () => ({ identity: { agentId: 'host' } });

describe('the tool gate under Never ask (resolveModeDecision, createCanUseTool)', () => {
  it('decides refuse, never ask and never allow', () => {
    expect(resolveModeDecision(NEVER_ASK_MODE_ID)).toBe('refuse');
  });

  it.each([
    ['Bash', { command: 'ls' }],
    ['Write', { file_path: '/tmp/x', content: 'x' }],
    ['Read', { file_path: '/etc/hosts' }],
    ['WebFetch', { url: 'https://example.com' }],
    ['mcp__other__anything', {}],
    ['AskUserQuestion', { questions: [] }],
  ])('denies %s at once, and raises no card or question', async (tool, input) => {
    for (const extra of [
      {},
      { turnPermissionCeiling: 'runtime-default' as const },
      // A stricter ceiling clamps the turn to Plan, which asks: still refused.
      { turnPermissionCeiling: PLAN },
    ]) {
      const s = session(NEVER_ASK_MODE_ID, extra);
      const result = await createCanUseTool(s, log, undefined, identity)(tool, input, context('t'));
      expect(result).toEqual({ behavior: 'deny', message: NEVER_ASK_DENIAL });
      expect(s.eventQueue).toEqual([]);
      expect(s.pendingInteractions.size).toBe(0);
    }
  });

  it("still lets DorkOS's own safe-listed tools through, which never ask in any mode (DOR-3042)", async () => {
    // A Never ask run reads and posts to its own room; refusing these would
    // refuse what never asks. A foreign server wearing the name is not served
    // by DorkOS and is refused like any other tool.
    for (const tool of ['mcp__dorkos__mesh_list', 'mcp__dorkos__read_room_history']) {
      const s = session(NEVER_ASK_MODE_ID);
      const result = await createCanUseTool(s, log, undefined, identity)(tool, {}, context('t'));
      expect(result).toEqual({ behavior: 'allow', updatedInput: {} });
      expect(s.eventQueue).toEqual([]);
    }
    const s = session(NEVER_ASK_MODE_ID);
    const foreign = await createCanUseTool(
      s,
      log,
      undefined,
      identity
    )('mcp__dorkos__mesh_list', {}, { ...context('t'), mcpServer: { source: 'stdio' } } as never);
    expect(foreign).toEqual({ behavior: 'deny', message: NEVER_ASK_DENIAL });
  });

  it('records the refusal as denied in the transcript', () => {
    expect(classifyToolResult(NEVER_ASK_DENIAL, true)).toBe('denied');
  });
});

describe('Codex and OpenCode do not offer Never ask, and refuse it honestly', () => {
  const runtimeOf = (type: string, caps: typeof CODEX_CAPABILITIES) =>
    ({ type, getCapabilities: () => caps }) as unknown as AgentRuntime;

  it('is declared by Claude Code only', () => {
    expect(CODEX_CAPABILITIES.permissionModes.values.map((m) => m.id)).not.toContain('dontAsk');
    expect(OPENCODE_CAPABILITIES.permissionModes.values.map((m) => m.id)).not.toContain('dontAsk');
  });

  it('is refused by the sessions API on them and accepted on Claude Code', () => {
    expect(
      rejectUndeclaredPermissionMode(runtimeOf('codex', CODEX_CAPABILITIES), 'dontAsk')
    ).toMatch(/cannot run permission mode 'dontAsk'/);
    expect(
      rejectUndeclaredPermissionMode(runtimeOf('opencode', OPENCODE_CAPABILITIES), 'dontAsk')
    ).toMatch(/cannot run permission mode 'dontAsk'/);
    expect(
      rejectUndeclaredPermissionMode(runtimeOf('claude-code', CLAUDE_CODE_CAPABILITIES), 'dontAsk')
    ).toBeNull();
  });

  it('never runs anything unasked if a stray id reaches them anyway', () => {
    expect(MODE_TO_SANDBOX.dontAsk).toBeUndefined();
    for (const type of ['bash', 'edit', 'webfetch']) {
      expect(resolveApprovalDecision('dontAsk', type)).toBe('ask');
    }
  });
});
