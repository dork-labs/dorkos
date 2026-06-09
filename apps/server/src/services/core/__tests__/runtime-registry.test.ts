import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeRegistry, RuntimeNotRegisteredError } from '../runtime-registry.js';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, eq, type Db } from '@dorkos/db';

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
    watchSession: () => () => {},
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
        values: [{ id: 'default', label: 'Default' }],
      },
      features: {},
      ...overrides,
    }),
    getCommands: async () => ({ commands: [], lastScanned: new Date().toISOString() }),
    checkSessionHealth: () => {},
    getInternalSessionId: () => undefined,
  } as AgentRuntime;
}

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
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

    it('UPSERT creates a row with the inferred runtime when none exists', async () => {
      // A settings change can arrive before the first message — no row yet.
      await registry.saveSessionSettings('s1', { permissionMode: 'bypassPermissions' });
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 's1'))
        .get();
      expect(row?.runtime).toBe('claude-code'); // inferred (no prior row)
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
});
