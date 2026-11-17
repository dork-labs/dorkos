/**
 * DOR-3971: a Never ask run may call a short, named list of status reads, and nothing else
 * changes. Act and destructive tools stay refused, and so do the reads that return other
 * people's words (Security, Nov 8 and Nov 16), which stay opt-in per task.
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
import { createNeverAskHook } from '../never-ask-hook.js';
import { NEVER_ASK_STATUS_READS } from '../never-ask-status-reads.js';

const SDK = { name: 'dorkos', source: 'sdk' };
const noopLog = { debug: () => {}, info: () => {} };
const IDENTITY = async () => ({ identity: { agentPath: '/agents/ana' } });

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
const OWN_CONVERSATION_READS = [
  'read_room_history',
  'search_room_history',
  'search_member_rooms',
  'chat_read',
];

/** One act and one destructive DorkOS tool per tier, neither on any safe list. */
const ACT = ['tasks_create', 'tasks_update', 'config_patch'];
const DESTRUCTIVE = ['tasks_delete', 'mesh_unregister'];

/** Every tool's tier, by bare name, from both places a tier is declared. */
const tiers = new Map<string, string>([
  ...Object.entries(MCP_TOOL_TIERS as Record<string, { tier: string }>).map(
    ([name, t]) => [name, t.tier] as const
  ),
  ...composeCapabilityRegistryForDocs()
    .capabilities.filter((cap) => cap.surfaces.mcp !== undefined)
    .map((cap) => [cap.surfaces.mcp!.toolName, cap.tier] as const),
  // The connector tools register by id; Claude Code may show the dot as `_`.
  ...composeCapabilityRegistryForDocs().capabilities.map(
    (cap) => [cap.id.replace('.', '_'), cap.tier] as const
  ),
]);

function decide(
  bareName: string,
  session: {
    permissionMode: PermissionModeId;
    turnPermissionCeiling?: TurnPermissionCeiling;
  } = { permissionMode: 'dontAsk' as PermissionModeId },
  mcpServer: { name: string; source: string } = SDK
) {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/agents/ana',
    tool_name: bareName === 'Bash' ? 'Bash' : inSessionToolName(bareName),
    tool_input: {},
    tool_use_id: 'use-1',
    mcp_server: mcpServer,
  } as HookInput;
  return createNeverAskHook(session, IDENTITY, noopLog)(input, 'use-1', {
    signal: new AbortController().signal,
  });
}

describe('the Never ask status reads', () => {
  it('are the named list, each a real observe tool with a reason', () => {
    expect(Object.keys(NEVER_ASK_STATUS_READS).sort()).toEqual([...STATUS_READS].sort());
    for (const [name, reason] of Object.entries(NEVER_ASK_STATUS_READS)) {
      expect(tiers.get(name), name).toBe('observe');
      expect(reason.trim().length, `${name} needs its one-line reason`).toBeGreaterThan(0);
    }
  });

  it('never include a read that returns other people’s words', () => {
    for (const name of [...PRIVATE_READS, ...OWN_CONVERSATION_READS]) {
      expect(tiers.get(name), `${name} is a real tool`).toBe('observe');
      expect(NEVER_ASK_STATUS_READS, name).not.toHaveProperty(name);
    }
  });
});

describe('a scheduled run at Never ask', () => {
  it.each(STATUS_READS)('runs %s', async (name) => {
    expect(await decide(name)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it.each(PRIVATE_READS)('still refuses %s: it stays opt-in per task', async (name) => {
    expect(await decide(name)).toEqual({});
  });

  it('leaves the own room reads as they were: they still need an agent identity', async () => {
    for (const name of OWN_CONVERSATION_READS.filter((n) => n !== 'chat_read')) {
      const input = {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        transcript_path: '/tmp/t.jsonl',
        cwd: '/agents/ana',
        tool_name: inSessionToolName(name),
        tool_input: {},
        tool_use_id: 'use-1',
        mcp_server: SDK,
      } as HookInput;
      const noIdentity = createNeverAskHook(
        { permissionMode: 'dontAsk' as PermissionModeId },
        async () => ({}),
        noopLog
      );
      expect(
        await noIdentity(input, 'use-1', { signal: new AbortController().signal }),
        name
      ).toEqual({});
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
    const impostor = { name: 'dorkos', source: 'project' };
    for (const name of STATUS_READS) {
      expect(await decide(name, undefined, impostor)).toEqual({});
    }
  });

  it('gives nothing in a stranger’s turn', async () => {
    const stranger = {
      permissionMode: 'dontAsk' as PermissionModeId,
      turnPermissionCeiling: 'runtime-default' as const,
    };
    for (const name of STATUS_READS) expect(await decide(name, stranger)).toEqual({});
  });

  it('says nothing in every other mode, so the gate decides as before', async () => {
    for (const permissionMode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
      const session = { permissionMode: permissionMode as PermissionModeId };
      for (const name of STATUS_READS) expect(await decide(name, session)).toEqual({});
    }
  });
});
