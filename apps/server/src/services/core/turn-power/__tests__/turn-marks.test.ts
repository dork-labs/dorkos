/**
 * The turn-mark set (DOR-3036): how marks are read off levels and ceilings, combined, compared,
 * and read by the permission gate. Marks only add up; nothing here takes one away.
 *
 * @vitest-environment node
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  agentMarksRunning,
  carriesAllMarks,
  hasMarks,
  marksForTurn,
  marksOfCeiling,
  marksOfLevel,
  mergeMarks,
  NO_MARKS,
  TURN_MARK_KINDS,
  withMarks,
  type TurnMarkKind,
  type TurnMarks,
} from '../turn-marks.js';
import { markedBoundOf, marksOf, recordTurnLevels } from '../turn-levels.js';
import { countWhileRunning, resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { gatedActionForMcpTool } from '../../mcp-tool-tiers.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import {
  initPermissionGate,
  resetPermissionGate,
  resolveCallPermission,
} from '../../capabilities/permission-enforcement.js';
import type {
  CapabilityInvocationContext,
  CapabilityPreflightResult,
} from '../../capabilities/registry.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../capabilities/index.js';
import { commitmentsDomain } from '../../../commitments/commitment-capabilities.js';
import { noteTurnOrigin, resetOutsiderTurns } from '../../../session/origin/outsider-turns.js';
import { holdRequesterFor } from '../../../connectors/execution/destructive-hold-window.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const LEVEL: TurnPermissionLevel = { asks: 'when-risky', reach: 'edit' };
const MARKED: TurnPermissionLevel = { ...LEVEL, outsider: true };

let counter = 0;
const fresh = () => `turn-marks-${(counter += 1)}`;

function recorded(): AgentRuntime {
  return recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
}

async function ran(sessionId: string, opts?: Parameters<AgentRuntime['sendMessage']>[2]) {
  for await (const _event of recorded().sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  resetOutsiderTurns();
});
afterEach(() => resetPermissionGate());

describe('reading marks', () => {
  it('off a level: its mark fields, or none for an unknown level', () => {
    expect(marksOfLevel(MARKED)).toEqual({ outsider: true });
    expect(marksOfLevel(LEVEL)).toEqual({});
    expect(marksOfLevel(undefined)).toBe(NO_MARKS);
  });

  it('off a ceiling: the runtime default, a marked level, or an empty list marks', () => {
    expect(marksOfCeiling('runtime-default')).toEqual({ outsider: true });
    expect(marksOfCeiling(MARKED)).toEqual({ outsider: true });
    expect(marksOfCeiling([])).toEqual({ outsider: true });
    expect(marksOfCeiling(LEVEL)).toEqual({});
    expect(marksOfCeiling([LEVEL, READ_ONLY_LEVEL])).toEqual({});
  });

  it('off a send: its ceiling, or a stranger’s line in view', () => {
    expect(marksForTurn(undefined)).toEqual({});
    expect(marksForTurn({ permissionCeiling: LEVEL })).toEqual({});
    expect(
      marksForTurn({ roomTurn: { roomId: 'r', authorId: 'a', turnId: 't', outsiderInView: true } })
    ).toEqual({ outsider: true });
  });
});

// Every kind runs through every helper, so a kind added to TURN_MARK_KINDS (teammate, tool-read)
// cannot be dropped by a helper that only knows the kinds that existed when it was written.
/** One value of each kind; a kind added to TURN_MARK_KINDS without one is a type error here. */
const SAMPLE: { [K in TurnMarkKind]-?: NonNullable<TurnMarks[K]> } = {
  outsider: true,
  teammate: [{ roomId: 'space-room', authorId: 'priya' }],
};

describe.each(TURN_MARK_KINDS)('the %s mark, through every helper', (kind) => {
  const only = { [kind]: SAMPLE[kind] } as TurnMarks;
  const levelWith = { ...LEVEL, [kind]: SAMPLE[kind] } as TurnPermissionLevel;

  it('is read off a level and off a ceiling holding that level', () => {
    expect(marksOfLevel(levelWith)).toEqual(only);
    expect(marksOfCeiling(levelWith)).toEqual(only);
    expect(marksOfCeiling([LEVEL, levelWith])).toEqual(only);
  });

  it('survives merging, is put on a level, and counts as a mark', () => {
    expect(mergeMarks(only, NO_MARKS)).toEqual(only);
    expect(mergeMarks(NO_MARKS, only)).toEqual(only);
    expect(withMarks(LEVEL, only)).toEqual(levelWith);
    expect(hasMarks(only)).toBe(true);
    expect(carriesAllMarks(NO_MARKS, only)).toBe(false);
    expect(carriesAllMarks(only, only)).toBe(true);
  });

  it('is counted against its agent while a turn carrying it runs', async () => {
    const turn = countWhileRunning(
      { cwd: '/agents/kind-probe' },
      only,
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    await turn.next();
    expect(agentMarksRunning('/agents/kind-probe')).toEqual(only);
    await turn.return(undefined);
    expect(agentMarksRunning('/agents/kind-probe')).toEqual({});
  });
});

describe('combining marks', () => {
  it('keeps every kind either set carries, and only adds', () => {
    expect(mergeMarks(NO_MARKS, { outsider: true })).toEqual({ outsider: true });
    expect(mergeMarks({ outsider: true }, NO_MARKS)).toEqual({ outsider: true });
    expect(mergeMarks(NO_MARKS, NO_MARKS)).toEqual({});
    expect(hasMarks({ outsider: true })).toBe(true);
    expect(hasMarks(NO_MARKS)).toBe(false);
  });

  it('puts marks on a level without changing its power, and never takes one off', () => {
    expect(withMarks(LEVEL, { outsider: true })).toEqual(MARKED);
    expect(withMarks(MARKED, NO_MARKS)).toBe(MARKED);
  });

  it('lets words join a turn only when it already carries every mark they do', () => {
    expect(carriesAllMarks({ outsider: true }, NO_MARKS)).toBe(true);
    expect(carriesAllMarks({ outsider: true }, { outsider: true })).toBe(true);
    expect(carriesAllMarks(NO_MARKS, { outsider: true })).toBe(false);
  });
});

describe('the readers', () => {
  it('read a recorded turn, and an unrecorded caller through its agent', async () => {
    const plain = fresh();
    const marked = fresh();
    await ran(plain);
    await ran(marked, { permissionCeiling: 'runtime-default' });
    expect(marksOf(plain, undefined)).toEqual({});
    expect(markedBoundOf(plain, undefined)).toBeUndefined();
    expect(marksOf(marked, undefined)).toEqual({ outsider: true });
    expect(markedBoundOf(marked, undefined)).toMatchObject({ outsider: true });
    expect(marksOf(undefined, '/agents/nobody-running')).toEqual({});
  });

  it('hold the permission gate’s stranger rule for a marked turn, and only for one', async () => {
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    const identity = {
      agentPath: '/agents/scout',
      displayName: 'Scout',
      createdAt: new Date().toISOString(),
    };
    const action = gatedActionForMcpTool('tasks_delete');
    const plain = fresh();
    const marked = fresh();
    await ran(plain);
    await ran(marked, { permissionCeiling: 'runtime-default' });

    const forPlain = await resolveCallPermission({ action, identity, sessionId: plain });
    const forMarked = await resolveCallPermission({ action, identity, sessionId: marked });
    // Trusted runs a destructive action of our own agents, recorded; a marked turn still asks.
    expect(forPlain).toMatchObject({ area: 'tasks', state: 'allowed' });
    expect(forMarked).toMatchObject({ area: 'tasks', state: 'ask' });
  });

  it('hold an edit to who the agent is for a person in a marked turn (DOR-3036)', async () => {
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    const identity = {
      agentPath: '/agents/scout',
      displayName: 'Scout',
      createdAt: new Date().toISOString(),
    };
    const action = composeCapabilityRegistryForDocs().capabilities.find(
      (capability) => capability.id === 'operator.update_agent'
    )!;
    const plain = fresh();
    const marked = fresh();
    await ran(plain);
    await ran(marked, { permissionCeiling: 'runtime-default' });

    const forPlain = await resolveCallPermission({ action, identity, sessionId: plain });
    const forMarked = await resolveCallPermission({ action, identity, sessionId: marked });
    expect(forPlain).toMatchObject({ state: 'allowed' });
    expect(forMarked).toMatchObject({ state: 'ask' });
  });

  it('keep the destructive hold from a chat known by a second id while its agent reads an outsider', async () => {
    // The chat is known by two ids: one recorded never-asking and unmarked, one this process has no
    // record of. Its agent has a marked turn running, so the unrecorded id reads as marked and the
    // call keeps its card rather than starting the 60-second hold.
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    const root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-turn-marks-hold-'));
    const home = path.join(root, 'agents', 'scout');
    await mkdir(home, { recursive: true });
    registerTestHomes([home]);
    try {
      const canonical = fresh();
      await ran(canonical);
      const context = {
        identity: { agentPath: home, displayName: 'Scout', createdAt: new Date().toISOString() },
        sessionId: fresh(),
        serverPrincipal: createServerPrincipal({
          kind: 'runtime',
          owner: { kind: 'local_install', installationId: 'install-a' },
          bindingId: 'binding-a',
          runtime: 'claude-code',
          canonicalSessionId: canonical,
          agentId: 'agent-scout',
          agentPath: home,
          canonicalCwd: home,
        }),
      } as unknown as CapabilityInvocationContext;
      const preflight = {
        approvalServiceAction: { id: 'connectors.execute_destructive' },
      } as unknown as CapabilityPreflightResult;

      expect(await holdRequesterFor(context, preflight)).toBeDefined();
      const elsewhere = recorded().sendMessage(fresh(), 'hi', {
        cwd: home,
        permissionCeiling: 'runtime-default',
      });
      await elsewhere.next();
      expect(await holdRequesterFor(context, preflight)).toBeUndefined();
      await elsewhere.return(undefined);
    } finally {
      clearTestHomes();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tell a capability its turn was started by a stranger, from the direct reading', async () => {
    const registry = composeRegistry([commitmentsDomain], {
      logger: noopLogger,
      // A list nobody reads, unless a turn gets past the stranger check.
      commitmentDeps: { service: { list: () => [] } } as never,
    });
    const list = async (sessionId: string): Promise<{ code?: string }> => {
      try {
        return (await registry.invoke('commitments.list', {}, { sessionId })) as { code?: string };
      } catch (error) {
        // With no commitments wired, a turn that is let through fails past the stranger check.
        return { code: error instanceof Error ? 'THREW' : 'UNKNOWN' };
      }
    };
    const stranger = fresh();
    noteTurnOrigin(stranger, { kind: 'relay-binding' } as never);
    expect(await list(stranger)).toMatchObject({ code: 'OUTSIDER_TURN' });
    expect(await list(fresh())).not.toMatchObject({ code: 'OUTSIDER_TURN' });
  });
});

describe('the marks of a turn a continuation’s hold clamped (DOR-3203)', () => {
  const teammate = { ...READ_ONLY_LEVEL, teammate: [{ roomId: 'r', authorId: 'a' }] };

  it('takes nothing from the hold itself', () => {
    expect(marksForTurn({ permissionCeiling: 'runtime-default', continuationHold: true })).toEqual(
      {}
    );
    expect(marksForTurn({ permissionCeiling: 'runtime-default' })).toEqual({ outsider: true });
  });

  it('keeps every other bound’s marks, a second runtime default included', () => {
    expect(
      marksForTurn({ permissionCeiling: ['runtime-default', teammate], continuationHold: true })
    ).toEqual({ teammate: teammate.teammate });
    expect(
      marksForTurn({
        permissionCeiling: ['runtime-default', 'runtime-default'],
        continuationHold: true,
      })
    ).toMatchObject({ outsider: true });
  });
});
