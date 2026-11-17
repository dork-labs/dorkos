/**
 * DOR-4601 (PM ruling A): at Ask first and Accept edits, a scheduled run's four status reads run
 * unasked through `canUseTool` itself, by the same rule the Never ask hook reads. So the answer
 * holds whether or not the CLI honours the hook's `allow` before it calls `canUseTool`. A turn that
 * carries an outsider's words gets the level's own answer, which with nobody there is a refusal.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { PermissionMode } from '@dorkos/shared/schemas';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { NO_APPROVAL_SURFACE } from '@dorkos/shared/run-refusals';
import { inSessionToolName } from '../../mcp-tools/tool-exposure.js';
import { createCanUseTool } from '../../messaging/interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../../messaging/interaction-wait.js';
import { NO_APPROVAL_SURFACE_DENIAL } from '../../sessions/tool-result-outcome.js';
import { NEVER_ASK_STATUS_READS } from '../never-ask-status-reads.js';

const SDK = { name: 'dorkos', source: 'sdk' };
const noopLog = { debug: () => {}, info: () => {} };
const IDENTITY = async () => ({ identity: { agentPath: '/agents/ana' } });
const CLEAN: [() => boolean, () => boolean] = [() => false, () => false];

const STATUS_READS = Object.keys(NEVER_ASK_STATUS_READS).map(inSessionToolName);

/** A scheduled run's session: nobody is there to answer a card. */
function unattended(permissionMode: PermissionMode, turnPermissionCeiling?: TurnPermissionCeiling) {
  return {
    permissionMode,
    ...(turnPermissionCeiling ? { turnPermissionCeiling } : {}),
    unattended: true,
    pendingInteractions: new Map<string, PendingInteraction>(),
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
  } satisfies InteractiveSession & { permissionMode: PermissionMode };
}

function call(
  session: ReturnType<typeof unattended>,
  toolName: string,
  outsideChecks?: [() => boolean, () => boolean],
  mcpServer: { name: string; source: string } = SDK
) {
  return createCanUseTool(
    session,
    noopLog,
    undefined,
    IDENTITY,
    undefined,
    outsideChecks
  )(
    toolName,
    {},
    { signal: new AbortController().signal, toolUseID: `use-${toolName}`, mcpServer }
  );
}

const REFUSED = { behavior: 'deny', message: NO_APPROVAL_SURFACE_DENIAL };

describe.each(['default', 'acceptEdits'] as const)('a scheduled run at %s', (mode) => {
  it.each(STATUS_READS)('runs %s with nobody there, and records no refusal', async (tool) => {
    const session = unattended(mode);
    expect(await call(session, tool, CLEAN)).toEqual({ behavior: 'allow', updatedInput: {} });
    expect(session.eventQueue).toEqual([]);
  });

  it.each([
    ['a turn marked by a line it read', [() => true, () => false]],
    ['a chat that read outside words', [() => false, () => true]],
    [
      'a chat whose outside-words lookup throws',
      [
        () => false,
        () => {
          throw new Error('no database');
        },
      ],
    ],
  ] as const)('refuses every status read in %s, and records it', async (_label, checks) => {
    for (const tool of STATUS_READS) {
      const session = unattended(mode);
      expect(await call(session, tool, [...checks]), tool).toEqual(REFUSED);
      expect(session.eventQueue).toEqual([
        expect.objectContaining({
          type: 'permission_denied',
          data: expect.objectContaining({ toolName: tool, reasonType: NO_APPROVAL_SURFACE }),
        }),
      ]);
    }
  });

  it('refuses them in a stranger’s turn', async () => {
    for (const tool of STATUS_READS) {
      expect(await call(unattended(mode, 'runtime-default'), tool, CLEAN), tool).toEqual(REFUSED);
    }
  });

  it('fails closed: without the outside-words checks, no status read runs unasked', async () => {
    for (const tool of STATUS_READS) {
      expect(await call(unattended(mode), tool), tool).toEqual(REFUSED);
    }
  });

  it('gives nothing to a server that only calls itself dorkos', async () => {
    const impostor = { name: 'dorkos', source: 'project' };
    for (const tool of STATUS_READS) {
      expect(await call(unattended(mode), tool, CLEAN, impostor), tool).toEqual(REFUSED);
    }
  });

  it.each(
    ['tasks_create', 'tasks_delete', 'transcript_read', 'audit_query'].map(inSessionToolName)
  )('still refuses %s', async (tool) => {
    expect(await call(unattended(mode), tool, CLEAN)).toEqual(REFUSED);
  });
});

describe.each(['plan', 'auto'] as const)('at %s', (mode) => {
  it('still asks, so a scheduled run is refused', async () => {
    for (const tool of STATUS_READS) {
      expect(await call(unattended(mode), tool, CLEAN), tool).toEqual(REFUSED);
    }
  });
});
