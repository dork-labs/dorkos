import { createCapabilityMcpClient } from '../../runtimes/claude-code/mcp-tools/__tests__/capability-mcp-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import type { RoomHarness, ScriptedTurnRunner } from './room-test-harness.js';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
/** Real recorder/registry/MCP/service; only external runtime and install posture stand in. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { CapabilityInvocationContext } from '../../core/capabilities/registry.js';

let count = 0;
const fresh = () => `admission-casey-${++count}`;
const identity = {
  agentPath: '/agents/casey',
  displayName: 'Casey',
  createdAt: '2026-11-16T00:00:00Z',
};
let modules: {
  levels: typeof import('../../core/turn-power/turn-levels.js');
  capability: typeof import('../../core/capabilities/index.js');
  projection: typeof import('../../core/capabilities/mcp-projection.js');
  mcp: typeof import('../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js');
  registry: typeof import('../../core/runtime-registry.js');
  harness: typeof import('./room-test-harness.js');
  domain: typeof import('../room-capabilities.js');
  admission: typeof import('../handoff/handoff-admission.js');
  db: typeof import('@dorkos/db');
  worktree: typeof import('../repo/room-worktree-manager.js');
  repo: typeof import('../repo/room-repo-store.js');
};
let recorder: AgentRuntime;
async function record(session: string, opts?: MessageOpts) {
  for await (const event of recorder.sendMessage(session, 'local fixture', opts)) void event;
}
describe('public handoff CURRENT-policy admission', () => {
  let harness: RoomHarness;
  let runner: ScriptedTurnRunner;
  let registry: CapabilityRegistry;
  let room: RoomWithRoster;
  let temporaryHome: string;
  let releaseSource: (() => void) | undefined;
  let holdPlacement = false;
  let placementReached: Promise<void>;
  beforeEach(async () => {
    vi.resetModules();
    temporaryHome = mkdtempSync(join(tmpdir(), 'handoff-admission-'));
    vi.stubEnv('DORK_HOME', temporaryHome);
    const capability = await import('../../core/capabilities/index.js');
    capability.initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    modules = {
      capability,
      levels: await import('../../core/turn-power/turn-levels.js'),
      projection: await import('../../core/capabilities/mcp-projection.js'),
      mcp: await import('../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js'),
      registry: await import('../../core/runtime-registry.js'),
      harness: await import('./room-test-harness.js'),
      domain: await import('../room-capabilities.js'),
      admission: await import('../handoff/handoff-admission.js'),
      db: await import('@dorkos/db'),
      worktree: await import('../repo/room-worktree-manager.js'),
      repo: await import('../repo/room-repo-store.js'),
    };
    const { CLAUDE_CODE_CAPABILITIES } =
      await import('../../runtimes/claude-code/runtime-constants.js');
    const { FakeAgentRuntime } = await import('@dorkos/test-utils');
    const fake = new FakeAgentRuntime('claude-code');
    fake.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
    recorder = modules.levels.recordTurnLevels(fake, () => 'bypassPermissions');
    holdPlacement = false;
    let reached!: () => void;
    placementReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const placementGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    class HeldPlacement extends modules.worktree.RoomWorktreeManager {
      override async ensureWorktree(
        ...args: Parameters<
          InstanceType<typeof modules.worktree.RoomWorktreeManager>['ensureWorktree']
        >
      ) {
        if (holdPlacement) {
          reached();
          await placementGate;
        }
        return super.ensureWorktree(...args);
      }
    }
    let placement: InstanceType<typeof modules.worktree.RoomWorktreeManager> | null = null;
    runner = modules.harness.scriptedRunner(() => null);
    harness = modules.harness.createRoomHarness({
      agents: modules.harness.agentLookupFor({
        '/agents/casey': {
          id: 'casey-agent',
          name: 'casey',
          displayName: 'Casey',
          responseMode: 'mention-only',
        },
      }),
      runner,
      operatorName: () => 'Owner',
      worktrees: () => placement,
    });
    placement = new HeldPlacement({
      store: new modules.repo.RoomRepoStore(harness.db, temporaryHome),
      hasRepo: () => false,
      listStrandedWorktrees: async () => [],
      reapAfterDays: () => 14,
      busyAgentPaths: () => harness.service.listBusyAgentPaths(),
    });
    harness.db
      .insert(modules.db.agents)
      .values({
        id: 'casey-agent',
        name: 'casey',
        runtime: 'claude-code',
        projectPath: identity.agentPath,
        registeredAt: identity.createdAt,
        updatedAt: identity.createdAt,
      })
      .run();
    modules.registry.runtimeRegistry.setDb(harness.db);
    registry = modules.capability.composeRegistry([modules.domain.roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: harness.service },
    });
    room = harness.service.createRoom(
      { kind: 'channel', title: 'admission-fixture', members: [], agentPaths: ['/agents/casey'] },
      harness.human
    );
    harness.service.handoffs.initializeDurable(() => {});
  });
  afterEach(async () => {
    releaseSource?.();
    try {
      await harness?.service.handoffs.idle();
      await harness?.service.triggersIdle();
    } finally {
      modules?.capability.resetPermissionGate();
      // Registry exposes setDb but no reset/unset port. This test imports an isolated module
      // generation AFTER resetModules; evict that generation BEFORE closing its owned DB.
      // No shared imported singleton is injected or left pointing at this closed database.
      vi.resetModules();
      harness?.db.$client.close();
      vi.unstubAllEnvs();
      if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
      releaseSource = undefined;
    }
  });
  function seed(session: string) {
    harness.db
      .insert(modules.db.sessionMetadata)
      .values({
        sessionId: session,
        runtime: 'claude-code',
        agentPath: identity.agentPath,
        launchOrigin: 'interactive',
        createdAt: identity.createdAt,
      })
      .run();
  }
  function call(session: string, extra: Record<string, unknown> = {}) {
    return modules.projection.invokeCapabilityAsMcpResult(
      registry,
      'rooms.post',
      {
        roomId: room.id,
        text: 'A new draft',
        ...extra,
      },
      { identity, sessionId: session, mcpServer: 'in-session' }
    );
  }
  const author = () => harness.authors.resolveAgent(identity.agentPath, identity.displayName);
  it('admits a cross-runtime chat using its own runtime and the same agent identity', async () => {
    const session = fresh();
    seed(session);
    harness.db
      .update(modules.db.sessionMetadata)
      .set({ runtime: 'codex' })
      .where(modules.db.eq(modules.db.sessionMetadata.sessionId, session))
      .run();
    await record(session);
    expect(
      modules.admission.captureHandoffAdmission(harness.store, author(), session)?.recipient
    ).toMatchObject({ runtime: 'codex', agentId: 'casey-agent' });
  });
  it.each(['clean', 'outside'] as const)(
    'saves actual %s outside-word evidence independently of policy marks',
    async (words) => {
      const session = fresh();
      seed(session);
      await record(session);
      modules.levels.noteRoomTurnWords(session, words === 'outside');
      const admission = modules.admission.captureHandoffAdmission(
        harness.store,
        author(),
        session
      )!;
      // The carry holds the mark or leaves it out; the envelope below records the false.
      expect(admission.carried.outsideWords).toBe(words === 'outside' ? true : undefined);
      const envelope = modules.admission.handoffEnvelopeForAdmission(
        admission,
        {
          roomId: room.id,
          authorId: author().id,
          sessionId: 'seat',
          canonicalSessionId: 'seat',
          joinedAt: identity.createdAt,
          agentPath: identity.agentPath,
        },
        1000,
        121000
      );
      expect(envelope.carry.outsideWords).toBe(words === 'outside');
    }
  );
  it('admits a renamed recorded room turn with its exact original marks', async () => {
    const first = fresh(),
      renamed = fresh();
    seed(first);
    seed(renamed);
    await record(first, {
      roomTurn: { roomId: room.id, authorId: author().id, turnId: first },
      permissionCeiling: {
        asks: 'never',
        reach: 'everything',
        teammate: [{ roomId: room.id, authorId: author().id }],
      },
    });
    modules.levels.aliasTurnLevel(first, renamed);
    expect(
      modules.admission.captureHandoffAdmission(harness.store, author(), renamed)?.carried
    ).toMatchObject({
      teammate: true,
      permissionCeiling: { teammate: [{ roomId: room.id, authorId: author().id }] },
    });
  });
  it('falls back restrictively for a moved seat whose current capture is unavailable', async () => {
    const first = fresh(),
      moved = fresh();
    seed(first);
    seed(moved);
    await record(first);
    modules.levels.carryTurnLevel(first, moved);
    expect(modules.admission.captureHandoffAdmission(harness.store, author(), moved)).toMatchObject(
      {
        policyEvidence: 'conservative-fallback',
        carried: {
          outsideWords: true,
          outsider: true,
          permissionCeiling: expect.objectContaining({ asks: 'always', reach: 'read' }),
        },
      }
    );
  });
  it('keeps refused-turn teammate marks in the restrictive admission fallback', async () => {
    const session = fresh();
    seed(session);
    await record(session);
    const { setTeammateSpaceGate } = await import('../../core/turn-power/teammate-mark.js');
    setTeammateSpaceGate(() => false);
    try {
      await expect(
        record(session, {
          permissionCeiling: {
            asks: 'never',
            reach: 'everything',
            teammate: [{ roomId: room.id, authorId: author().id }],
          },
        })
      ).rejects.toThrow('monthly limit');
    } finally {
      setTeammateSpaceGate(null);
    }
    const admission = modules.admission.captureHandoffAdmission(harness.store, author(), session)!;
    expect(admission).toMatchObject({
      policyEvidence: 'conservative-fallback',
      carried: {
        outsideWords: true,
        outsider: true,
        teammate: true,
        permissionCeiling: {
          asks: 'always',
          reach: 'read',
          teammate: [{ roomId: room.id, authorId: author().id }],
        },
      },
    });
    expect(() =>
      modules.admission.handoffEnvelopeForAdmission(
        admission,
        {
          roomId: room.id,
          authorId: author().id,
          sessionId: 'seat',
          canonicalSessionId: 'seat',
          joinedAt: identity.createdAt,
          agentPath: identity.agentPath,
        },
        1000,
        121000
      )
    ).not.toThrow();
  });
  it('uses actual Full record without inventing a ceiling and freezes a distinct packet', async () => {
    const session = fresh();
    seed(session);
    await record(session);
    const packet = modules.admission.captureHandoffAdmission(harness.store, author(), session);
    expect(packet).toMatchObject({
      callerSessionId: session,
      agentPath: identity.agentPath,
      admittedSerial: modules.levels.turnSerialOf(session),
      policyEvidence: 'admission-current',
      wordEvidence: 'recorded',
      carried: { externalAuthor: false },
    });
    expect(packet?.carried.outsideWords).toBeUndefined();
    expect(packet?.carried.permissionCeiling).toBeUndefined();
    if (!packet) throw new Error('Real current admission did not capture');
    const envelope = modules.admission.handoffEnvelopeForAdmission(
      packet,
      {
        roomId: room.id,
        authorId: author().id,
        sessionId: 'seat',
        canonicalSessionId: 'seat',
        joinedAt: identity.createdAt,
        agentPath: identity.agentPath,
      },
      1000,
      121000
    );
    expect(envelope.version).toBe(2);
    expect(envelope.recipient).toEqual(packet.recipient);
    expect(envelope.recipient.createdAt).toBe(identity.createdAt);
    expect(Object.isFrozen(packet)).toBe(true);
    expect(Object.isFrozen(packet?.carried)).toBe(true);
    expect(
      modules.admission.captureHandoffAdmission(harness.store, author(), session)?.id
    ).not.toBe(packet?.id);
  });
  it('preserves actual monotonic teammate transfer and detached serial evidence', async () => {
    const session = fresh();
    seed(session);
    await record(session);
    modules.levels.markRunningTurn(session, {
      teammate: [{ roomId: room.id, authorId: author().id }],
    });
    const packet = modules.admission.captureHandoffAdmission(harness.store, author(), session);
    expect(packet?.carried).toMatchObject({
      teammate: true,
      permissionCeiling: {
        asks: 'never',
        reach: 'everything',
        teammate: [{ roomId: room.id, authorId: author().id }],
      },
    });
    expect(packet?.carried.outsideWords).toBeUndefined();
    const serial = packet?.admittedSerial;
    await record(session);
    expect(packet?.admittedSerial).toBe(serial);
    expect(
      modules.admission.captureHandoffAdmission(harness.store, author(), session)?.admittedSerial
    ).not.toBe(serial);
  });
  it('does not grant target membership when a recorded caller names another room', async () => {
    const session = fresh();
    seed(session);
    await record(session);
    const other = harness.service.createRoom(
      { kind: 'channel', title: 'not-a-member', members: [], agentPaths: [] },
      harness.human
    );
    const before = harness.store.listEntries(other.id, { limit: 100 });
    const result = await call(session, { roomId: other.id });
    expect(JSON.stringify(result)).toContain('ROOM_NOT_FOUND');
    expect(runner.turns).toHaveLength(0);
    expect(harness.store.listEntries(other.id, { limit: 100 })).toEqual(before);
  });
  it('real MCP parsing and Registry reach real RoomService with server context despite body forgery', async () => {
    const session = fresh();
    seed(session);
    await record(session, { permissionCeiling: 'runtime-default' });
    const result = await call(session, {
      sessionId: fresh(),
      agentPath: '/agents/forged',
      serial: 999,
      admission: { carried: {} },
    });
    expect(result.isError).not.toBe(true);
    await harness.service.handoffs.idle();
    expect(runner.turns.length).toBe(1);
    expect(runner.turns[0]).toMatchObject({
      agentPath: identity.agentPath,
      externalAuthor: true,
      carriedOutsider: true,
    });
  });
  it('a known chat with no recorded turn level is told to start a new turn', async () => {
    const session = fresh();
    seed(session);
    const result = await call(session);
    expect(JSON.stringify(result)).toContain('admission-policy-unavailable');
    expect(JSON.stringify(result)).toContain('Start a new turn, then hand it off.');
    await harness.service.handoffs.idle();
    expect(runner.turns).toHaveLength(0);
  });
  it('unknown verified session refuses before handoff queue, seat run or room write', async () => {
    const session = fresh();
    seed(session);
    const before = harness.store.listEntries(room.id, { limit: 100 });
    const result = await call(session, { sessionId: 'forged-known-session' });
    expect(JSON.stringify(result)).toContain('admission-policy-unavailable');
    await harness.service.handoffs.idle();
    expect(runner.turns).toHaveLength(0);
    expect(harness.store.listEntries(room.id, { limit: 100 })).toEqual(before);
  });
  it('captures CURRENT policy after actual MCP context await, not server construction policy', async () => {
    const session = fresh();
    seed(session);
    await record(session);
    let release!: (context: CapabilityInvocationContext) => void;
    const context = new Promise<CapabilityInvocationContext>((resolve) => {
      release = resolve;
    });
    const { tools } = await createCapabilityMcpClient(registry, 'in-session', async () => context);
    const post = tools.find((tool) => tool.name === 'post_to_room');
    if (!post) throw new Error('Actual MCP post tool missing');
    const pending = post.handler({ roomId: room.id, text: 'Current admission draft' }, {});
    await record(session, { permissionCeiling: 'runtime-default' });
    release({ identity, sessionId: session, mcpServer: 'in-session' });
    await pending;
    await harness.service.handoffs.idle();
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0]?.externalAuthor).toBe(true);
  });
  it('holds real placement IO after positive metadata admission without weakening the epoch witness', async () => {
    const session = fresh();
    seed(session);
    await record(session, { permissionCeiling: 'runtime-default' });
    holdPlacement = true;
    const packet = modules.admission.captureHandoffAdmission(harness.store, author(), session);
    expect(packet?.recipient.createdAt).toBe(identity.createdAt);
    const pending = harness.service.handoffs.handOff({
      roomId: room.id,
      author: author(),
      text: 'Original marked draft',
      verbatim: false,
      callerSessionId: session,
    });
    await placementReached;
    expect(runner.turns).toHaveLength(0);
    await record(session);
    releaseSource!();
    await pending;
    await harness.service.handoffs.idle();
    expect(runner.turns).toHaveLength(1);
    expect(runner.turns[0]?.externalAuthor).toBe(true);
    expect(packet?.recipient.createdAt).toBe(identity.createdAt);
  });
  it('refuses a positively recorded turn with missing recipient metadata before handoff side effects', async () => {
    const session = fresh();
    await record(session);
    const result = await call(session);
    expect(JSON.stringify(result)).toContain('admission-policy-unavailable');
    // The advice names what is missing, never "start a new turn", which cannot help (DOR-5035).
    expect(JSON.stringify(result)).toContain('can’t confirm this chat is yours');
    expect(JSON.stringify(result)).not.toContain('Start a new turn');
    expect(runner.turns).toHaveLength(0);
    expect(
      modules.admission.captureHandoffAdmission(harness.store, author(), session)
    ).toBeUndefined();
  });
});
