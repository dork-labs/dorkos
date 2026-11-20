/**
 * DOR-3971: a Never ask run may call a short, named list of status reads, and nothing else
 * changes. Act and destructive tools stay refused, and so do the reads that return other
 * people's words (Security, Nov 8 and Nov 16), which stay opt-in per task. A turn that carries an
 * outsider's words gets none of the status reads.
 *
 * Under `dontAsk` the CLI calls no `canUseTool`, so the Never ask hook decides: an `allow` runs
 * the call, and saying nothing leaves it refused (QA, `hook-probe-2026-10-25`).
 */
import { describe, expect, it } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/schemas';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import { composeCapabilityRegistryForDocs } from '../../../../core/self-description/dorkos-registry.js';
import { inSessionToolName } from '../../mcp-tools/tool-exposure.js';
import { DORKOS_AGENT_TOOLS } from '../auto-allow.js';
import { createNeverAskHook } from '../never-ask-hook.js';
import {
  NEVER_ASK_STATUS_READS,
  NEVER_ASK_STATUS_READS_QUALIFIED,
} from '../never-ask-status-reads.js';

const SDK = { name: 'dorkos', source: 'sdk' };
const noopLog = { debug: () => {}, info: () => {} };
const IDENTITY = async () => ({ identity: { agentPath: '/agents/ana' } });
const NEVER_ASK = { permissionMode: 'dontAsk' as PermissionModeId };

/** The four reads Security named first. */
const STATUS_READS = [
  'running_chats',
  'tasks_get_run_history',
  'agents_recent_activity',
  'heartbeat_status',
];

/**
 * Reads that return other people's words, which Never ask still refuses: never on the list,
 * opt-in per task only.
 */
const PRIVATE_READS = [
  'transcript_read',
  'audit_query',
  'audit_get',
  'account_timeline',
  'connectors_execute_read',
];

/**
 * Reads of the caller's OWN rooms and chats. They already run at Never ask on an agent's
 * identity (DOR-3042: a Never ask room turn must read its own room); this list adds none of them.
 */
const OWN_ROOM_READS = ['read_room_history', 'search_room_history', 'search_member_rooms'];

/** Act and destructive DorkOS tools, on no safe list. */
const ACT = ['tasks_create', 'tasks_update', 'config_patch'];
const DESTRUCTIVE = ['tasks_delete', 'mesh_unregister'];

const registry = composeCapabilityRegistryForDocs();

/** Every tool's tier, by bare name, from both places a tier is declared. */
const tiers = new Map<string, string>([
  ...Object.entries(MCP_TOOL_TIERS as Record<string, { tier: string }>).map(
    ([name, t]) => [name, t.tier] as const
  ),
  ...registry.capabilities
    .filter((cap) => cap.surfaces.mcp !== undefined)
    .map((cap) => [cap.surfaces.mcp!.toolName, cap.tier] as const),
  // The connector tools declare no ordinary surface: they register by id, and Claude Code may
  // show the dot as `_`.
  ...registry.capabilities
    .filter((cap) => cap.id.startsWith('connectors.'))
    .map((cap) => [cap.id.replace('.', '_'), cap.tier] as const),
]);

type Session = {
  permissionMode: PermissionModeId;
  turnPermissionCeiling?: TurnPermissionCeiling;
  backgroundPermissionCeiling?: TurnPermissionCeiling;
};

function decide(
  bareName: string,
  options: {
    session?: Session;
    mcpServer?: { name: string; source: string };
    resolveIdentity?: () => Promise<unknown>;
    isMarked?: () => boolean;
    readOutsideWords?: () => boolean;
  } = {}
) {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/agents/ana',
    tool_name: bareName === 'Bash' ? 'Bash' : inSessionToolName(bareName),
    tool_input: {},
    tool_use_id: 'use-1',
    mcp_server: options.mcpServer ?? SDK,
  } as HookInput;
  return createNeverAskHook(
    options.session ?? NEVER_ASK,
    options.resolveIdentity ?? IDENTITY,
    noopLog,
    options.isMarked,
    options.readOutsideWords ?? (() => false)
  )(input, 'use-1', { signal: new AbortController().signal });
}

const ALLOWED = { hookSpecificOutput: { permissionDecision: 'allow' } };

describe('the Never ask status reads', () => {
  it('are the named list, each a real observe tool with a reason', () => {
    expect(Object.keys(NEVER_ASK_STATUS_READS).sort()).toEqual([...STATUS_READS].sort());
    for (const [name, reason] of Object.entries(NEVER_ASK_STATUS_READS)) {
      expect(tiers.get(name), name).toBe('observe');
      expect(reason.trim().length, `${name} needs its one-line reason`).toBeGreaterThan(0);
    }
  });

  it('never include a read that returns other people’s words', () => {
    for (const name of [...PRIVATE_READS, ...OWN_ROOM_READS, 'chat_read']) {
      expect(tiers.get(name), `${name} is a real tool`).toBe('observe');
      expect(NEVER_ASK_STATUS_READS, name).not.toHaveProperty(name);
    }
  });

  it('fail closed: a hook built without the outside-words check runs none (Security S3)', async () => {
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/agents/ana',
      tool_name: inSessionToolName('running_chats'),
      tool_input: {},
      tool_use_id: 'use-1',
      mcp_server: SDK,
    } as HookInput;
    const bare = createNeverAskHook(NEVER_ASK, IDENTITY, noopLog);
    expect(await bare(input, 'use-1', { signal: new AbortController().signal })).toEqual({});
  });

  it('share no name with the safe list, whose per-call checks they would skip', () => {
    const overlap = [...NEVER_ASK_STATUS_READS_QUALIFIED].filter((n) => DORKOS_AGENT_TOOLS.has(n));
    expect(overlap).toEqual([]);
  });
});

describe('a scheduled run at Never ask', () => {
  it.each(STATUS_READS)('runs %s', async (name) => {
    expect(await decide(name)).toMatchObject(ALLOWED);
  });

  it.each(STATUS_READS)('runs %s in a turn a teammate holds to a Never ask level', async (name) => {
    // A teammate's level that still never asks; one that asks moves the turn out of Never ask,
    // and `canUseTool` decides there instead.
    const session = {
      ...NEVER_ASK,
      turnPermissionCeiling: {
        asks: 'never',
        reach: 'everything',
      } as unknown as TurnPermissionCeiling,
    };
    expect(await decide(name, { session })).toMatchObject(ALLOWED);
  });

  it.each(PRIVATE_READS)('still refuses %s: it stays opt-in per task', async (name) => {
    expect(await decide(name)).toEqual({});
  });

  it('leaves the own room reads as they were: they run on an identity, and not without one', async () => {
    for (const name of OWN_ROOM_READS) {
      expect(await decide(name), name).toMatchObject(ALLOWED);
      expect(await decide(name, { resolveIdentity: async () => ({}) }), name).toEqual({});
    }
  });

  it.each(ACT)('still refuses the act tool %s', async (name) => {
    expect(tiers.get(name)).toBe('act');
    expect(await decide(name)).toEqual({});
  });

  it.each(DESTRUCTIVE)('still refuses the destructive tool %s', async (name) => {
    expect(tiers.get(name)).toBe('destructive');
    expect(await decide(name)).toEqual({});
  });

  it('still refuses the shell', async () => {
    expect(await decide('Bash')).toEqual({});
  });

  it('gives nothing to a server that only calls itself dorkos', async () => {
    const mcpServer = { name: 'dorkos', source: 'project' };
    for (const name of STATUS_READS) expect(await decide(name, { mcpServer })).toEqual({});
  });

  it('says nothing at Plan, Auto or Full, so the gate decides as before', async () => {
    for (const permissionMode of ['plan', 'auto', 'bypassPermissions']) {
      const session = { permissionMode: permissionMode as PermissionModeId };
      for (const name of STATUS_READS) expect(await decide(name, { session })).toEqual({});
    }
  });
});

// DOR-4601, PM ruling A: the same four reads run unasked at Ask first and Accept edits, with both
// of Security's conditions, the outsider refusal and the narrowed answers.
describe.each(['default', 'acceptEdits'] as const)('a scheduled run at %s', (permissionMode) => {
  const AT = { permissionMode: permissionMode as PermissionModeId };

  it.each(STATUS_READS)('runs %s with nobody there to answer a card', async (name) => {
    expect(await decide(name, { session: AT })).toMatchObject(ALLOWED);
  });

  it.each([...PRIVATE_READS, ...ACT, ...DESTRUCTIVE])(
    'says nothing about %s, so the gate decides as before',
    async (name) => {
      expect(await decide(name, { session: AT })).toEqual({});
    }
  );

  it('gives nothing to a server that only calls itself dorkos', async () => {
    const mcpServer = { name: 'dorkos', source: 'project' };
    for (const name of STATUS_READS) {
      expect(await decide(name, { session: AT, mcpServer })).toEqual({});
    }
  });

  const OUTSIDER_TURNS: Array<[string, Parameters<typeof decide>[1]]> = [
    ['a stranger’s own turn', { session: { ...AT, turnPermissionCeiling: 'runtime-default' } }],
    [
      'background work a stranger’s turn left running',
      { session: { ...AT, backgroundPermissionCeiling: 'runtime-default' } },
    ],
    [
      'a turn our agent passed an outsider’s words on to',
      {
        session: {
          ...AT,
          turnPermissionCeiling: {
            asks: 'never',
            reach: 'everything',
            outsider: true,
          } as unknown as TurnPermissionCeiling,
        },
      },
    ],
    ['a turn marked by a line it read', { session: AT, isMarked: () => true }],
    [
      'a chat that read outside words but carries no mark',
      { session: AT, readOutsideWords: () => true },
    ],
    [
      'a chat whose outside-words lookup throws',
      {
        session: AT,
        readOutsideWords: () => {
          throw new Error('no database');
        },
      },
    ],
  ];

  it.each(OUTSIDER_TURNS)('runs no status read unasked in %s', async (_label, options) => {
    for (const name of STATUS_READS) expect(await decide(name, options), name).toEqual({});
  });

  it('still runs them in a turn a teammate holds to this level', async () => {
    // A teammate's level, as a level: Ask first asks always, Accept edits when risky.
    const level = { asks: permissionMode === 'default' ? 'always' : 'when-risky', reach: 'edit' };
    const session = { ...AT, turnPermissionCeiling: level as unknown as TurnPermissionCeiling };
    for (const name of STATUS_READS)
      expect(await decide(name, { session }), name).toMatchObject(ALLOWED);
  });
});

describe('a Never ask turn that carries an outsider’s words', () => {
  const OUTSIDER_TURNS: Array<[string, Parameters<typeof decide>[1]]> = [
    [
      'a stranger’s own turn',
      { session: { ...NEVER_ASK, turnPermissionCeiling: 'runtime-default' } },
    ],
    [
      'background work a stranger’s turn left running',
      { session: { ...NEVER_ASK, backgroundPermissionCeiling: 'runtime-default' } },
    ],
    [
      'a turn our agent passed an outsider’s words on to',
      {
        session: {
          ...NEVER_ASK,
          turnPermissionCeiling: {
            asks: 'never',
            reach: 'everything',
            outsider: true,
          } as unknown as TurnPermissionCeiling,
        },
      },
    ],
    ['a turn marked by a line it read', { isMarked: () => true }],
    [
      'a turn whose mark lookup throws',
      {
        isMarked: () => {
          throw new Error('no record');
        },
      },
    ],
    // The wider DOR-4029 test: a chat binding, an outside sender or a connector event launched
    // the chat, or a room turn's note says it read a stranger, with no mark at all.
    ['a chat that read outside words but carries no mark', { readOutsideWords: () => true }],
    [
      'a chat whose outside-words lookup throws',
      {
        readOutsideWords: () => {
          throw new Error('no database');
        },
      },
    ],
  ];

  it.each(OUTSIDER_TURNS)('gives no status read to %s', async (_label, options) => {
    for (const name of STATUS_READS) expect(await decide(name, options), name).toEqual({});
  });
});
