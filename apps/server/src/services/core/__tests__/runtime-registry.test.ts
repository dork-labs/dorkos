import type { SessionBirthWriteContext } from '../runtime-seam/session-birth-write.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RuntimeRegistry,
  RuntimeNotRegisteredError,
  applyConfiguredDefaultRuntime,
  applyAndWatchConfiguredDefaultRuntime,
  registerOptionalRuntime,
} from '../runtime-registry.js';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import { SessionSettingsSchema } from '@dorkos/shared/schemas';
import { readDraftSource } from '../runtime-seam/person-draft-settings.js';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  sessionContext,
  sessionBirthAllocations,
  sessionLocations,
  authors,
  roomSessions,
  sessionMetadata,
  sessionNativeBindings,
  eq,
  sql,
  type Db,
} from '@dorkos/db';
import { logger } from '../../../lib/logger.js';
import { RequiredSessionIdentityError } from '../../../lib/replay/required-session-identity-error.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../session/fleet/session-limit-store.js';
import type { TurnOrigin } from '../../session/index.js';

// Minimal mock runtime for testing
function createMockRuntime(type: string, overrides?: Partial<RuntimeCapabilities>): AgentRuntime {
  return {
    type,
    ensureSession: () => {},
    hasSession: () => false,
    updateSession: () => ({ updated: true }),
    sendMessage: async function* () {},
    approveTool: () => true,
    submitAnswers: () => true,
    listSessions: async () => [],
    getSession: async () => null,
    getMessageHistory: async () => [],
    getSessionTasks: async () => [],
    getSessionETag: async () => null,
    readFromOffset: async () => ({ content: '', newOffset: 0 }),
    acquireLock: () => true,
    releaseLock: () => {},
    isLocked: () => false,
    getLockInfo: () => null,
    getSupportedModels: async () => [],
    getCapabilities: () => ({
      type,
      supportsToolApproval: true,
      supportsCostTracking: true,
      supportsResume: true,
      supportsMcp: true,
      supportsQuestionPrompt: true,
      supportsPlugins: true,
      permissionModes: {
        supported: true,
        values: [
          {
            id: 'default',
            label: 'Default',
            stop: 'ask',
            asks: 'always',
            reach: 'edit',
            promise: 'Asks first.',
          },
        ],
      },
      features: {},
      // A mock runtime declares nothing configurable unless a test says otherwise.
      settings: { configSection: null, supportsEffort: true, sections: [] },
      ...overrides,
    }),
    getCommands: async () => ({ commands: [], lastScanned: new Date().toISOString() }),
    checkSessionHealth: () => {},
    getInternalSessionId: () => undefined,
  } as AgentRuntime;
}

/**
 * What the server's per-runtime defaults resolve to for this file's registry.
 * Stubbed because WHERE the defaults come from is `resolve-session-defaults`'s
 * own question — the registry's claim is only that they ride a row's creation,
 * under whatever the caller wrote.
 */
let serverDefaults: SessionSettings = {};

/**
 * What the OWNING AGENT's manifest says, for whichever `agentPath` a call
 * carries. Stubbed for the same reason: reading `.dork/agent.json` is the
 * resolver's job, and the registry's claim is only that it asks about the agent
 * it was handed and lets the answer outrank the server's.
 */
let agentDefaults: SessionSettings = {};

/**
 * What the resolver answers ONLY when the caller hands it the runtime's declared
 * modes — the operator's configured trust stop (spec `trust-dial`, decision 6).
 * Kept separate from {@link serverDefaults} so a test can ask the one question
 * the registry owns here: which turn origins get offered it at all (DOR-2105).
 */
let configuredStopDefaults: SessionSettings = {};

/** The options the registry last handed the resolver, for the same question. */
let lastResolveOpts: { runtimeType?: string; permissionModes?: readonly unknown[] } | null = null;

vi.mock('../../session/resolution/resolve-session-defaults.js', () => ({
  resolveSessionDefaults: (opts: {
    runtimeType?: string;
    agent?: SessionSettings;
    permissionModes?: readonly unknown[];
  }) => {
    lastResolveOpts = opts;
    return {
      ...serverDefaults,
      ...(opts.permissionModes ? configuredStopDefaults : {}),
      ...(opts.agent ?? {}),
    };
  },
  readAgentExecutionDefaults: async (dir?: string) => (dir ? agentDefaults : {}),
}));

/**
 * The origin for a case that is not about power at all.
 *
 * Most of this file is about binding, claiming, agent paths and the
 * model/effort seed, and which surface started the session changes none of
 * them. They still have to name one, because the argument is required, so they
 * name the ordinary one: a person at the app. The cases that ARE about power
 * name their origin inline, right where the reader needs to see it.
 */
const A_PERSON: TurnOrigin = { kind: 'interactive' };

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
    serverDefaults = {};
    agentDefaults = {};
    configuredStopDefaults = {};
    lastResolveOpts = null;
  });

  describe('register and get', () => {
    // Spec `audit-trail` PR3: the one seam every turn passes through records
    // every tool call, so a runtime registered here cannot run a tool unseen.
    it('wraps a registered runtime so its tool calls reach the audit log', async () => {
      const { initAuditTrail, resetAuditTrail } = await import('../../audit/audit-trail.js');
      const { AuditLog } = await import('../../audit/audit-log.js');
      const { AccountIds } = await import('../../audit/account-ids.js');
      const { auditEvents } = await import('@dorkos/db');
      const db = createTestDb();
      initAuditTrail({
        log: new AuditLog(db),
        accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
      });
      try {
        registry.register({
          ...createMockRuntime('claude-code'),
          sendMessage: async function* () {
            yield {
              type: 'tool_call_start',
              data: {
                toolCallId: 't1',
                toolName: 'Bash',
                input: '{"command":"ls"}',
                status: 'running',
              },
            };
            yield {
              type: 'tool_result',
              data: { toolCallId: 't1', toolName: 'Bash', status: 'complete' },
            };
          },
        } as AgentRuntime);
        for await (const _event of registry.get('claude-code').sendMessage('s1', 'go', {})) {
          // drain
        }
        expect(
          db
            .select()
            .from(auditEvents)
            .all()
            .map((row) => [row.action, row.targetId])
        ).toEqual([['runtime.tool_used', 'ls']]);
      } finally {
        resetAuditTrail();
      }
    });

    // Spec `audit-trail` PR5: the backstop. A turn for a paused agent is
    // refused at the one seam every turn passes, whatever surface started it.
    it('refuses a paused agent’s turn sent straight through the registry', async () => {
      const { AgentPauseService, initAgentPause, resetAgentPause } =
        await import('../../mesh/pause/agent-pause.js');
      const { setAgentHomeRegistry } = await import('../agent-identity/agent-home.js');
      const { agents } = await import('@dorkos/db');
      const db = createTestDb();
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: 'agent-1',
          name: 'scout',
          runtime: 'claude-code',
          projectPath: '/projects/scout',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      setAgentHomeRegistry({
        isRegisteredHome: (dir) => dir === '/projects/scout',
        listRegisteredHomes: () => ['/projects/scout'],
        managedWorkspaceOwner: () => null,
        roomsDir: null,
      });
      const pauses = new AgentPauseService({ db });
      initAgentPause(pauses);
      try {
        await pauses.pause('agent-1', { accountId: 'p', kind: 'person', name: 'Owner' });
        const sent = vi.fn();
        registry.register({
          ...createMockRuntime('claude-code'),
          sendMessage: async function* () {
            sent();
          },
        } as AgentRuntime);
        const turn = registry
          .get('claude-code')
          .sendMessage('s1', 'go', { cwd: '/projects/scout' });
        await expect(turn.next()).rejects.toMatchObject({ code: 'AGENT_PAUSED' });
        expect(sent).not.toHaveBeenCalled();
      } finally {
        resetAgentPause();
        setAgentHomeRegistry(undefined);
      }
    });
  });

  describe('resolveForAgent', () => {
    it('returns agent-specific runtime when meshCore provides it', () => {
      const cc = createMockRuntime('claude-code');
      const oc = createMockRuntime('opencode');
      registry.register(cc);
      registry.register(oc);
      const meshCore = { getAgent: () => ({ runtime: 'opencode' }) };
      expect(registry.resolveForAgent('agent-1', meshCore).type).toBe('opencode');
    });

    it.each([
      ['the agent has no runtime field', { getAgent: () => ({}) }],
      ['the agent runtime type is not registered', { getAgent: () => ({ runtime: 'aider' }) }],
    ] as const)('falls back to the default when %s', (_case, meshCore) => {
      registry.register(createMockRuntime('claude-code'));
      expect(registry.resolveForAgent('agent-1', meshCore).type).toBe('claude-code');
    });
  });

  describe('applyConfiguredDefaultRuntime', () => {
    it('keeps the host default when the configured runtime is placement-only', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('computer-local'));
      expect(applyConfiguredDefaultRuntime(registry, 'computer-local')).toBe(false);
      expect(registry.getDefaultType()).toBe('claude-code');
      expect(() => registry.setDefault('computer-local')).toThrow('placement-only');
    });

    it('keeps the built-in default and reports failure when the configured runtime is unregistered', () => {
      registry.register(createMockRuntime('claude-code'));

      const applied = applyConfiguredDefaultRuntime(registry, 'opencode');

      expect(applied).toBe(false);
      expect(registry.getDefaultType()).toBe('claude-code');
    });
  });

  describe('applyAndWatchConfiguredDefaultRuntime', () => {
    /** A settings source under this test's control, with one live listener. */
    function source(initial: string) {
      const state = { value: initial, listeners: [] as ((c: { sections: string[] }) => void)[] };
      return {
        state,
        read: () => state.value,
        onChange: (listener: (c: { sections: readonly string[] }) => void) => {
          state.listeners.push(listener as (c: { sections: string[] }) => void);
          return () => {
            state.listeners = state.listeners.filter((l) => l !== listener);
          };
        },
        write: (value: string, sections = ['runtimes']) => {
          state.value = value;
          for (const listener of state.listeners) listener({ sections });
        },
      };
    }

    it('re-applies it when the setting changes, with no restart', () => {
      // The reason the change-subscription primitive exists: the default runtime is APPLIED once,
      // so without this a person changes it in Settings, the screen agrees, and nothing happens
      // until they restart.
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('codex'));
      const config = source('claude-code');
      applyAndWatchConfiguredDefaultRuntime(registry, config);

      config.write('codex');

      expect(registry.getDefaultType()).toBe('codex');
    });
  });

  describe('registerOptionalRuntime', () => {
    // Codex/OpenCode throw at construction when their CLI is missing (the packaged desktop app).

    it('registers unaffected runtimes when a sibling runtime fails to construct', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const claudeCode = createMockRuntime('claude-code');
      registry.register(claudeCode);

      // Codex fails to construct (missing CLI)...
      const codexResult = registerOptionalRuntime('CodexRuntime', 'install the Codex CLI', () => {
        throw new Error('Unable to locate Codex CLI binaries');
      });

      // ...but OpenCode, registered right after, still succeeds — one
      // runtime's init failure never takes the others down with it.
      const openCode = createMockRuntime('opencode');
      const openCodeResult = registerOptionalRuntime(
        'OpenCodeRuntime',
        'install the OpenCode CLI',
        () => {
          registry.register(openCode);
          return openCode;
        }
      );

      expect(codexResult).toBeUndefined();
      expect(openCodeResult).toBe(openCode);
      expect(registry.has('claude-code')).toBe(true);
      expect(registry.has('codex')).toBe(false);
      expect(registry.has('opencode')).toBe(true);

      warn.mockRestore();
    });
  });

  describe('session metadata (per-session runtime ownership)', () => {
    let db: Db;

    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('test-mode'));
    });

    describe('forgetUnstartedSession', () => {
      it('removes the binding a launch wrote, and only that session`s (DOR-2447)', async () => {
        await registry.persistSessionRuntime('launched-never-ran', 'codex', A_PERSON);
        await registry.persistSessionRuntime('a-real-one', 'codex', A_PERSON);

        await registry.forgetUnstartedSession('launched-never-ran');

        const ids = db
          .select({ id: sessionMetadata.sessionId })
          .from(sessionMetadata)
          .all()
          .map((row) => row.id);
        expect(ids).not.toContain('launched-never-ran');
        expect(ids).toContain('a-real-one');
      });
    });

    describe('persistSessionRuntime', () => {
      it.each<TurnOrigin>([
        { kind: 'interactive' },
        { kind: 'schedule' },
        { kind: 'agent-launch' },
      ])('records what started the session: $kind', async (origin) => {
        await registry.persistSessionRuntime('s-origin', 'claude-code', origin);
        expect(registry.getSessionLaunchOrigin('s-origin')).toBe(origin.kind);
      });

      it('never overwrites the launch origin of a bound session', async () => {
        await registry.persistSessionRuntime('s-bound', 'claude-code', { kind: 'schedule' });
        await registry.persistSessionRuntime('s-bound', 'claude-code', A_PERSON);
        expect(registry.getSessionLaunchOrigin('s-bound')).toBe('schedule');
      });

      it("prefers the owning agent's model and effort over the server's", async () => {
        // The agent tier (spec `execution-defaults` E2). The agent is known here
        // and nowhere else on this path, which is why the read happens here.
        serverDefaults = { model: 'opus', effort: 'high' };
        agentDefaults = { model: 'sonnet', effort: 'low' };

        await registry.persistSessionRuntime(
          'session-agent-seeded',
          'claude-code',
          A_PERSON,
          '/agents/kai'
        );

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-agent-seeded'))
          .get();
        expect(row?.model).toBe('sonnet');
        expect(row?.effort).toBe('low');
      });

      it('never changes a recorded agent, not even when it claims an unbound row (DOR-3706)', async () => {
        // A row with no runtime yet that already names an agent: the claim binds the runtime but
        // keeps the agent, so a later caller naming a different agent cannot turn the session into
        // that agent.
        db.insert(sessionMetadata)
          .values({
            sessionId: 'session-recorded',
            runtime: null,
            agentPath: '/agents/ana',
            createdAt: new Date().toISOString(),
          })
          .run();
        const bound = await registry.persistSessionRuntime(
          'session-recorded',
          'claude-code',
          A_PERSON,
          '/agents/bypass'
        );
        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-recorded'))
          .get();
        expect(bound).toBe(true);
        expect(row?.runtime).toBe('claude-code');
        expect(row?.agentPath).toBe('/agents/ana');
      });

      it.each([
        ['interactive', { kind: 'interactive' } as TurnOrigin, true],
        [
          'a room turn somebody here started',
          { kind: 'room', externalAuthor: false } as TurnOrigin,
          true,
        ],
        [
          'a room turn bridged from off this machine',
          { kind: 'room', externalAuthor: true } as TurnOrigin,
          false,
        ],
        ['a scheduled run', { kind: 'schedule' } as TurnOrigin, false],
      ])(
        'seeds the configured stop for %s: %o → %s',
        async (_label, origin: TurnOrigin, seeds: boolean) => {
          // The whole origin→power table, at the seam that decides it (DOR-2105).
          configuredStopDefaults = { permissionMode: 'bypassPermissions' };
          const id = `session-${JSON.stringify(origin)}`;

          await registry.persistSessionRuntime(id, 'claude-code', origin);

          const row = db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, id))
            .get();
          expect(row?.permissionMode).toBe(seeds ? 'bypassPermissions' : null);
        }
      );

      it.each([
        [
          'a person, whose own settings change created it',
          { kind: 'interactive' } as TurnOrigin,
          true,
        ],
        [
          'a room turn, for a conversation that already exists',
          { kind: 'room', externalAuthor: false } as TurnOrigin,
          false,
        ],
      ])(
        'claims a row an earlier settings change left unbound — %s: %o → seeds: %s',
        async (_label, origin: TurnOrigin, seeds: boolean) => {
          // **The one case the two "configured stop" policies disagree on** (DOR-2105 review).
          configuredStopDefaults = { permissionMode: 'bypassPermissions' };
          const id = `claim-${origin.kind}-${String(seeds)}`;
          // The row the pre-launch picker leaves: a real choice, no runtime,
          // and nothing said about power.
          await registry.saveSessionSettings(id, { model: 'sonnet' });

          await registry.persistSessionRuntime(id, 'claude-code', origin);

          const row = db
            .select()
            .from(sessionMetadata)
            .where(eq(sessionMetadata.sessionId, id))
            .get();
          // Bound either way, and the person's own choice survives either way.
          expect(row?.runtime).toBe('claude-code');
          expect(row?.model).toBe('sonnet');
          expect(row?.permissionMode).toBe(seeds ? 'bypassPermissions' : null);
        }
      );
    });

    describe('getSessionRuntimeType', () => {
      it('infers claude-code without persisting on missing row (read-only)', async () => {
        const type = await registry.getSessionRuntimeType('legacy-session');
        expect(type).toBe('claude-code');

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'legacy-session'))
          .get();
        expect(row).toBeUndefined();
      });
    });

    describe('getSessionBindings (DOR-1436)', () => {
      it('answers only for sessions that are actually bound', async () => {
        await registry.persistSessionRuntime('started', 'test-mode', A_PERSON);
        // A settings write before the first turn: the row exists, the owner does
        // not (DOR-812).
        await registry.saveSessionSettings('picked-a-mode', { permissionMode: 'default' });

        const bindings = registry.getSessionBindings(['started', 'picked-a-mode', 'never-seen']);

        expect([...bindings.keys()]).toEqual(['started']);
        expect(bindings.get('started')?.runtime).toBe('test-mode');
      });

      it('never infers, where getSessionRuntimeType does', async () => {
        // The whole reason this method exists beside that one: its caller deletes rows, and the
        // default-runtime inference would hand every never-started session to claude-code and take
        // its words with it.
        expect(await registry.getSessionRuntimeType('legacy-session')).toBe('claude-code');
        expect(registry.getSessionBindings(['legacy-session']).size).toBe(0);
      });

      it('reads a list far past what one statement can bind', async () => {
        // SQLite compiles in a bound-variable ceiling (32766 on this build); one unchunked `IN
        // (...)` past it throws "too many SQL variables" and loses the WHOLE read — which for the
        // boot reconcile means every candidate looks unbound. 1200 ids, the count this test used
        // first, never came near it and the chunking could be deleted with the test still green.
        await registry.persistSessionRuntime('needle', 'test-mode', A_PERSON);
        const ids = [...Array.from({ length: 40_000 }, (_, i) => `bulk-${i}`), 'needle'];

        const bindings = registry.getSessionBindings(ids);

        expect(bindings.get('needle')?.runtime).toBe('test-mode');
      });
    });

    describe('resolveForSession', () => {
      it('throws RuntimeNotRegisteredError when stored runtime is not registered', async () => {
        await db.insert(sessionMetadata).values({
          sessionId: 'codex-session',
          runtime: 'codex',
          agentPath: null,
          createdAt: new Date().toISOString(),
        });

        await expect(registry.resolveForSession('codex-session')).rejects.toBeInstanceOf(
          RuntimeNotRegisteredError
        );

        try {
          await registry.resolveForSession('codex-session');
        } catch (err) {
          expect(err).toBeInstanceOf(RuntimeNotRegisteredError);
          const rnrErr = err as RuntimeNotRegisteredError;
          expect(rnrErr.runtime).toBe('codex');
          expect(rnrErr.sessionId).toBe('codex-session');
        }
      });
    });
  });

  describe('session settings store (ADR-0260)', () => {
    let db: Db;

    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
      registry.register(createMockRuntime('claude-code'));
    });

    it('updates the model only while the captured row and owner still match', async () => {
      const session = 'codex-session';
      expect(registry.captureCodexModel(session)).toBeUndefined();
      await registry.saveSessionSettings(session, { effort: 'medium' });
      expect(registry.captureCodexModel(session)?.model).toBeNull();
      const unbound = registry.captureCodexModel(session)!;

      db.update(sessionMetadata)
        .set({ runtime: 'codex' })
        .where(eq(sessionMetadata.sessionId, session))
        .run();
      expect(unbound.replaceIfCurrent('stale')).toBe(false);
      const bound = registry.captureCodexModel(session)!;
      expect(bound.replaceIfCurrent('available')).toBe(true);
      expect(await registry.getSessionSettings(session)).toMatchObject({
        effort: 'medium',
        model: 'available',
      });

      const removed = registry.captureCodexModel(session)!;
      await registry.discardSessionSettings(session);
      expect(removed.replaceIfCurrent('stale')).toBe(false);
      expect(await registry.getSessionSettings(session)).toBeNull();
      await registry.persistSessionRuntime(session, 'claude-code', A_PERSON);
      expect(registry.captureCodexModel(session)).toBeUndefined();
    });

    it('discardSessionSettings removes one row, bound or not, and nothing else', async () => {
      await registry.saveSessionSettings('never-started', { model: 'sonnet' });
      await registry.persistSessionRuntime('bound-then-dropped', 'test-mode', A_PERSON);
      await registry.saveSessionSettings('kept', { model: 'sonnet' });

      await registry.discardSessionSettings('never-started');
      await registry.discardSessionSettings('bound-then-dropped');

      const ids = db
        .select({ id: sessionMetadata.sessionId })
        .from(sessionMetadata)
        .all()
        .map((r) => r.id);
      expect(ids).toEqual(['kept']);
    });

    it('updates only provided columns and leaves identity intact on conflict', async () => {
      await registry.persistSessionRuntime('s2', 'test-mode', A_PERSON, '/agent/path');
      await registry.saveSessionSettings('s2', { permissionMode: 'acceptEdits' });
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 's2'))
        .get();
      // Identity columns untouched by the settings UPSERT.
      expect(row?.runtime).toBe('test-mode');
      expect(row?.agentPath).toBe('/agent/path');
      expect(row?.permissionMode).toBe('acceptEdits');
      // Columns not in the patch remain NULL.
      expect(row?.model).toBeNull();
    });

    it('round-trips a runtime-declared mode id the shared enum never named (DOR-885)', async () => {
      // The permission-mode column is plain text holding whatever the owning runtime calls its
      // mode, and `test-mode` really does declare `always-allow` as its default
      // (`TEST_MODE_CAPABILITIES`) — so a row like this one exists on any install that has opened a
      // test-mode session.
      await registry.saveSessionSettings('wide-mode', { permissionMode: 'always-allow' });
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 'wide-mode'))
        .get();
      expect(row?.permissionMode).toBe('always-allow');

      const settings = await registry.getSessionSettings('wide-mode');
      expect(settings).toEqual({ permissionMode: 'always-allow' });
      expect(SessionSettingsSchema.parse(settings)).toEqual({ permissionMode: 'always-allow' });
      // The batch read is a second code path over the same row, and the display
      // overlay uses it for every session in the list — it must agree.
      expect(registry.getSessionSettingsMany(['wide-mode']).get('wide-mode')).toEqual({
        permissionMode: 'always-allow',
      });
    });

    it('never lets a default reach a row that already exists', async () => {
      // The UPDATE branch carries the patch alone: an existing row is a running
      // session, whatever the server default now says.
      await registry.persistSessionRuntime('already-running', 'claude-code', A_PERSON);
      serverDefaults = { model: 'opus', effort: 'high' };

      await registry.saveSessionSettings('already-running', { permissionMode: 'plan' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 'already-running'))
        .get();
      expect(row?.permissionMode).toBe('plan');
      expect(row?.model).toBeNull();
      expect(row?.effort).toBeNull();
    });

    it('drops an effort value the ladder no longer has, rather than passing it on', async () => {
      // `effort` is a free-form TEXT column.
      db.insert(sessionMetadata)
        .values({
          sessionId: 'garbage-effort',
          runtime: 'claude-code',
          createdAt: new Date().toISOString(),
          effort: 'ludicrous',
          model: 'opus',
        })
        .run();

      const settings = await registry.getSessionSettings('garbage-effort');

      expect(settings).toEqual({ model: 'opus' });
      // The batch read is the same code path and must agree — it feeds the
      // session list, where a crash would take every row down with it.
      expect(registry.getSessionSettingsMany(['garbage-effort']).get('garbage-effort')).toEqual({
        model: 'opus',
      });
    });
  });

  describe('an early settings write leaves the runtime unbound (DOR-812)', () => {
    let db: Db;

    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('test-mode'));
    });

    const read = (id: string) =>
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();

    it('resolves native evidence before the authorized detail read persists ownership', async () => {
      const runtime = createMockRuntime('codex');
      runtime.findSession = vi
        .fn()
        .mockResolvedValue({ id: 'external-thread', cwd: '/project', runtime: 'codex' });
      registry.register(runtime);
      expect(await registry.resolveSessionRuntime('external-thread')).toEqual({
        type: 'codex',
        bound: true,
      });
      expect(read('external-thread')).toBeUndefined();
      await registry.persistSessionRuntime('external-thread', 'test-mode', A_PERSON);
      expect(await registry.getSessionRuntimeType('external-thread')).toBe('test-mode');
    });

    it('persists verified actual cwd independently of agent provenance, only for the owner', async () => {
      await (await import('../../../lib/boundary.js')).initBoundary(process.cwd());
      const session = {
        id: 'verified-native',
        cwd: process.cwd(),
        runtime: 'opencode',
        account: 'native-home',
      } as import('@dorkos/shared/types').Session;
      await registry.rememberNativeSession(session, { kind: 'agent' });
      expect(read(session.id)).toBeUndefined();
      await registry.rememberNativeSession(session, { kind: 'operator' });
      expect(read(session.id)?.runtime).toBe('opencode');
      expect(read(session.id)?.agentPath).toBeNull();
      expect(registry.getNativeSessionCwd(session.id)).toBe(process.cwd());
      expect(registry.getNativeSessionAccount(session.id)).toBe('native-home');
      // Runtime registry projections may omit account after resuming a native
      // session. A read must not erase its already verified private source.
      const { account: _account, ...displaySession } = session;
      await registry.rememberNativeSession(displaySession, { kind: 'operator' });
      expect(registry.getNativeSessionAccount(session.id)).toBe('native-home');
      expect(await registry.resolveSessionRuntime(session.id)).toEqual({
        type: 'opencode',
        bound: true,
      });
    });

    it('distinguishes unavailable native storage from absent sessions and permits draft probes', async () => {
      const runtime = createMockRuntime('codex');
      runtime.findSession = vi.fn().mockRejectedValue(new Error('unreadable'));
      registry.register(runtime);
      await expect(registry.resolveSessionRuntime('existing')).rejects.toMatchObject({
        code: 'SESSION_DISCOVERY_UNAVAILABLE',
      });
      expect(await registry.resolveSessionRuntime('new-draft', { allowUnbound: true })).toEqual({
        type: 'claude-code',
        bound: false,
      });
      expect(read('existing')).toBeUndefined();
    });

    it('refuses ambiguous native ids instead of choosing the first runtime', async () => {
      for (const type of ['codex', 'opencode']) {
        const runtime = createMockRuntime(type);
        runtime.findSession = vi
          .fn()
          .mockResolvedValue({ id: 'collision', cwd: '/project', runtime: type });
        registry.register(runtime);
      }
      await expect(registry.resolveSessionRuntime('collision')).rejects.toMatchObject({
        code: 'SESSION_ID_AMBIGUOUS',
      });
      expect(read('collision')).toBeUndefined();
    });

    it('does not choose the runtime — the first turn still does', async () => {
      // The bug: a pre-launch settings change created the row with the INFERRED runtime, and the
      // binding write is first-write-wins, so a session the person had pointed at another runtime
      // was pinned to claude-code forever by the act of changing a setting before sending anything.
      await registry.saveSessionSettings('pre-launch-codex', { model: 'sonnet' });

      await registry.persistSessionRuntime('pre-launch-codex', 'test-mode', A_PERSON);

      expect(await registry.getSessionRuntimeType('pre-launch-codex')).toBe('test-mode');
      expect(read('pre-launch-codex')?.runtime).toBe('test-mode');
      // ...and the choice that created the row is still the person's.
      expect(read('pre-launch-codex')?.model).toBe('sonnet');
    });

    it('seeds the defaults of the runtime it BINDS, not of the one it guessed', async () => {
      // The reason the seed cannot ride the settings write: every key of it is a per-runtime answer
      // (`resolve-session-defaults` — the model id lives in one runtime's namespace, the effort is
      // dropped where a runtime has none, the trust stop is resolved from the runtime's own
      // declared modes).
      await registry.saveSessionSettings('seed-at-binding', { model: 'sonnet' });
      serverDefaults = { model: 'opus', effort: 'high' };

      await registry.persistSessionRuntime('seed-at-binding', 'test-mode', A_PERSON);

      expect(lastResolveOpts?.runtimeType).toBe('test-mode');
      // The person's explicit choice survives the claim...
      expect(read('seed-at-binding')?.model).toBe('sonnet');
      // ...and only the key their write did not carry is filled.
      expect(read('seed-at-binding')?.effort).toBe('high');
    });

    it('reports the claim as the session being created, exactly once', async () => {
      // The boolean gates the once-per-session `session_created` usage event.
      // Binding an unbound row IS that session starting; the turn after is not.
      await registry.saveSessionSettings('claim-signal', { model: 'sonnet' });

      const first = await registry.persistSessionRuntime('claim-signal', 'test-mode', A_PERSON);
      const second = await registry.persistSessionRuntime('claim-signal', 'test-mode', A_PERSON);

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('lands the bound runtime’s strictest mode, never the configured stop (DOR-4411)', async () => {
      // QA's case: a Codex chat stored at Plan bound with the drop UNDER the seed,
      // so it took the configured stop, the agent's Full on a Trusted install.
      registry.register(
        createMockRuntime('narrow', {
          permissionModes: {
            supported: true,
            values: [
              {
                id: 'strict',
                label: 'Strict',
                stop: 'ask',
                asks: 'always',
                reach: 'read',
                promise: 'Asks first.',
              },
              {
                id: 'open',
                label: 'Open',
                stop: 'autonomy',
                asks: 'never',
                reach: 'everything',
                promise: 'Never asks.',
              },
            ],
          },
        })
      );
      configuredStopDefaults = { permissionMode: 'open' };
      await registry.saveSessionSettings('mode-reseeded', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-reseeded', 'narrow', { kind: 'interactive' });

      expect(read('mode-reseeded')?.permissionMode).toBe('strict');
    });

    it('keeps a stored mode the runtime it binds does declare', async () => {
      // TWO declared modes, and the stored one is NOT the one the seed would write.
      registry.register(
        createMockRuntime('twomode', {
          permissionModes: {
            supported: true,
            values: [
              {
                id: 'default',
                label: 'Default',
                stop: 'ask',
                asks: 'always',
                reach: 'edit',
                promise: 'Asks first.',
              },
              {
                id: 'acceptEdits',
                label: 'Accept edits',
                stop: 'act',
                asks: 'when-risky',
                reach: 'edit',
                promise: 'Edits without asking.',
              },
            ],
          },
        })
      );
      configuredStopDefaults = { permissionMode: 'default' };
      await registry.saveSessionSettings('mode-declared', { permissionMode: 'acceptEdits' });

      await registry.persistSessionRuntime('mode-declared', 'twomode', { kind: 'interactive' });

      expect(read('mode-declared')?.permissionMode).toBe('acceptEdits');
    });

    it('leaves the mode alone when the runtime being bound is not registered', async () => {
      // No profile on this server means no basis to judge — the same answer `seedForNewRow` gives
      // when it cannot read a runtime's declared modes.
      await registry.saveSessionSettings('mode-unknown-runtime', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-unknown-runtime', 'codex', A_PERSON);

      expect(read('mode-unknown-runtime')?.permissionMode).toBe('plan');
    });

    it('never re-judges the mode of a session that is already bound', async () => {
      // WRITE PATH ONLY, exactly as the PATCH gate is: a session already running
      // in a now-undeclared mode keeps it and keeps running.
      registry.register(
        createMockRuntime('modeless', { permissionModes: { supported: false, values: [] } })
      );
      await registry.persistSessionRuntime('already-bound-mode', 'modeless', A_PERSON);
      await registry.saveSessionSettings('already-bound-mode', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('already-bound-mode', 'modeless', A_PERSON);

      expect(read('already-bound-mode')?.permissionMode).toBe('plan');
    });

    it('never re-binds a session whose runtime is already set (ADR-0255)', async () => {
      // The invariant the fix must not spend: the first AUTHORITATIVE write wins.
      // Only an inference is negotiable.
      await registry.persistSessionRuntime('bound', 'test-mode', A_PERSON, '/first/path');
      serverDefaults = { model: 'opus' };

      const created = await registry.persistSessionRuntime(
        'bound',
        'claude-code',
        A_PERSON,
        '/second/path'
      );

      expect(created).toBe(false);
      expect(read('bound')?.runtime).toBe('test-mode');
      expect(read('bound')?.agentPath).toBe('/first/path');
      // A running session keeps its settings, whatever the server default now says.
      expect(read('bound')?.model).toBeNull();
    });
  });

  describe('rekeySessionSettings (DOR-493)', () => {
    let db: Db;

    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
      registry.register(createMockRuntime('claude-code'));
    });

    /** Every row in the table, so "exactly one key" can be asserted, not assumed. */
    function allRows() {
      return db.select().from(sessionMetadata).all();
    }

    it('moves verified native cwd and account source with the canonical identity', async () => {
      await registry.persistSessionRuntime('old-native', 'claude-code', A_PERSON);
      db.insert(sessionNativeBindings)
        .values({
          sessionId: 'old-native',
          runtime: 'claude-code',
          cwd: '/actual/worktree',
          account: '/private/native-home',
          createdAt: '2026-10-07',
        })
        .run();
      await registry.rekeySessionSettings('old-native', 'canonical-native');
      expect(registry.getNativeSessionCwd('canonical-native')).toBe('/actual/worktree');
      expect(registry.getNativeSessionAccount('canonical-native')).toBe('/private/native-home');
      expect(registry.getNativeSessionCwd('old-native')).toBeNull();
      expect(await registry.getSessionRuntimeType('canonical-native')).toBe('claude-code');
    });

    it("moves the session's context reading, even with no settings row (spec claude-account-fleet §6 U)", async () => {
      db.insert(sessionContext)
        .values({
          sessionId: 'old',
          contextTokens: 120_000,
          contextMaxTokens: 200_000,
          observedAt: '2026-09-27T10:00:00.000Z',
        })
        .run();

      await registry.rekeySessionSettings('old', 'new');

      expect(db.select().from(sessionContext).all()).toEqual([
        {
          sessionId: 'new',
          contextTokens: 120_000,
          contextMaxTokens: 200_000,
          observedAt: '2026-09-27T10:00:00.000Z',
        },
      ]);
      expect(allRows()).toEqual([]);
    });

    it('a context-table failure never stops the settings row (the runtime binding) from moving', async () => {
      await registry.persistSessionRuntime('old', 'test-mode', A_PERSON);
      db.run(sql`DROP TABLE session_context`);
      const warn = vi.spyOn(logger, 'warn');

      await registry.rekeySessionSettings('old', 'new');

      expect(allRows()).toEqual([
        expect.objectContaining({ sessionId: 'new', runtime: 'test-mode' }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        '[RuntimeRegistry] could not move a session context reading',
        expect.objectContaining({ fromId: 'old', toId: 'new' })
      );
      warn.mockRestore();
    });

    it('moves the whole row, identity columns included', async () => {
      await registry.persistSessionRuntime('old', 'test-mode', A_PERSON, '/agent/path');
      await registry.saveSessionSettings('old', { permissionMode: 'plan', fastMode: true });
      const createdAt = allRows()[0]?.createdAt;

      await registry.rekeySessionSettings('old', 'new');

      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: 'new',
        runtime: 'test-mode',
        agentPath: '/agent/path',
        createdAt,
        permissionMode: 'plan',
        fastMode: true,
      });
    });

    it('merges into an existing destination row without changing its owner', async () => {
      await registry.persistSessionRuntime('new', 'claude-code', A_PERSON);
      await registry.saveSessionSettings('new', { model: 'sonnet' });
      await registry.persistSessionRuntime('old', 'test-mode', A_PERSON);
      await registry.saveSessionSettings('old', { permissionMode: 'bypassPermissions' });

      await registry.rekeySessionSettings('old', 'new');

      const rows = allRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sessionId: 'new',
        // Ownership is immutable (ADR-0255) — the destination keeps its runtime.
        runtime: 'claude-code',
        // The destination has no permissionMode, so the source fills the gap.
        permissionMode: 'bypassPermissions',
        // …and the destination's own value is kept where it has one.
        model: 'sonnet',
      });
    });

    it('refuses to merge two rows that record different agents, and leaves both as they were (DOR-3706)', async () => {
      await registry.persistSessionRuntime('ana-chat', 'claude-code', A_PERSON, '/agents/ana');
      await registry.saveSessionSettings('ana-chat', { permissionMode: 'bypassPermissions' });
      await registry.persistSessionRuntime('ben-chat', 'claude-code', A_PERSON, '/agents/ben');
      await registry.saveSessionSettings('ben-chat', { model: 'sonnet' });
      const before = allRows();

      await registry.rekeySessionSettings('ana-chat', 'ben-chat');

      expect(allRows()).toEqual(before);
    });

    it('merges field by field — the destination keeps only what it has set', async () => {
      // Not an all-or-nothing pick between two rows: each column is resolved on its own, so an
      // operator's newer mode survives alongside a model that was only ever chosen under the old
      // id.
      await registry.saveSessionSettings('old', {
        permissionMode: 'bypassPermissions',
        model: 'opus',
        effort: 'low',
      });
      await registry.saveSessionSettings('new', { permissionMode: 'plan', effort: 'high' });

      await registry.rekeySessionSettings('old', 'new');

      expect(await registry.getSessionSettings('new')).toEqual({
        permissionMode: 'plan', // newer, from the destination
        effort: 'high', // newer, from the destination
        model: 'opus', // destination had none — the source fills it
      });
    });

    it.each([
      ['old', true],
      ['new', false],
    ] as const)(
      'preserves an unconsumed allocation at %s before moving ordinary rekey state (source metadata: %s)',
      async (allocatedId, hasSourceMetadata) => {
        if (hasSourceMetadata) await registry.persistSessionRuntime('old', 'claude-code', A_PERSON);
        db.insert(sessionContext)
          .values({
            sessionId: 'old',
            contextTokens: 120_000,
            contextMaxTokens: 200_000,
            observedAt: '2026-09-27T10:00:00.000Z',
          })
          .run();
        db.insert(sessionBirthAllocations)
          .values({
            sessionId: allocatedId,
            version: 1,
            createdAt: 'owned-allocation',
            sourceKind: 'internal',
            internalSource: {
              kind: 'server-mint',
              owner: 'chat-start',
              mintedSessionId: allocatedId,
            },
          })
          .run();
        const before = allRows();
        const allocations = db.select().from(sessionBirthAllocations).all();
        const context = db.select().from(sessionContext).all();

        await expect(registry.rekeySessionSettings('old', 'new')).rejects.toThrow(
          'Required session identity could not be preserved.'
        );

        expect(allRows()).toEqual(before);
        expect(db.select().from(sessionBirthAllocations).all()).toEqual(allocations);
        expect(db.select().from(sessionContext).all()).toEqual(context);
      }
    );

    it('moves a stored usage limit, even for a session with no settings row (D4)', async () => {
      const limits = new SessionLimitStore(db);
      setSessionLimitStore(limits);
      try {
        limits.upsert({
          sessionId: 'old',
          limit: {
            accountId: 'work',
            window: 'five_hour',
            resetsAt: null,
            since: '2026-09-26T10:00:00.000Z',
            plan: { mode: 'ask' },
            scope: 'account',
            state: 'limited',
          },
          scope: 'account',
          accountPath: '/accounts/work',
        });

        await registry.rekeySessionSettings('old', 'new');

        expect(limits.get('old')).toBeUndefined();
        expect(limits.get('new')?.limit.window).toBe('five_hour');
      } finally {
        setSessionLimitStore(undefined);
      }
    });

    it('is a no-op when the ids are the same (never deletes the row)', async () => {
      await registry.saveSessionSettings('same', { permissionMode: 'plan' });

      await registry.rekeySessionSettings('same', 'same');

      expect(await registry.getSessionSettings('same')).toEqual({ permissionMode: 'plan' });
    });
  });

  describe('native import and automatic resume never consume a fresh birth', () => {
    let db: Db;
    const sessionId = '569a9c40-1f42-4e51-8b73-fbce108b97e1';
    const read = () =>
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).get();
    const allocate = () => {
      db.insert(sessionBirthAllocations)
        .values({
          sessionId,
          version: 1,
          createdAt: 'owned-allocation',
          sourceKind: 'internal',
          internalSource: { kind: 'server-mint', owner: 'chat-start', mintedSessionId: sessionId },
        })
        .run();
    };
    const native = (): import('@dorkos/shared/types').Session => ({
      id: sessionId,
      title: 'Existing native conversation',
      runtime: 'opencode',
      cwd: process.cwd(),
      account: 'owned-native-account',
      permissionMode: 'default',
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    });
    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
    });

    it.each([false, true])(
      'refuses native import with an unconsumed allocation and existing row %s',
      async (existing) => {
        await (await import('../../../lib/boundary.js')).initBoundary(process.cwd());
        if (existing)
          db.insert(sessionMetadata)
            .values({
              sessionId,
              runtime: 'opencode',
              model: 'winner',
              permissionMode: 'plan',
              modelLaunchState: 'established-v1',
              createdAt: 'existing',
            })
            .run();
        allocate();
        const before = read();
        const allocation = db.select().from(sessionBirthAllocations).all();
        await expect(
          registry.rememberNativeSession(native(), { kind: 'operator' })
        ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
        expect(read()).toEqual(before);
        expect(db.select().from(sessionBirthAllocations).all()).toEqual(allocation);
        expect(db.select().from(sessionNativeBindings).all()).toEqual([]);
      }
    );

    it('keeps authorized native import legacy without an allocation and preserves its explicit choices', async () => {
      await (await import('../../../lib/boundary.js')).initBoundary(process.cwd());
      await registry.rememberNativeSession(native(), { kind: 'operator' });
      expect(read()).toMatchObject({ runtime: 'opencode', modelLaunchState: null });
      db.update(sessionMetadata)
        .set({ model: 'explicit', permissionMode: 'plan', modelLaunchState: 'attempted-v1' })
        .where(eq(sessionMetadata.sessionId, sessionId))
        .run();
      await registry.rememberNativeSession(native(), { kind: 'operator' });
      expect(read()).toMatchObject({
        model: 'explicit',
        permissionMode: 'plan',
        modelLaunchState: 'attempted-v1',
      });
      expect(registry.getNativeSessionAccount(sessionId)).toBe('owned-native-account');
    });

    it('refuses native import over a saved-folder draft and still imports an old conversation', async () => {
      await (await import('../../../lib/boundary.js')).initBoundary(process.cwd());
      const observed = native();
      const { cwd } = observed;
      if (!cwd) throw new Error('Expected the native fixture directory');
      const caller = { kind: 'operator' } as const;
      const legacyId = '19c3799f-8028-421b-a110-1b12e54ed47f';

      const ownerId = 'saved-folder-owner';
      const locationId = 'saved-folder';
      const stamp = 'saved-folder-generation';
      db.insert(sessionLocations).values({ id: locationId, ownerId, cwd, createdAt: stamp }).run();
      db.insert(sessionBirthAllocations)
        .values({
          sessionId,
          version: 1,
          createdAt: stamp,
          sourceKind: 'person-location',
          ownerId,
          locationId,
        })
        .run();
      await registry.saveSessionSettings(
        sessionId,
        { model: 'draft-choice', permissionMode: 'plan' },
        {
          kind: 'person-location',
          sessionId,
          allocationCreatedAt: stamp,
          sourceCreatedAt: stamp,
          ownerId,
          locationId,
          cwd,
        }
      );
      const pending = read();
      const draft = readDraftSource(db, sessionId);
      expect(pending).toMatchObject({
        runtime: null,
        modelLaunchState: 'pending-v1',
        model: 'draft-choice',
        permissionMode: 'plan',
      });
      expect(draft).toMatchObject({ sessionId, ownerId, locationId, sourcePath: cwd });
      expect(db.select().from(sessionBirthAllocations).all()).toEqual([]);

      await registry.rememberNativeSession({ ...observed, id: legacyId }, caller);
      const bindings = () => db.select().from(sessionNativeBindings).all();
      const legacyBinding = bindings();
      expect(legacyBinding).toEqual([
        expect.objectContaining({ sessionId: legacyId, account: observed.account, cwd }),
      ]);
      expect(
        db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, legacyId)).get()
      ).toMatchObject({ runtime: 'opencode', modelLaunchState: null });

      await expect(registry.rememberNativeSession(observed, caller)).rejects.toMatchObject({
        code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE',
        reason: 'context',
      });
      expect(read()).toEqual(pending);
      expect(readDraftSource(db, sessionId)).toEqual(draft);
      expect(db.select().from(sessionBirthAllocations).all()).toEqual([]);
      expect(bindings()).toEqual(legacyBinding);
    });

    it.each([false, true])(
      'refuses automatic resume with an unconsumed allocation and existing row %s',
      (existing) => {
        if (existing)
          db.insert(sessionMetadata)
            .values({
              sessionId,
              runtime: 'codex',
              model: 'winner',
              permissionMode: 'plan',
              lastAutoResumeFor: 'prior',
              modelLaunchState: 'established-v1',
              createdAt: 'existing',
            })
            .run();
        allocate();
        const before = read();
        const allocation = db.select().from(sessionBirthAllocations).all();
        expect(() => registry.markAutoResumed(sessionId, 'next')).toThrow(
          'Session birth write refused'
        );
        expect(read()).toEqual(before);
        expect(db.select().from(sessionBirthAllocations).all()).toEqual(allocation);
      }
    );

    it('rolls back native metadata if the real native-binding write fails', async () => {
      await (await import('../../../lib/boundary.js')).initBoundary(process.cwd());
      db.$client.exec(
        "CREATE TEMP TRIGGER reject_birth_native BEFORE INSERT ON session_native_bindings BEGIN SELECT RAISE(ABORT, 'owned-native-write-refused'); END;"
      );
      await expect(registry.rememberNativeSession(native(), { kind: 'program' })).rejects.toThrow(
        'owned-native-write-refused'
      );
      expect(read()).toBeUndefined();
      expect(db.select().from(sessionNativeBindings).all()).toEqual([]);
    });
  });

  describe('birth transfer at settings INSERT and runtime binding', () => {
    let db: Db;
    const id = 'owned-birth';
    const read = () =>
      db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
    const allocations = () => db.select().from(sessionBirthAllocations).all();
    function birth(): Extract<SessionBirthWriteContext, { kind: 'person-location' }> {
      db.insert(sessionLocations)
        .values({ id: 'owned-location', ownerId: 'person', cwd: '/owned', createdAt: 'stamp' })
        .run();
      db.insert(sessionBirthAllocations)
        .values({
          sessionId: id,
          version: 1,
          createdAt: 'stamp',
          sourceKind: 'person-location',
          ownerId: 'person',
          locationId: 'owned-location',
        })
        .run();
      return {
        kind: 'person-location',
        sessionId: id,
        allocationCreatedAt: 'stamp',
        ownerId: 'person',
        locationId: 'owned-location',
        cwd: '/owned',
      };
    }
    beforeEach(() => {
      db = createTestDb();
      registry.setDb(db);
      const runtime = createMockRuntime('claude-code');
      const modes = runtime.getCapabilities().permissionModes;
      registry.register(
        createMockRuntime('claude-code', {
          permissionModes: {
            ...modes,
            values: [...modes.values, { ...modes.values[0]!, id: 'plan', label: 'Plan' }],
          },
        })
      );
      // Default is the configured and first strictest alternative; explicit Plan must survive.
      serverDefaults = { permissionMode: 'default' };
    });

    it('refuses person allocation with a real nonperson room origin', async () => {
      const context = birth();
      const before = allocations();
      await expect(
        registry.persistSessionRuntime(
          id,
          'claude-code',
          { kind: 'room', externalAuthor: false },
          undefined,
          context
        )
      ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
      expect(read()).toBeUndefined();
      expect(allocations()).toEqual(before);
    });

    it.each(['/different', '/actual-agent'])(
      'compares the actual room-seat agent against the binding path %s',
      async (agentPath) => {
        db.insert(authors)
          .values({
            id: 'seat-author',
            kind: 'agent',
            naturalKey: '/actual-agent',
            displayName: 'Seat agent',
            createdAt: 'stamp',
          })
          .run();
        db.insert(roomSessions)
          .values({ roomId: 'room', authorId: 'seat-author', sessionId: id, createdAt: 'stamp' })
          .run();
        db.insert(sessionBirthAllocations)
          .values({
            sessionId: id,
            version: 1,
            sourceKind: 'internal',
            createdAt: 'stamp',
            internalSource: {
              kind: 'room-seat',
              roomId: 'room',
              authorId: 'seat-author',
              boundSessionId: id,
              seatCreatedAt: 'stamp',
            },
          })
          .run();
        const context: SessionBirthWriteContext = {
          kind: 'room-seat',
          allocationCreatedAt: 'stamp',
          roomId: 'room',
          authorId: 'seat-author',
          agentPath: '/actual-agent',
          seatCreatedAt: 'stamp',
        };
        const pending = registry.persistSessionRuntime(
          id,
          'claude-code',
          { kind: 'room', externalAuthor: false },
          agentPath,
          context
        );
        if (agentPath === '/actual-agent') {
          await expect(pending).resolves.toBe(true);
          expect(read()).toMatchObject({ modelLaunchState: 'pending-v1', agentPath });
          expect(allocations()).toEqual([]);
        } else {
          await expect(pending).rejects.toMatchObject({
            code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE',
          });
          expect(read()).toBeUndefined();
          expect(allocations()).toHaveLength(1);
        }
      }
    );

    it('transfers a real settings-first birth and retains explicit model and mode when claimed', async () => {
      const context = birth();
      await registry.saveSessionSettings(
        id,
        { model: 'explicit', permissionMode: 'plan' },
        context
      );
      const beforeRekey = read();
      expect(beforeRekey).toMatchObject({
        runtime: null,
        model: 'explicit',
        permissionMode: 'plan',
        modelLaunchState: 'pending-v1',
      });
      expect(allocations()).toEqual([]);
      const source = readDraftSource(db, id);
      if (source?.sourceKind !== 'person-location' || !source.locationId)
        throw new Error('Expected the persisted saved location');
      await expect(
        registry.persistSessionRuntime(id, 'claude-code', A_PERSON)
      ).rejects.toMatchObject({
        code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE',
      });
      const targetId = 'new-canonical-id';
      const rekey = registry.rekeySessionSettings(id, targetId);
      await expect(rekey).rejects.toBeInstanceOf(RequiredSessionIdentityError);
      await expect(rekey).rejects.toMatchObject({
        message: 'Required session identity could not be preserved.',
        cause: 'A saved-folder draft must bind before rekeying.',
      });
      expect(db.select().from(sessionMetadata).all()).toEqual([beforeRekey]);
      expect(readDraftSource(db, id)).toEqual(source);
      expect(readDraftSource(db, targetId)).toBeUndefined();
      expect(allocations()).toEqual([]);
      const witness = {
        ...source,
        sourceKind: 'person-location' as const,
        locationId: source.locationId,
      };
      expect(
        await registry.persistSessionRuntime(
          id,
          'claude-code',
          A_PERSON,
          undefined,
          undefined,
          witness
        )
      ).toBe(true);
      expect(readDraftSource(db, id)).toBeUndefined();
      expect(read()).toMatchObject({
        runtime: 'claude-code',
        model: 'explicit',
        permissionMode: 'plan',
        modelLaunchState: 'pending-v1',
      });
    });

    it('transfers a real direct binding birth with the original seed and insertion result', async () => {
      const context = birth();
      serverDefaults = { model: 'configured', permissionMode: 'plan' };
      expect(
        await registry.persistSessionRuntime(id, 'claude-code', A_PERSON, undefined, context)
      ).toBe(true);
      expect(read()).toMatchObject({
        runtime: 'claude-code',
        model: 'configured',
        modelLaunchState: 'pending-v1',
      });
      expect(allocations()).toEqual([]);
      expect(await registry.persistSessionRuntime(id, 'claude-code', A_PERSON)).toBe(false);
    });

    it.each(['settings'] as const)(
      'refuses the %s writer without prepared context and keeps allocation intact',
      async (writer) => {
        birth();
        const before = allocations();
        const pending =
          writer === 'settings'
            ? registry.saveSessionSettings(id, { model: 'unowned' })
            : registry.persistSessionRuntime(id, 'claude-code', A_PERSON);
        await expect(pending).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
        expect(read()).toBeUndefined();
        expect(allocations()).toEqual(before);
      }
    );

    it.each(['settings', 'binding'] as const)(
      'checks the actual owner for the %s writer inside SQL',
      async (writer) => {
        const context = birth();
        context.ownerId = 'different-person';
        const before = allocations();
        const pending =
          writer === 'settings'
            ? registry.saveSessionSettings(id, { model: 'unowned' }, context)
            : registry.persistSessionRuntime(id, 'claude-code', A_PERSON, undefined, context);
        await expect(pending).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
        expect(read()).toBeUndefined();
        expect(allocations()).toEqual(before);
      }
    );

    it('rereads location after the actual awaited default read before binding', async () => {
      const context = birth();
      const pending = registry.persistSessionRuntime(
        id,
        'claude-code',
        A_PERSON,
        undefined,
        context
      );
      db.update(sessionLocations)
        .set({ cwd: '/changed' })
        .where(eq(sessionLocations.id, 'owned-location'))
        .run();
      await expect(pending).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
      expect(read()).toBeUndefined();
      expect(allocations()).toHaveLength(1);
    });

    it('preserves a real winning existing metadata row and its inconsistent allocation', async () => {
      const context = birth();
      db.insert(sessionMetadata)
        .values({
          sessionId: id,
          runtime: 'codex',
          model: 'winner',
          permissionMode: 'plan',
          modelLaunchState: 'established-v1',
          createdAt: 'prior',
        })
        .run();
      const before = read();
      await expect(
        registry.persistSessionRuntime(id, 'claude-code', A_PERSON, undefined, context)
      ).rejects.toMatchObject({ code: 'SESSION_BIRTH_CONTEXT_UNAVAILABLE' });
      expect(read()).toEqual(before);
      expect(allocations()).toHaveLength(1);
    });

    it('rolls back both metadata and allocation consumption on a real delete failure', async () => {
      const context = birth();
      db.$client.exec(
        "CREATE TEMP TRIGGER reject_birth_consume BEFORE DELETE ON session_birth_allocations BEGIN SELECT RAISE(ABORT, 'owned-consumption-refused'); END;"
      );
      await expect(
        registry.saveSessionSettings(id, { model: 'explicit' }, context)
      ).rejects.toThrow('owned-consumption-refused');
      expect(read()).toBeUndefined();
      expect(allocations()).toHaveLength(1);
    });
  });
});
