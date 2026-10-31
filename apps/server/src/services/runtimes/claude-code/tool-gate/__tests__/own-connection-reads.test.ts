/**
 * DOR-3205: a scheduled run, with nobody there to ask, can list its own connected accounts and
 * what each grant covers, in every mode. The tools that act on those accounts stay refused, and
 * so do a stranger's turn and a teammate's.
 *
 * `acceptEdits` and `default` reach DorkOS's `canUseTool`; Never ask never does, so there the
 * Never ask hook decides (QA: under `dontAsk` the CLI calls no `canUseTool`).
 */
import { describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import type { PermissionMode, PermissionModeId } from '@dorkos/shared/schemas';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { NO_APPROVAL_SURFACE } from '@dorkos/shared/run-refusals';
import {
  TEAMMATE_TIER_DENIAL,
  teammateTierRefusal,
} from '../../../../core/turn-power/teammate-tier.js';
import { CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS } from '../../../../connectors/runtime-capability-scope.js';
import { inSessionToolName } from '../../mcp-tools/tool-exposure.js';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../../messaging/interaction-wait.js';
import { NO_APPROVAL_SURFACE_DENIAL } from '../../sessions/tool-result-outcome.js';
import { autoAllowedByCall } from '../auto-allow.js';
import { createNeverAskHook, type NeverAskSession } from '../never-ask-hook.js';

const SDK = { name: 'dorkos', source: 'sdk' };
const noopLog = { debug: () => {}, info: () => {} };
const IDENTITY = async () => ({ identity: { agentPath: '/agents/ana' } });

/** Both reads, by both names Claude Code can send: the capability id, and the id with `_`. */
const READS = [
  'connectors.list_granted_connections',
  'connectors_list_granted_connections',
  'connectors.list_granted_operations',
  'connectors_list_granted_operations',
].map(inSessionToolName);
/** The tools that act on the accounts, by both names: never on the safe list. */
const EXECUTES = CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS.flatMap((id) => [
  inSessionToolName(id),
  inSessionToolName(id.replace('.', '_')),
]);
const INPUT = { connectionId: 'connection-1' };

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
  )(toolName, INPUT, {
    signal: new AbortController().signal,
    toolUseID: `use-${toolName}`,
    mcpServer: SDK,
  });
}

function neverAsk(
  toolName: string,
  extra: Partial<NeverAskSession> = {},
  mcpServer: { name: string; source: string } = SDK,
  isMarked: () => boolean = () => false
) {
  const input = {
    hook_event_name: 'PreToolUse',
    session_id: 's',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/agents/ana',
    tool_name: toolName,
    tool_input: INPUT,
    tool_use_id: 'use-1',
    mcp_server: mcpServer,
  } as HookInput;
  const session = { permissionMode: 'dontAsk' as PermissionModeId, ...extra };
  return createNeverAskHook(
    session,
    IDENTITY,
    noopLog,
    isMarked
  )(input, 'use-1', {
    signal: new AbortController().signal,
  });
}

describe.each(['acceptEdits', 'default'] as const)('a scheduled run at %s', (mode) => {
  it.each(READS)('runs %s with nobody there, and records no refusal', async (tool) => {
    const session = unattended(mode);
    expect(await call(session, tool)).toEqual({ behavior: 'allow', updatedInput: INPUT });
    expect(session.eventQueue).toEqual([]);
  });

  it.each(EXECUTES)('still refuses %s, and records the refusal for the run', async (tool) => {
    const session = unattended(mode);
    expect(await call(session, tool)).toEqual({
      behavior: 'deny',
      message: NO_APPROVAL_SURFACE_DENIAL,
    });
    expect(session.eventQueue).toEqual([
      expect.objectContaining({
        type: 'permission_denied',
        data: expect.objectContaining({ toolName: tool, reasonType: NO_APPROVAL_SURFACE }),
      }),
    ]);
  });
});

describe('a scheduled run at Never ask', () => {
  it.each(READS)('runs %s', async (tool) => {
    expect(await neverAsk(tool)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it.each(EXECUTES)('says nothing about %s, so Claude Code refuses it', async (tool) => {
    expect(await neverAsk(tool)).toEqual({});
  });

  it('gives nothing to a server that only calls itself dorkos', async () => {
    const impostor = { name: 'dorkos', source: 'project' };
    for (const tool of READS) expect(await neverAsk(tool, {}, impostor)).toEqual({});
  });
});

describe('a turn another of our agents started (held to a ceiling)', () => {
  // Its own grants, read for a colleague on this DorkOS: it runs, unlike the usage tools.
  const HELD = {
    turnPermissionCeiling: { asks: 'when-risky', reach: 'edit' } as TurnPermissionCeiling,
  };

  it.each(READS)('runs %s unasked', (tool) => {
    for (const permissionMode of ['acceptEdits', 'default'] as PermissionModeId[]) {
      expect(autoAllowedByCall({ permissionMode, ...HELD }, tool, INPUT, SDK)).toBe(true);
    }
  });
});

describe('a turn that carries an outsider’s words', () => {
  // An outsider's question must not read out which of the owner's accounts are connected.
  const STRANGER = { turnPermissionCeiling: 'runtime-default' as const };
  const CARRIED = {
    turnPermissionCeiling: {
      asks: 'never',
      reach: 'everything',
      outsider: true,
    } as unknown as TurnPermissionCeiling,
  };

  it.each(READS)('does not run %s unasked in a stranger’s own turn', async (tool) => {
    for (const permissionMode of ['acceptEdits', 'default', 'dontAsk'] as PermissionModeId[]) {
      expect(autoAllowedByCall({ permissionMode, ...STRANGER }, tool, INPUT, SDK)).toBe(false);
    }
    expect(await neverAsk(tool, STRANGER)).toEqual({});
  });

  it.each(READS)('does not run %s unasked when our agents passed the words on', async (tool) => {
    for (const permissionMode of ['acceptEdits', 'default', 'dontAsk'] as PermissionModeId[]) {
      expect(autoAllowedByCall({ permissionMode, ...CARRIED }, tool, INPUT, SDK)).toBe(false);
    }
    expect(await neverAsk(tool, CARRIED)).toEqual({});
  });

  it.each(READS)(
    'does not run %s at Never ask in a turn a stranger’s line marked',
    async (tool) => {
      expect(await neverAsk(tool, {}, SDK, () => true)).toEqual({});
      expect(
        await neverAsk(tool, {}, SDK, () => {
          throw new Error('no marks');
        })
      ).toEqual({});
    }
  );
});

describe('a teammate’s turn', () => {
  it.each(READS)('refuses %s at the fence, and Never ask says nothing', async (tool) => {
    const name = tool.slice(inSessionToolName('').length);
    expect(
      teammateTierRefusal({ roomId: 'room-1' }, { source: 'dorkos', name, input: INPUT })
    ).toBe(TEAMMATE_TIER_DENIAL);
    expect(await neverAsk(tool, { teammateTier: { roomId: 'room-1' } })).toEqual({});
  });
});
