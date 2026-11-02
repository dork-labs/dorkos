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
import {
  clampModeToCeiling,
  READ_ONLY_LEVEL,
  resolveCeilingLevel,
} from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { assignTurnBounds } from '../../../runtimes/claude-code/turn-bounds.js';
import {
  agentMarksRunning,
  carriesAllMarks,
  ceilingCarrying,
  ceilingOnlyRecords,
  hasMarks,
  marksForTurn,
  marksHold,
  marksOfCeiling,
  marksOfLevel,
  mergeMarks,
  NO_MARKS,
  TURN_MARK_KINDS,
  withMarks,
  type TurnMarkKind,
  type TurnMarks,
} from '../turn-marks.js';
import { markedBoundOf, marksOf, recordTurnLevels, unknownLevelMarks } from '../turn-levels.js';
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

/** A runtime through the level seam, every chat set to `stored` (Full unless said). */
function recorded(stored = 'bypassPermissions'): AgentRuntime {
  return recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
}

async function ran(
  sessionId: string,
  opts?: Parameters<AgentRuntime['sendMessage']>[2],
  stored?: string
) {
  for await (const _event of recorded(stored).sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

beforeEach(() => {
  resetLiveOutsiderTurns();
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

  it('off a send: its ceiling', () => {
    expect(marksForTurn(undefined)).toEqual({});
    expect(marksForTurn({ permissionCeiling: LEVEL })).toEqual({});
    expect(marksForTurn({ permissionCeiling: 'runtime-default' })).toEqual({ outsider: true });
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
    // A hold stays on its own turn: it bounds nothing that turn starts.
    expect(markedBoundOf(marked, undefined)).toBeUndefined();
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
    const markedAtFull = fresh();
    await ran(plain);
    // Below Full: a chat set to Full asks nobody anything (DOR-3394); this ran at Full until then.
    await ran(marked, { permissionCeiling: 'runtime-default' }, 'acceptEdits');
    await ran(markedAtFull, { permissionCeiling: 'runtime-default' });

    const forPlain = await resolveCallPermission({ action, identity, sessionId: plain });
    const forMarked = await resolveCallPermission({ action, identity, sessionId: marked });
    const atFull = await resolveCallPermission({ action, identity, sessionId: markedAtFull });
    // Trusted runs a destructive action of our own agents, recorded; a marked turn still asks.
    expect(forPlain).toMatchObject({ area: 'tasks', state: 'allowed' });
    expect(forMarked).toMatchObject({ area: 'tasks', state: 'ask' });
    expect(atFull).toMatchObject({ area: 'tasks', state: 'allowed' });
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
    const markedAtFull = fresh();
    await ran(plain);
    // Below Full, as above (DOR-3394); this ran at Full until then.
    await ran(marked, { permissionCeiling: 'runtime-default' }, 'acceptEdits');
    await ran(markedAtFull, { permissionCeiling: 'runtime-default' });

    const forPlain = await resolveCallPermission({ action, identity, sessionId: plain });
    const forMarked = await resolveCallPermission({ action, identity, sessionId: marked });
    const atFull = await resolveCallPermission({ action, identity, sessionId: markedAtFull });
    expect(forPlain).toMatchObject({ state: 'allowed' });
    expect(forMarked).toMatchObject({ state: 'ask' });
    expect(atFull).toMatchObject({ state: 'allowed' });
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
      // The chat is set to Full (its canonical id's record says so), so the marked sibling no
      // longer sends the call to a card (DOR-3394): it waits out the window like any Full chat's.
      // Until then this was `toBeUndefined()`. A chat below Full never reaches the window at all.
      expect(await holdRequesterFor(context, preflight)).toBeDefined();
      await elsewhere.return(undefined);
    } finally {
      clearTestHomes();
      await rm(root, { recursive: true, force: true });
    }
  });

  // A sender whose level is unknown answers for its own chat (DOR-3386), and only a teammate's
  // chain rides on (DOR-3440). A caller that names no chat is read through its agent.
  it('scope an unknown-level sender to its own chat, and hand on only a teammate’s chain', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-turn-marks-scope-'));
    const home = path.join(root, 'agents', 'lane');
    await mkdir(home, { recursive: true });
    registerTestHomes([home]);
    try {
      const held = recorded().sendMessage(fresh(), 'hi', {
        cwd: home,
        permissionCeiling: 'runtime-default',
      });
      await held.next();
      expect(agentMarksRunning(home)).toEqual({ outsider: true });
      expect(unknownLevelMarks([fresh()], home)).toEqual({});
      expect(unknownLevelMarks([], home)).toEqual({});
      await held.return(undefined);
      const teammate = [{ roomId: 'r', authorId: 'a' }];
      const chain = recorded('default').sendMessage(fresh(), 'hi', {
        cwd: home,
        permissionCeiling: { ...LEVEL, teammate },
      });
      await chain.next();
      expect(unknownLevelMarks([fresh()], home)).toEqual({});
      expect(unknownLevelMarks([], home)).toEqual({ teammate });
      await chain.return(undefined);
    } finally {
      clearTestHomes();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a teammate’s mark is a record that lowers nothing (DOR-3440)', () => {
  const PRIYA = { roomId: 'space-room', authorId: 'priya' };
  const record = ceilingCarrying({ teammate: [PRIYA] }) as TurnPermissionLevel;
  const declared = CLAUDE_CODE_CAPABILITIES.permissionModes;

  it('ceilingOnlyRecords: true only for a ceiling that bounds nothing', () => {
    expect(ceilingOnlyRecords(record)).toBe(true);
    expect(ceilingOnlyRecords([record])).toBe(true);
    expect(ceilingOnlyRecords('runtime-default')).toBe(false);
    expect(ceilingOnlyRecords(['runtime-default', record])).toBe(false);
    expect(ceilingOnlyRecords(READ_ONLY_LEVEL)).toBe(false);
    expect(ceilingOnlyRecords({ asks: 'never', reach: 'everything', outsider: true })).toBe(false);
    expect(ceilingOnlyRecords([])).toBe(false);
  });

  it('lowers no mode Claude Code declares, Full included', () => {
    const modes = declared.values.map((mode) => mode.id);
    expect(modes).toContain('bypassPermissions');
    for (const mode of modes) {
      expect(clampModeToCeiling(declared, mode, record), mode).toBe(mode);
    }
  });

  it('resolves to the loosest level, keeping who it came from, so the meter still reads them', () => {
    expect(resolveCeilingLevel(declared, record)).toMatchObject({
      asks: 'never',
      reach: 'everything',
      teammate: [PRIYA],
    });
    expect(marksForTurn({ permissionCeiling: record })).toEqual({ teammate: [PRIYA] });
  });

  it('beside a Wi-Fi hold, the hold still bounds the turn and the record still rides', () => {
    const held = ['runtime-default', record] as const;
    expect(clampModeToCeiling(declared, 'bypassPermissions', held)).toBe(
      clampModeToCeiling(declared, 'bypassPermissions', 'runtime-default')
    );
    expect(marksForTurn({ permissionCeiling: held })).toEqual({
      outsider: true,
      teammate: [PRIYA],
    });
  });

  it('marksHold: only the outsider mark holds anything back', () => {
    expect(marksHold({ teammate: [PRIYA] })).toBe(false);
    expect(marksHold(NO_MARKS)).toBe(false);
    expect(marksHold({ outsider: true })).toBe(true);
    expect(marksHold({ outsider: true, teammate: [PRIYA] })).toBe(true);
    // Still a mark, for what counts it.
    expect(hasMarks({ teammate: [PRIYA] })).toBe(true);
  });
});

describe('assignTurnBounds (DOR-3440)', () => {
  const record = ceilingCarrying({
    teammate: [{ roomId: 'r', authorId: 'a' }],
  }) as TurnPermissionLevel;

  it('sets no ceiling for a record, and clears an earlier one', () => {
    const session = { turnPermissionCeiling: 'runtime-default' } as Parameters<
      typeof assignTurnBounds
    >[0];
    assignTurnBounds(session, { permissionCeiling: record });
    expect(session.turnPermissionCeiling).toBeUndefined();
    expect(session).not.toHaveProperty('turnPermissionCeiling');
  });

  it('sets a Wi-Fi hold, alone or beside a record', () => {
    const session = {} as Parameters<typeof assignTurnBounds>[0];
    assignTurnBounds(session, { permissionCeiling: 'runtime-default' });
    expect(session.turnPermissionCeiling).toBe('runtime-default');
    const both = ['runtime-default', record] as const;
    assignTurnBounds(session, { permissionCeiling: both });
    expect(session.turnPermissionCeiling).toBe(both);
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
