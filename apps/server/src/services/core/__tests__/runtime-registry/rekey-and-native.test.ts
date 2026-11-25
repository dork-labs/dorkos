/**
 * Moving a session's settings to a new id, and the native-import and auto-resume
 * paths that must never consume a fresh birth. None of these read the server's
 * defaults, so unlike `../runtime-registry.test.ts` they run the real resolver.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  sessionContext,
  sessionBirthAllocations,
  sessionLocations,
  sessionMetadata,
  sessionNativeBindings,
  eq,
  sql,
  type Db,
} from '@dorkos/db';
import { RuntimeRegistry } from '../../runtime-registry.js';
import { readDraftSource } from '../../runtime-seam/person-draft-settings.js';
import { logger } from '../../../../lib/logger.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../../session/fleet/session-limit-store.js';
import { A_PERSON, createMockRuntime, rowOf } from './runtime-registry.fixtures.js';

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;

  beforeEach(() => {
    registry = new RuntimeRegistry();
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
    const read = () => rowOf(db, sessionId);
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
        await (await import('../../../../lib/boundary.js')).initBoundary(process.cwd());
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
      await (await import('../../../../lib/boundary.js')).initBoundary(process.cwd());
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
      await (await import('../../../../lib/boundary.js')).initBoundary(process.cwd());
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
      expect(rowOf(db, legacyId)).toMatchObject({ runtime: 'opencode', modelLaunchState: null });

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
      await (await import('../../../../lib/boundary.js')).initBoundary(process.cwd());
      db.$client.exec(
        "CREATE TEMP TRIGGER reject_birth_native BEFORE INSERT ON session_native_bindings BEGIN SELECT RAISE(ABORT, 'owned-native-write-refused'); END;"
      );
      await expect(
        registry.rememberNativeSession(native(), { kind: 'program', userId: 'user-1' })
      ).rejects.toThrow('owned-native-write-refused');
      expect(read()).toBeUndefined();
      expect(db.select().from(sessionNativeBindings).all()).toEqual([]);
    });
  });
});
