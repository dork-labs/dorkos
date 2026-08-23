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
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq, type Db } from '@dorkos/db';
import { logger } from '../../../lib/logger.js';

// Minimal mock runtime for testing
function createMockRuntime(type: string, overrides?: Partial<RuntimeCapabilities>): AgentRuntime {
  return {
    type,
    ensureSession: () => {},
    hasSession: () => false,
    updateSession: () => true,
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
      // A mock runtime declares nothing configurable unless a test says
      // otherwise. The registry reads `configSection` off this declaration and
      // hands it to the resolver, so a test about the server's per-runtime
      // defaults says which section by overriding it here.
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
 * modes — the interactive-only trust stop (spec `trust-dial`, decision 6). Kept
 * separate from {@link serverDefaults} so a test can ask the one question the
 * registry owns here: which callers get offered it at all.
 */
let interactiveDefaults: SessionSettings = {};

/** The options the registry last handed the resolver, for the same question. */
let lastResolveOpts: { runtimeType?: string; permissionModes?: readonly unknown[] } | null = null;

vi.mock('../../session/resolve-session-defaults.js', () => ({
  resolveSessionDefaults: (opts: {
    runtimeType?: string;
    agent?: SessionSettings;
    permissionModes?: readonly unknown[];
  }) => {
    lastResolveOpts = opts;
    return {
      ...serverDefaults,
      ...(opts.permissionModes ? interactiveDefaults : {}),
      ...(opts.agent ?? {}),
    };
  },
  readAgentExecutionDefaults: async (dir?: string) => (dir ? agentDefaults : {}),
}));

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
    serverDefaults = {};
    agentDefaults = {};
    interactiveDefaults = {};
    lastResolveOpts = null;
  });

  describe('register and get', () => {
    it('registers and retrieves a runtime by type', () => {
      const runtime = createMockRuntime('claude-code');
      registry.register(runtime);
      expect(registry.get('claude-code')).toBe(runtime);
    });

    it('throws when getting an unregistered type', () => {
      expect(() => registry.get('nonexistent')).toThrow("Runtime 'nonexistent' not registered");
    });

    it('replaces existing registration for the same type', () => {
      const runtime1 = createMockRuntime('claude-code');
      const runtime2 = createMockRuntime('claude-code');
      registry.register(runtime1);
      registry.register(runtime2);
      expect(registry.get('claude-code')).toBe(runtime2);
    });
  });

  describe('getDefault', () => {
    it('defaults to claude-code', () => {
      const runtime = createMockRuntime('claude-code');
      registry.register(runtime);
      expect(registry.getDefault()).toBe(runtime);
    });

    it('throws when default type is not registered', () => {
      expect(() => registry.getDefault()).toThrow("Runtime 'claude-code' not registered");
    });
  });

  describe('setDefault', () => {
    it('changes the default runtime type', () => {
      const cc = createMockRuntime('claude-code');
      const oc = createMockRuntime('opencode');
      registry.register(cc);
      registry.register(oc);
      registry.setDefault('opencode');
      expect(registry.getDefault()).toBe(oc);
    });

    it('throws when setting default to unregistered type', () => {
      expect(() => registry.setDefault('nonexistent')).toThrow(
        "Runtime 'nonexistent' not registered"
      );
    });
  });

  describe('resolveForAgent', () => {
    it('returns agent-specific runtime when meshCore provides it', () => {
      const cc = createMockRuntime('claude-code');
      const oc = createMockRuntime('opencode');
      registry.register(cc);
      registry.register(oc);
      const meshCore = { getAgent: () => ({ runtime: 'opencode' }) };
      expect(registry.resolveForAgent('agent-1', meshCore)).toBe(oc);
    });

    it('falls back to default when agent has no runtime field', () => {
      const cc = createMockRuntime('claude-code');
      registry.register(cc);
      const meshCore = { getAgent: () => ({}) };
      expect(registry.resolveForAgent('agent-1', meshCore)).toBe(cc);
    });

    it('falls back to default when agent is not found', () => {
      const cc = createMockRuntime('claude-code');
      registry.register(cc);
      const meshCore = { getAgent: () => undefined };
      expect(registry.resolveForAgent('unknown', meshCore)).toBe(cc);
    });

    it('falls back to default when meshCore is undefined', () => {
      const cc = createMockRuntime('claude-code');
      registry.register(cc);
      expect(registry.resolveForAgent('agent-1')).toBe(cc);
    });

    it('falls back to default when agent runtime type is not registered', () => {
      const cc = createMockRuntime('claude-code');
      registry.register(cc);
      const meshCore = { getAgent: () => ({ runtime: 'aider' }) };
      expect(registry.resolveForAgent('agent-1', meshCore)).toBe(cc);
    });
  });

  describe('listRuntimes', () => {
    it('returns empty array when no runtimes registered', () => {
      expect(registry.listRuntimes()).toEqual([]);
    });

    it('returns all registered runtimes', () => {
      const cc = createMockRuntime('claude-code');
      const oc = createMockRuntime('opencode');
      registry.register(cc);
      registry.register(oc);
      expect(registry.listRuntimes()).toHaveLength(2);
      expect(registry.listRuntimes()).toContain(cc);
      expect(registry.listRuntimes()).toContain(oc);
    });
  });

  describe('getAllCapabilities', () => {
    it('returns capabilities keyed by type', () => {
      registry.register(createMockRuntime('claude-code', { supportsCostTracking: true }));
      registry.register(createMockRuntime('opencode', { supportsCostTracking: false }));
      const caps = registry.getAllCapabilities();
      expect(caps['claude-code'].supportsCostTracking).toBe(true);
      expect(caps['opencode'].supportsCostTracking).toBe(false);
    });

    it('returns empty object when no runtimes registered', () => {
      expect(registry.getAllCapabilities()).toEqual({});
    });
  });

  describe('has', () => {
    it('returns true for registered types', () => {
      registry.register(createMockRuntime('claude-code'));
      expect(registry.has('claude-code')).toBe(true);
    });

    it('returns false for unregistered types', () => {
      expect(registry.has('claude-code')).toBe(false);
    });
  });

  describe('getDefaultType', () => {
    it('returns claude-code as the initial default type', () => {
      expect(registry.getDefaultType()).toBe('claude-code');
    });

    it('returns the updated default type after setDefault', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('opencode'));
      registry.setDefault('opencode');
      expect(registry.getDefaultType()).toBe('opencode');
    });
  });

  describe('applyConfiguredDefaultRuntime', () => {
    it('applies a registered configured default and reports success', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('opencode'));

      const applied = applyConfiguredDefaultRuntime(registry, 'opencode');

      expect(applied).toBe(true);
      expect(registry.getDefaultType()).toBe('opencode');
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

    it('applies the configured default immediately', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('opencode'));

      applyAndWatchConfiguredDefaultRuntime(registry, source('opencode'));

      expect(registry.getDefaultType()).toBe('opencode');
    });

    it('re-applies it when the setting changes, with no restart', () => {
      // The reason the change-subscription primitive exists: the default runtime
      // is APPLIED once, so without this a person changes it in Settings, the
      // screen agrees, and nothing happens until they restart.
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('codex'));
      const config = source('claude-code');
      applyAndWatchConfiguredDefaultRuntime(registry, config);

      config.write('codex');

      expect(registry.getDefaultType()).toBe('codex');
    });

    it('ignores a write to some other section', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('codex'));
      const config = source('claude-code');
      applyAndWatchConfiguredDefaultRuntime(registry, config);

      config.write('codex', ['ui']);

      expect(registry.getDefaultType()).toBe('claude-code');
    });

    it('keeps the current default when the new value names no registered runtime', () => {
      registry.register(createMockRuntime('claude-code'));
      const config = source('claude-code');
      applyAndWatchConfiguredDefaultRuntime(registry, config);

      config.write('opencode');

      expect(registry.getDefaultType()).toBe('claude-code');
    });

    it('stops listening once unsubscribed', () => {
      registry.register(createMockRuntime('claude-code'));
      registry.register(createMockRuntime('codex'));
      const config = source('claude-code');

      applyAndWatchConfiguredDefaultRuntime(registry, config)();
      config.write('codex');

      expect(registry.getDefaultType()).toBe('claude-code');
    });
  });

  describe('registerOptionalRuntime', () => {
    // Reproduces the launch-blocking crash: CodexRuntime/OpenCodeRuntime throw
    // synchronously at construction when their CLI binary isn't found (the
    // norm in the packaged desktop app, which bundles only the claude-code
    // SDK). registerOptionalRuntime is the seam that isolates that failure.

    it('returns the constructed runtime and registers it on success', () => {
      const runtime = createMockRuntime('opencode');
      const result = registerOptionalRuntime('OpenCodeRuntime', 'install the OpenCode CLI', () => {
        registry.register(runtime);
        return runtime;
      });

      expect(result).toBe(runtime);
      expect(registry.has('opencode')).toBe(true);
    });

    it('swallows a synchronous construction throw, warns, and returns undefined', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      const result = registerOptionalRuntime('CodexRuntime', 'install the Codex CLI', () => {
        throw new Error('Unable to locate Codex CLI binaries');
      });

      expect(result).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const [message, context] = warn.mock.calls[0]!;
      expect(message).toContain('CodexRuntime');
      expect(message).toContain('failed to initialize');
      expect(message).toContain('install the Codex CLI');
      expect((context as { err: Error }).err.message).toBe('Unable to locate Codex CLI binaries');

      warn.mockRestore();
    });

    it('never registers a runtime whose constructor throws, so it stays unregistered', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

      registerOptionalRuntime('CodexRuntime', 'install the Codex CLI', () => {
        throw new Error('Unable to locate Codex CLI binaries');
      });

      expect(registry.has('codex')).toBe(false);
      // applyConfiguredDefaultRuntime keeps tolerating this exact shape: a
      // configured-but-unregistered default falls back to the built-in one
      // rather than failing boot.
      const applied = applyConfiguredDefaultRuntime(registry, 'codex');
      expect(applied).toBe(false);
      expect(registry.getDefaultType()).toBe('claude-code');

      warn.mockRestore();
    });

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

    describe('persistSessionRuntime', () => {
      it('inserts a new row for a new session', async () => {
        await registry.persistSessionRuntime('session-1', 'claude-code');
        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-1'))
          .get();
        expect(row?.runtime).toBe('claude-code');
        expect(row?.agentPath).toBeNull();
        expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      });

      it("seeds the server's execution defaults onto the row it creates", async () => {
        // The first-write seam: the per-runtime model/effort land on the row
        // that mints the session, without any caller passing them.
        serverDefaults = { model: 'opus', effort: 'high' };

        await registry.persistSessionRuntime('session-seeded', 'claude-code');

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-seeded'))
          .get();
        expect(row?.model).toBe('opus');
        expect(row?.effort).toBe('high');
      });

      it("prefers the owning agent's model and effort over the server's", async () => {
        // The agent tier (spec `execution-defaults` E2). The agent is known here
        // and nowhere else on this path, which is why the read happens here.
        serverDefaults = { model: 'opus', effort: 'high' };
        agentDefaults = { model: 'sonnet', effort: 'low' };

        await registry.persistSessionRuntime('session-agent-seeded', 'claude-code', '/agents/kai');

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-agent-seeded'))
          .get();
        expect(row?.model).toBe('sonnet');
        expect(row?.effort).toBe('low');
      });

      it('falls back to the server default for a session with no agent', async () => {
        serverDefaults = { model: 'opus' };
        agentDefaults = { model: 'sonnet' };

        await registry.persistSessionRuntime('session-agentless', 'claude-code');

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-agentless'))
          .get();
        expect(row?.model).toBe('opus');
      });

      it('never seeds over a session that already has a row', async () => {
        // "Applies to new conversations — running ones keep their settings."
        await registry.persistSessionRuntime('session-running', 'claude-code');
        await registry.saveSessionSettings('session-running', { model: 'sonnet' });
        serverDefaults = { model: 'opus', effort: 'high' };

        const created = await registry.persistSessionRuntime('session-running', 'claude-code');

        expect(created).toBe(false);
        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-running'))
          .get();
        expect(row?.model).toBe('sonnet');
        expect(row?.effort).toBeNull();
      });

      it('stores agentPath when provided', async () => {
        await registry.persistSessionRuntime('session-2', 'claude-code', '/path/to/agent');
        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-2'))
          .get();
        expect(row?.agentPath).toBe('/path/to/agent');
      });

      it('is idempotent — second call does not overwrite existing row', async () => {
        await registry.persistSessionRuntime('session-3', 'claude-code', '/first/path');
        await registry.persistSessionRuntime('session-3', 'test-mode', '/second/path');
        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'session-3'))
          .get();
        expect(row?.runtime).toBe('claude-code');
        expect(row?.agentPath).toBe('/first/path');
      });

      it('seeds the trust stop only for a session a person is watching', async () => {
        // The interactive-only boundary at the seam that decides it. A room turn
        // reaches this same method (`room-turn-runner`) and must never inherit
        // the cockpit's default, so the runtime's declared modes — the thing that
        // turns a configured stop into a mode id — ride only the flagged call.
        interactiveDefaults = { permissionMode: 'bypassPermissions' };

        await registry.persistSessionRuntime('session-attended', 'claude-code', undefined, {
          interactive: true,
        });
        await registry.persistSessionRuntime('session-unattended', 'claude-code');

        const read = (id: string) =>
          db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, id)).get();
        expect(read('session-attended')?.permissionMode).toBe('bypassPermissions');
        expect(read('session-unattended')?.permissionMode).toBeNull();
      });

      it("hands the resolver the runtime's OWN declared modes, never a table here", async () => {
        await registry.persistSessionRuntime('session-profile', 'claude-code', undefined, {
          interactive: true,
        });
        expect(lastResolveOpts?.permissionModes).toEqual(
          registry.get('claude-code').getCapabilities().permissionModes.values
        );
      });

      it("hands the resolver the runtime's OWN declared config section", async () => {
        // Which `runtimes.*` block holds a runtime's defaults is that runtime's
        // declaration, and this is the seam that carries it: the resolver cannot
        // ask the registry itself (the registry imports the resolver), so an
        // answer that stops flowing here is a per-runtime default that silently
        // stops applying.
        registry.register(
          createMockRuntime('declares-a-section', {
            settings: { configSection: 'codex', supportsEffort: true, sections: [] },
          })
        );

        await registry.persistSessionRuntime('session-declared-section', 'declares-a-section');

        expect(lastResolveOpts?.configSection).toBe('codex');
      });

      it('hands over no section for a runtime that is not registered here', async () => {
        // The degraded build `registerOptionalRuntime` allows: nothing declared
        // means no per-runtime default, which is the honest answer — seeding a
        // row for a runtime that is not here would hand the fallback runtime a
        // model id from a namespace it cannot read.
        await registry.persistSessionRuntime('session-absent-runtime', 'never-registered');

        expect(lastResolveOpts?.configSection).toBeUndefined();
      });

      it('returns true on the first insert and false on the duplicate (the once-per-session signal)', async () => {
        // This boolean gates the once-per-session `session_created` usage event
        // at the POST /messages call site — a regression here double-fires it.
        const first = await registry.persistSessionRuntime('session-5', 'claude-code');
        const second = await registry.persistSessionRuntime('session-5', 'claude-code');
        expect(first).toBe(true);
        expect(second).toBe(false);
      });
    });

    describe('getSessionRuntimeType', () => {
      it('returns the stored runtime string for an existing row', async () => {
        await registry.persistSessionRuntime('session-4', 'test-mode');
        expect(await registry.getSessionRuntimeType('session-4')).toBe('test-mode');
      });

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

      it('returns the unregistered runtime type without throwing', async () => {
        // Raw insert of a row whose runtime is not registered.
        await db.insert(sessionMetadata).values({
          sessionId: 'orphan-session',
          runtime: 'codex',
          agentPath: null,
          createdAt: new Date().toISOString(),
        });
        expect(await registry.getSessionRuntimeType('orphan-session')).toBe('codex');
      });
    });

    describe('getSessionBindings (DOR-1436)', () => {
      it('answers only for sessions that are actually bound', async () => {
        await registry.persistSessionRuntime('started', 'test-mode');
        // A settings write before the first turn: the row exists, the owner does
        // not (DOR-812).
        await registry.saveSessionSettings('picked-a-mode', { permissionMode: 'default' });

        const bindings = registry.getSessionBindings(['started', 'picked-a-mode', 'never-seen']);

        expect([...bindings.keys()]).toEqual(['started']);
        expect(bindings.get('started')?.runtime).toBe('test-mode');
      });

      it('never infers, where getSessionRuntimeType does', async () => {
        // The whole reason this method exists beside that one: its caller
        // deletes rows, and the default-runtime inference would hand every
        // never-started session to claude-code and take its words with it.
        expect(await registry.getSessionRuntimeType('legacy-session')).toBe('claude-code');
        expect(registry.getSessionBindings(['legacy-session']).size).toBe(0);
      });

      it('reports when the binding was written, so a caller can tell it from a fresh one', async () => {
        const before = Date.now();
        await registry.persistSessionRuntime('timed', 'test-mode');

        const boundAt = registry.getSessionBindings(['timed']).get('timed')?.boundAt;

        expect(boundAt).not.toBeNull();
        expect(boundAt).toBeGreaterThanOrEqual(before - 1);
        expect(boundAt).toBeLessThanOrEqual(Date.now() + 1);
      });

      it('reports an unreadable timestamp as unknown rather than as a number', async () => {
        // `created_at` is free-form TEXT. A caller comparing garbage against a
        // clock would get a verdict out of a value that means nothing.
        await db.insert(sessionMetadata).values({
          sessionId: 'hand-edited',
          runtime: 'test-mode',
          agentPath: null,
          createdAt: 'sometime last week',
        });

        expect(registry.getSessionBindings(['hand-edited']).get('hand-edited')).toEqual({
          runtime: 'test-mode',
          boundAt: null,
        });
      });

      it('reads a list far past what one statement can bind', async () => {
        // SQLite compiles in a bound-variable ceiling (32766 on this build); one
        // unchunked `IN (...)` past it throws "too many SQL variables" and loses
        // the WHOLE read — which for the boot reconcile means every candidate
        // looks unbound. 1200 ids, the count this test used first, never came
        // near it and the chunking could be deleted with the test still green.
        await registry.persistSessionRuntime('needle', 'test-mode');
        const ids = [...Array.from({ length: 40_000 }, (_, i) => `bulk-${i}`), 'needle'];

        const bindings = registry.getSessionBindings(ids);

        expect(bindings.get('needle')?.runtime).toBe('test-mode');
      });

      it('asks nothing for an empty list', () => {
        expect(registry.getSessionBindings([])).toEqual(new Map());
      });
    });

    describe('resolveForSession', () => {
      it('returns claude-code for a new session without writing a row (infer-on-miss, no persist)', async () => {
        const runtime = await registry.resolveForSession('new-session');
        expect(runtime.type).toBe('claude-code');

        const row = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'new-session'))
          .get();
        expect(row).toBeUndefined();
      });

      it('returns the runtime matching an existing row', async () => {
        await registry.persistSessionRuntime('existing-session', 'test-mode');
        const runtime = await registry.resolveForSession('existing-session');
        expect(runtime.type).toBe('test-mode');
      });

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

      it('does not re-insert on second call for the same session (idempotent infer)', async () => {
        await registry.resolveForSession('legacy-1');
        const firstRow = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'legacy-1'))
          .get();
        const firstCreatedAt = firstRow?.createdAt;

        await registry.resolveForSession('legacy-1');
        const secondRow = db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, 'legacy-1'))
          .get();
        expect(secondRow?.createdAt).toBe(firstCreatedAt);
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

    it('UPSERT creates an UNBOUND row when none exists', async () => {
      // A settings change can arrive before the first message — no row yet. The
      // row it creates carries the setting and no runtime: which runtime the
      // session will run on is the first turn's to say (DOR-812).
      await registry.saveSessionSettings('s1', { permissionMode: 'bypassPermissions' });
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 's1'))
        .get();
      expect(row?.runtime).toBeNull();
      expect(row?.permissionMode).toBe('bypassPermissions');
      expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('updates only provided columns and leaves identity intact on conflict', async () => {
      await registry.persistSessionRuntime('s2', 'test-mode', '/agent/path');
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

    it('is a no-op when no fields are provided (no row created)', async () => {
      await registry.saveSessionSettings('s3', {});
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 's3'))
        .get();
      expect(row).toBeUndefined();
    });

    it('getSessionSettings returns null when no row exists', async () => {
      expect(await registry.getSessionSettings('missing')).toBeNull();
    });

    it('getSessionSettings maps NULL columns to omitted keys', async () => {
      await registry.saveSessionSettings('s4', { permissionMode: 'plan' });
      const settings = await registry.getSessionSettings('s4');
      // Only the set field is present; unset columns are absent, not null/undefined values.
      expect(settings).toEqual({ permissionMode: 'plan' });
      expect('model' in settings!).toBe(false);
    });

    it('seeds nothing at all — the row it creates has no runtime to seed for', async () => {
      // E3's pre-launch picker makes a settings change before the first message
      // the normal way a session starts, and it used to seed the server defaults
      // right here. It cannot: every default is a per-runtime answer, and this
      // write does not know the runtime (DOR-812). The seed rides the binding
      // write instead — see 'an early settings write leaves the runtime unbound'.
      serverDefaults = { model: 'opus', effort: 'high' };
      interactiveDefaults = { permissionMode: 'bypassPermissions' };

      await registry.saveSessionSettings('pre-launch', { model: 'sonnet' });

      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 'pre-launch'))
        .get();
      // The person's explicit choice, and nothing beside it.
      expect(row?.model).toBe('sonnet');
      expect(row?.effort).toBeNull();
      expect(row?.permissionMode).toBeNull();
    });

    it('never lets a default reach a row that already exists', async () => {
      // The UPDATE branch carries the patch alone: an existing row is a running
      // session, whatever the server default now says.
      await registry.persistSessionRuntime('already-running', 'claude-code');
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
      // `effort` is a free-form TEXT column. A rung removed in a later release,
      // or a hand-edited row, used to be cast straight to `EffortLevel` and sent
      // into an adapter. Unreadable means "no preference", the same as NULL.
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

    it('round-trips boolean settings as booleans (not 1/0)', async () => {
      await registry.saveSessionSettings('s5', { fastMode: true });
      const settings = await registry.getSessionSettings('s5');
      expect(settings).toEqual({ fastMode: true });
    });

    it('getSessionSettingsMany batch-reads multiple sessions in one call', async () => {
      await registry.saveSessionSettings('m1', { permissionMode: 'bypassPermissions' });
      await registry.saveSessionSettings('m2', { model: 'claude-haiku-4-5-20251001' });
      const many = registry.getSessionSettingsMany(['m1', 'm2', 'absent']);
      expect(many.get('m1')).toEqual({ permissionMode: 'bypassPermissions' });
      expect(many.get('m2')).toEqual({ model: 'claude-haiku-4-5-20251001' });
      expect(many.has('absent')).toBe(false); // no row → absent from the map
    });

    it('getSessionSettingsMany returns an empty map for empty input (no query)', () => {
      expect(registry.getSessionSettingsMany([]).size).toBe(0);
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

    it('does not choose the runtime — the first turn still does', async () => {
      // The bug: a pre-launch settings change created the row with the INFERRED
      // runtime, and the binding write is first-write-wins, so a session the
      // person had pointed at another runtime was pinned to claude-code forever
      // by the act of changing a setting before sending anything.
      await registry.saveSessionSettings('pre-launch-codex', { model: 'sonnet' });

      await registry.persistSessionRuntime('pre-launch-codex', 'test-mode');

      expect(await registry.getSessionRuntimeType('pre-launch-codex')).toBe('test-mode');
      expect(read('pre-launch-codex')?.runtime).toBe('test-mode');
      // ...and the choice that created the row is still the person's.
      expect(read('pre-launch-codex')?.model).toBe('sonnet');
    });

    it('writes no runtime at all, rather than a guess', async () => {
      await registry.saveSessionSettings('unbound', { model: 'sonnet' });
      expect(read('unbound')?.runtime).toBeNull();
    });

    it('still READS as the inferred runtime, so nothing is bricked before the binding', async () => {
      // Every read path — the /events connect, the settings PATCH capability
      // gate, a history GET — resolves an unbound row exactly like a row-less
      // one: the inference answers, and stays unpersisted.
      await registry.saveSessionSettings('unbound-read', { model: 'sonnet' });

      expect(await registry.getSessionRuntimeType('unbound-read')).toBe('claude-code');
      expect((await registry.resolveForSession('unbound-read')).type).toBe('claude-code');
      expect(read('unbound-read')?.runtime).toBeNull();
    });

    it('seeds the defaults of the runtime it BINDS, not of the one it guessed', async () => {
      // The reason the seed cannot ride the settings write: every key of it is a
      // per-runtime answer (`resolve-session-defaults` — the model id lives in
      // one runtime's namespace, the effort is dropped where a runtime has none,
      // the trust stop is resolved from the runtime's own declared modes). A
      // value written before the runtime is known is a guess in every key.
      await registry.saveSessionSettings('seed-at-binding', { model: 'sonnet' });
      serverDefaults = { model: 'opus', effort: 'high' };

      await registry.persistSessionRuntime('seed-at-binding', 'test-mode');

      expect(lastResolveOpts?.runtimeType).toBe('test-mode');
      // The person's explicit choice survives the claim...
      expect(read('seed-at-binding')?.model).toBe('sonnet');
      // ...and only the key their write did not carry is filled.
      expect(read('seed-at-binding')?.effort).toBe('high');
    });

    it('seeds the trust stop when the binding write says a person is watching', async () => {
      interactiveDefaults = { permissionMode: 'bypassPermissions' };
      await registry.saveSessionSettings('stop-at-binding', { model: 'sonnet' });
      await registry.saveSessionSettings('stop-unattended', { model: 'sonnet' });

      await registry.persistSessionRuntime('stop-at-binding', 'claude-code', undefined, {
        interactive: true,
      });
      await registry.persistSessionRuntime('stop-unattended', 'claude-code');

      expect(read('stop-at-binding')?.permissionMode).toBe('bypassPermissions');
      // A room turn claims the same shape of row and must still inherit nothing.
      expect(read('stop-unattended')?.permissionMode).toBeNull();
    });

    it('records the owning agent on the row the settings write left behind', async () => {
      await registry.saveSessionSettings('agent-at-binding', { model: 'sonnet' });

      await registry.persistSessionRuntime('agent-at-binding', 'test-mode', '/agents/kai');

      expect(read('agent-at-binding')?.agentPath).toBe('/agents/kai');
    });

    it('reports the claim as the session being created, exactly once', async () => {
      // The boolean gates the once-per-session `session_created` usage event.
      // Binding an unbound row IS that session starting; the turn after is not.
      await registry.saveSessionSettings('claim-signal', { model: 'sonnet' });

      const first = await registry.persistSessionRuntime('claim-signal', 'test-mode');
      const second = await registry.persistSessionRuntime('claim-signal', 'test-mode');

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('drops a stored permission mode the runtime it binds cannot run', async () => {
      // The settings PATCH that stored this mode was gated against the INFERRED
      // runtime, because that is all an unbound session has. So the stored mode
      // is provisional, and the binding write is where it stops being: the
      // runtime being bound is now known, and a mode it never declared would
      // leave the session reporting a safety posture it is not running — the
      // exact lie the PATCH gate exists to prevent.
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
            ],
          },
        })
      );
      await registry.saveSessionSettings('mode-undeclared', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-undeclared', 'narrow');

      expect(read('mode-undeclared')?.permissionMode).toBeNull();
    });

    it('lands the bound runtime’s own default where the dropped mode was', async () => {
      // Order matters: the drop has to happen UNDER the seed, or the session
      // would be left with no stop where the person had chosen one.
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
            ],
          },
        })
      );
      interactiveDefaults = { permissionMode: 'strict' };
      await registry.saveSessionSettings('mode-reseeded', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-reseeded', 'narrow', undefined, {
        interactive: true,
      });

      expect(read('mode-reseeded')?.permissionMode).toBe('strict');
    });

    it('keeps a stored mode the runtime it binds does declare', async () => {
      // TWO declared modes, and the stored one is NOT the one the seed would
      // write. With a single mode — or a stored value equal to the seed —
      // `coalesce(kept, seed)` answers the same whether the case kept the mode
      // or dropped it, and the assertion would pin nothing.
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
      interactiveDefaults = { permissionMode: 'default' };
      await registry.saveSessionSettings('mode-declared', { permissionMode: 'acceptEdits' });

      await registry.persistSessionRuntime('mode-declared', 'twomode', undefined, {
        interactive: true,
      });

      expect(read('mode-declared')?.permissionMode).toBe('acceptEdits');
    });

    it('drops the mode outright for a runtime that declares none', async () => {
      registry.register(
        createMockRuntime('modeless', { permissionModes: { supported: false, values: [] } })
      );
      await registry.saveSessionSettings('mode-modeless', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-modeless', 'modeless');

      expect(read('mode-modeless')?.permissionMode).toBeNull();
    });

    it('leaves the mode alone when the runtime being bound is not registered', async () => {
      // No profile on this server means no basis to judge — the same answer
      // `seedForNewRow` gives when it cannot read a runtime's declared modes.
      // Nothing runs such a session anyway (`resolveForSession` throws), so
      // deleting the person's choice would only lose it.
      await registry.saveSessionSettings('mode-unknown-runtime', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('mode-unknown-runtime', 'codex');

      expect(read('mode-unknown-runtime')?.permissionMode).toBe('plan');
    });

    it('never re-judges the mode of a session that is already bound', async () => {
      // WRITE PATH ONLY, exactly as the PATCH gate is: a session already running
      // in a now-undeclared mode keeps it and keeps running.
      registry.register(
        createMockRuntime('modeless', { permissionModes: { supported: false, values: [] } })
      );
      await registry.persistSessionRuntime('already-bound-mode', 'modeless');
      await registry.saveSessionSettings('already-bound-mode', { permissionMode: 'plan' });

      await registry.persistSessionRuntime('already-bound-mode', 'modeless');

      expect(read('already-bound-mode')?.permissionMode).toBe('plan');
    });

    it('never re-binds a session whose runtime is already set (ADR-0255)', async () => {
      // The invariant the fix must not spend: the first AUTHORITATIVE write wins.
      // Only an inference is negotiable.
      await registry.persistSessionRuntime('bound', 'test-mode', '/first/path');
      serverDefaults = { model: 'opus' };

      const created = await registry.persistSessionRuntime('bound', 'claude-code', '/second/path');

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

    it('moves the whole row, identity columns included', async () => {
      await registry.persistSessionRuntime('old', 'test-mode', '/agent/path');
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
      await registry.persistSessionRuntime('new', 'claude-code');
      await registry.saveSessionSettings('new', { model: 'sonnet' });
      await registry.persistSessionRuntime('old', 'test-mode');
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

    it('carries the binding onto a destination that has none', async () => {
      // The same immutability rule, not an exception to it: a destination row
      // minted by a settings change owns no runtime, so there is nothing there
      // to protect and the source's binding travels with the row it describes.
      await registry.saveSessionSettings('new', { model: 'sonnet' });
      await registry.persistSessionRuntime('old', 'test-mode');

      await registry.rekeySessionSettings('old', 'new');

      expect(allRows()).toHaveLength(1);
      expect(allRows()[0]).toMatchObject({ sessionId: 'new', runtime: 'test-mode' });
    });

    it('never replaces a newer destination choice with the older source one', async () => {
      // The source row is always the older of the two: nothing can be written
      // under the canonical id before the runtime announces it, and everything
      // resolves there afterwards. Source-wins therefore reinstated the mode the
      // operator had just left — here, an agent that acts without asking.
      await registry.saveSessionSettings('old', { permissionMode: 'bypassPermissions' });
      await registry.saveSessionSettings('new', { permissionMode: 'plan' });

      await registry.rekeySessionSettings('old', 'new');

      expect(await registry.getSessionSettings('new')).toEqual({ permissionMode: 'plan' });
    });

    it('merges field by field — the destination keeps only what it has set', async () => {
      // Not an all-or-nothing pick between two rows: each column is resolved on
      // its own, so an operator's newer mode survives alongside a model that was
      // only ever chosen under the old id.
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

    it('is a no-op when the source has no row', async () => {
      await registry.saveSessionSettings('new', { permissionMode: 'plan' });

      await registry.rekeySessionSettings('absent', 'new');

      expect(await registry.getSessionSettings('new')).toEqual({ permissionMode: 'plan' });
      expect(allRows()).toHaveLength(1);
    });

    it('is a no-op when the ids are the same (never deletes the row)', async () => {
      await registry.saveSessionSettings('same', { permissionMode: 'plan' });

      await registry.rekeySessionSettings('same', 'same');

      expect(await registry.getSessionSettings('same')).toEqual({ permissionMode: 'plan' });
    });
  });
});
