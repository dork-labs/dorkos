/**
 * DOR-3373: a scheduled run, with nobody there to ask, runs DorkOS's always-on reads in every
 * mode, and nothing that acts or changes slips through with them. A refused call is recorded as
 * refused, which is what the run's result reads (`refusedTools`, `needs_attention`).
 *
 * `acceptEdits` and `default` reach DorkOS's `canUseTool`; Never ask never does, so there the
 * Never ask hook decides (QA: under `dontAsk` the CLI calls no `canUseTool`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { PermissionMode, PermissionModeId } from '@dorkos/shared/schemas';
import { NO_APPROVAL_SURFACE } from '@dorkos/shared/run-refusals';
import { MCP_TOOL_TIERS } from '../../../../core/mcp-tool-tiers.js';
import { inSessionToolName } from '../../mcp-tools/tool-exposure.js';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../../messaging/interaction-wait.js';
import { NO_APPROVAL_SURFACE_DENIAL } from '../../sessions/tool-result-outcome.js';
import { ALWAYS_ON_READS } from '../always-on-reads.js';
import { autoAllowedByCall, DORKOS_AGENT_TOOLS } from '../auto-allow.js';
import { createNeverAskHook } from '../never-ask-hook.js';

const SDK = { name: 'dorkos', source: 'sdk' };
const noopLog = { debug: () => {}, info: () => {} };
const IDENTITY = async () => ({ identity: { agentPath: '/agents/ana' } });

/** The reads a scheduled health check calls: the six this fixes, and the live case. */
const READS = [...ALWAYS_ON_READS, 'accounts_usage'].map(inSessionToolName);
/** DorkOS tools that act or delete and are on no safe list: each must stay refused. */
const ACTS = ['tasks_create', 'tasks_delete', 'mesh_unregister'].map(inSessionToolName);

/** A scheduled run's session: nobody is there to answer a card. */
function unattended(permissionMode: PermissionMode) {
  return {
    permissionMode,
    unattended: true,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  } satisfies InteractiveSession & { permissionMode: PermissionMode };
}

function call(session: ReturnType<typeof unattended>, toolName: string) {
  return createCanUseTool(
    session,
    noopLog,
    undefined,
    IDENTITY
  )(
    toolName,
    {},
    { signal: new AbortController().signal, toolUseID: `use-${toolName}`, mcpServer: SDK }
  );
}

function neverAsk(toolName: string, mcpServer: { name: string; source: string } = SDK) {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/agents/ana',
    tool_name: toolName,
    tool_input: {},
    tool_use_id: 'use-1',
    mcp_server: mcpServer,
  } as HookInput;
  const session = { permissionMode: 'dontAsk' as PermissionModeId };
  return createNeverAskHook(session, IDENTITY, noopLog)(input, 'use-1', {
    signal: new AbortController().signal,
  });
}

describe('the always-on reads', () => {
  it('are reads nothing switches off, and every such read is on the safe list', () => {
    const tiers = MCP_TOOL_TIERS as Record<string, { tier: string; area: string | null }>;
    for (const name of ALWAYS_ON_READS) {
      expect(tiers[name], name).toMatchObject({ tier: 'observe', area: null });
    }
    const alwaysOn = Object.entries(tiers)
      .filter(([, t]) => t.tier === 'observe' && t.area === null)
      .map(([name]) => name);
    const missing = alwaysOn.filter((name) => !DORKOS_AGENT_TOOLS.has(inSessionToolName(name)));
    expect(missing, 'an always-on read a scheduled run would be refused').toEqual([]);
  });
});

describe.each(['acceptEdits', 'default'] as const)('a scheduled run at %s', (mode) => {
  it.each(READS)('runs %s with nobody there, and records no refusal', async (tool) => {
    const session = unattended(mode);
    expect(await call(session, tool)).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(session.eventQueue).toEqual([]);
  });

  it.each(ACTS)('still refuses %s, and records the refusal for the run', async (tool) => {
    const session = unattended(mode);
    expect(await call(session, tool)).toEqual({
      behavior: 'deny',
      message: NO_APPROVAL_SURFACE_DENIAL,
    });
    // The record the scheduler reads into `refusedTools`, so the run is not plain `completed`.
    expect(session.eventQueue).toEqual([
      expect.objectContaining({
        type: 'permission_denied',
        data: expect.objectContaining({ toolName: tool, reasonType: NO_APPROVAL_SURFACE }),
      }),
    ]);
  });

  it('still refuses the shell', async () => {
    const session = unattended(mode);
    expect(await call(session, 'Bash')).toMatchObject({ behavior: 'deny' });
  });
});

describe('a scheduled run at Never ask', () => {
  it.each(READS)('runs %s', async (tool) => {
    expect(await neverAsk(tool)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it.each([...ACTS, 'Bash'])('says nothing about %s, so Claude Code refuses it', async (tool) => {
    expect(await neverAsk(tool)).toEqual({});
  });

  it('gives nothing to a server that only calls itself dorkos', async () => {
    const impostor = { name: 'dorkos', source: 'project' };
    for (const tool of READS) expect(await neverAsk(tool, impostor)).toEqual({});
  });
});

describe('a stranger’s turn', () => {
  // A Telegram stranger's question must not read our computer unasked (Security's Must on
  // #3343): under a stranger's ceiling the six go to the mode table, which asks, as on main.
  const STRANGER = { turnPermissionCeiling: 'runtime-default' as const };

  it.each(ALWAYS_ON_READS.map(inSessionToolName))('does not run %s unasked', async (tool) => {
    for (const permissionMode of ['acceptEdits', 'default', 'dontAsk'] as PermissionModeId[]) {
      expect(autoAllowedByCall({ permissionMode, ...STRANGER }, tool, {}, SDK)).toBe(false);
    }
    const session = { permissionMode: 'dontAsk' as PermissionModeId, ...STRANGER };
    const input = {
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/agents/ana',
      tool_name: tool,
      tool_input: {},
      tool_use_id: 'use-1',
      mcp_server: SDK,
    } as HookInput;
    expect(
      await createNeverAskHook(session, IDENTITY, noopLog)(input, 'use-1', {
        signal: new AbortController().signal,
      })
    ).toEqual({});
  });
});
