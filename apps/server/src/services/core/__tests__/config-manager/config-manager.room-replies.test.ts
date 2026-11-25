import { describe, it, expect } from 'vitest';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  initConfigManager,
  seedRoomRepoDefaults,
  dropRetiredDorkosTools,
  seedMaxConcurrentTurnsPerAgent,
  retireToolOnlyReplies,
} from '../../config-manager.js';
import { applyConfigPatch } from '../../operator/config-patch.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  RUNTIMES_DEFAULTS,
  createMockStore,
  upgradeConfigFile,
} from './config-manager.fixtures.js';

describe('seedRoomRepoDefaults migration (project-rooms §3.12, DOR-1591)', () => {
  it('reserves rooms.repo on a `rooms` block that predates it', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `rooms` block never inherits the new
    // nested section on its own. Drop the body and this reads `undefined`.
    const store = createMockStore({ rooms: { turnLimitsEnabled: true, maxAgentDepth: 30 } });
    seedRoomRepoDefaults(store);
    expect(store.data.rooms).toEqual({
      turnLimitsEnabled: true,
      maxAgentDepth: 30,
      repo: USER_CONFIG_DEFAULTS.rooms.repo,
    });
  });

  it('never overwrites bounds somebody set (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // slackening a ceiling the person tightened, which is exactly the wipe the
    // operator-only verdict on these paths exists to prevent.
    const chosen = { enabled: false, maxFileBytes: 1024 };
    const store = createMockStore({ rooms: { repo: chosen } });
    seedRoomRepoDefaults(store);
    expect((store.data.rooms as Record<string, unknown>).repo).toBe(chosen);
  });

  it('does nothing when there is no `rooms` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `rooms` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    seedRoomRepoDefaults(store);
    expect(store.data.rooms).toBeUndefined();
  });

  it('a real pre-0.70.0 config file gains rooms.repo on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach — see
    // the `backfillPromoDismissals` case above for the measurement this shape
    // comes from (DOR-1496). `rooms` is a nested-leaf case, so this body is the
    // ONLY thing that puts `repo` on the file: suppress it and this goes red
    // while `store.get('rooms').repo` still answers from Ajv's discarded copy.
    const onDisk = upgradeConfigFile<{
      rooms: Record<string, unknown>;
    }>(
      {
        rooms: { turnLimitsEnabled: true, maxAgentDepth: 12, replyWaitMinutes: 25 },
      },
      '0.69.0',
      '0.70.0'
    );
    expect(onDisk.rooms.repo).toEqual({
      enabled: true,
      worktreeReapDays: 14,
      maxFileBytes: 5 * 1024 * 1024,
      maxRepoBytes: 500 * 1024 * 1024,
      maxRoomMdBytes: 24 * 1024,
      mergeQueueWaitMs: 30_000,
    });
    // The upgrade adds a section; it changes nothing the person had set.
    expect(onDisk.rooms.maxAgentDepth).toBe(12);
    expect(onDisk.rooms.replyWaitMinutes).toBe(25);
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });
});

describe('dropRetiredDorkosTools migration (tool-only-room-replies §A1, DOR-2099)', () => {
  it('deletes the retired leaf from a `runtimes` block that carries it', () => {
    const store = createMockStore({
      runtimes: { default: 'codex', defaultTrustStop: 'act', dorkosTools: true },
    });
    dropRetiredDorkosTools(store);
    expect(store.data.runtimes).toEqual({ default: 'codex', defaultTrustStop: 'act' });
  });

  it('writes nothing when the leaf is already gone (idempotent)', () => {
    // A re-run — corrupt recovery instantiates conf twice — must not rewrite a
    // section it has nothing to change in. `writes` counts `set` calls, so a
    // body that wrote unconditionally is caught here rather than passing on the
    // deep-equality coincidence that the result looks the same either way.
    const store = createMockStore({ runtimes: { default: 'codex' } });
    dropRetiredDorkosTools(store);
    expect(store.writes).toEqual([]);
    expect(store.data.runtimes).toEqual({ default: 'codex' });
  });

  it('does nothing when there is no `runtimes` block at all', () => {
    const store = createMockStore({ server: { port: 4242 } });
    dropRetiredDorkosTools(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('a real config file carrying the retired leaf loses it on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedRoomRepoDefaults` above for the DOR-1496 measurement this shape comes
    // from). Suppress the body and this goes red.
    const onDisk = upgradeConfigFile<{
      runtimes: Record<string, unknown>;
    }>(
      {
        runtimes: { default: 'codex', defaultTrustStop: 'act', dorkosTools: true },
      },
      '0.79.0',
      '0.80.0'
    );
    expect('dorkosTools' in onDisk.runtimes).toBe(false);
    // The upgrade removes one leaf; it changes nothing the person had set.
    expect(onDisk.runtimes.default).toBe('codex');
    expect(onDisk.runtimes.defaultTrustStop).toBe('act');
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });

  /** A config file stamped past `'0.80.0'` but still carrying the retired leaf. */
  function seedUnmigratedLeaf(label: string): { dir: string; cfgPath: string } {
    const dir = path.join(os.tmpdir(), `test-dork-dorkos-tools-${label}-` + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        runtimes: { ...RUNTIMES_DEFAULTS, default: 'codex', dorkosTools: true },
        __internal__: { migrations: { version: '0.80.0' } },
      }),
      'utf-8'
    );
    return { dir, cfgPath };
  }

  it('an install the migration never reached loses the leaf on a Zod-parsed write', () => {
    // The other half of the retired-keys mechanism, and the reason the leaf is
    // still DECLARED to Ajv after the schema stopped carrying it. A dev tree
    // resolves SERVER_VERSION to `0.0.0` and runs no migration at all, so
    // convergence has to come from the write path: `preserveUnknownKeys` carries
    // a key the schema does not declare back onto every write, for ever. Delete
    // the declaration in `tolerateRetiredRuntimeKeys` and this goes red while
    // every other test here stays green.
    //
    // `applyConfigPatch` re-parses the whole config, so Zod's strip is what
    // actually drops the key; the declaration is what stops it being re-attached
    // afterwards. The sibling test below pins the write shape this does NOT
    // reach, so the pair says exactly what the mechanism promises.
    const { dir, cfgPath } = seedUnmigratedLeaf('patch');
    try {
      initConfigManager(dir);
      expect(applyConfigPatch({ runtimes: { default: 'opencode' } }).ok).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: Record<string, unknown>;
      };
      expect('dorkosTools' in onDisk.runtimes).toBe(false);
      expect(onDisk.runtimes.default).toBe('opencode');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a caller that spreads the STORED section back over itself keeps the leaf', () => {
    // The limit of the declaration half, pinned rather than left to be
    // rediscovered. `ConfigManager.write` writes the value its caller passed, and
    // `get('runtimes')` hands back conf's stored object rather than a Zod parse —
    // so a caller spreading it re-supplies the retired key itself, and nothing
    // here overrules a caller. This is the live shape from
    // `connect/persist-provider-credential.ts`, copied deliberately so that
    // changing it there and not here is visible.
    //
    // It is not a defect: `'0.80.0'` covers every install a release reaches, and
    // the Zod-parsed write above covers the rest. It is asserted so the TSDoc on
    // `tolerateRetiredRuntimeKeys`, this test and the code agree on what the
    // mechanism promises.
    const { dir, cfgPath } = seedUnmigratedLeaf('spread');
    try {
      const config = initConfigManager(dir);
      const runtimes = config.get('runtimes');
      config.set('runtimes', {
        ...runtimes,
        opencode: { ...runtimes.opencode, provider: 'openrouter' },
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: Record<string, unknown>;
      };
      expect('dorkosTools' in onDisk.runtimes).toBe(true);
      expect((onDisk.runtimes.opencode as Record<string, unknown>).provider).toBe('openrouter');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('retireToolOnlyReplies migration (tool-only-room-replies §A2, DOR-2099)', () => {
  it('deletes the retired leaf from a `rooms` block that carries it, whatever it was set to', () => {
    // Both stored values, because the whole point of the removal is that NEITHER
    // selects a behaviour any more: a `true` an operator opted into and a
    // `false` a migration seeded have to converge on the same config.
    for (const stored of [true, false]) {
      const store = createMockStore({
        rooms: { maxAgentDepth: 12, maxPostsPerTurn: 1, toolOnlyReplies: stored },
      });
      retireToolOnlyReplies(store);
      expect(store.data.rooms, `stored ${String(stored)}`).toEqual({
        maxAgentDepth: 12,
        maxPostsPerTurn: 1,
      });
    }
  });

  it('seeds nothing for the ceiling now that it is retired (DOR-2739)', () => {
    // The frozen body still names `maxPostsPerTurn`'s default, which no longer
    // exists, so it writes no value; `'0.113.0'` deletes the leaf regardless.
    const store = createMockStore({ rooms: { maxAgentDepth: 12, toolOnlyReplies: true } });
    retireToolOnlyReplies(store);
    expect(JSON.parse(JSON.stringify(store.data.rooms))).toEqual({ maxAgentDepth: 12 });
  });

  it('never overwrites a ceiling somebody chose', () => {
    const store = createMockStore({ rooms: { maxPostsPerTurn: 1 } });
    retireToolOnlyReplies(store);
    expect(store.writes).toEqual([]);
    expect(store.data.rooms).toEqual({ maxPostsPerTurn: 1 });
  });

  it('writes nothing when the leaf is gone and the ceiling is set (idempotent)', () => {
    // A re-run — corrupt recovery instantiates conf twice — must not rewrite a
    // section it has nothing to change in. `writes` counts `set` calls, so a body
    // that wrote unconditionally is caught here rather than passing on the
    // deep-equality coincidence that the result looks the same either way.
    const store = createMockStore({ rooms: { maxAgentDepth: 12, maxPostsPerTurn: 3 } });
    retireToolOnlyReplies(store);
    expect(store.writes).toEqual([]);
    expect(store.data.rooms).toEqual({ maxAgentDepth: 12, maxPostsPerTurn: 3 });
  });

  it('does nothing when there is no `rooms` block at all', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `rooms` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    retireToolOnlyReplies(store);
    expect(store.data.rooms).toBeUndefined();
  });

  it('a real config file loses the leaf on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedRoomRepoDefaults` above for the DOR-1496 measurement this shape comes
    // from). Suppress the body and this goes red.
    const onDisk = upgradeConfigFile<{
      rooms: Record<string, unknown>;
    }>(
      {
        rooms: { maxAgentDepth: 12, replyWaitMinutes: 25, toolOnlyReplies: true },
      },
      '0.80.0',
      '0.81.0'
    );
    expect('toolOnlyReplies' in onDisk.rooms).toBe(false);
    // The ceiling it once seeded is retired (DOR-2739), so nothing is added.
    expect('maxPostsPerTurn' in onDisk.rooms).toBe(false);
    // It changes nothing the person had set.
    expect(onDisk.rooms.maxAgentDepth).toBe(12);
    expect(onDisk.rooms.replyWaitMinutes).toBe(25);
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });

  it('an install the migration never reached loses the leaf on a Zod-parsed write', () => {
    // The other half of the retired-keys mechanism, and the reason the leaf is
    // still DECLARED to Ajv after the schema stopped carrying it — the same pair
    // `dropRetiredDorkosTools` above documents, over `rooms` this time. Delete
    // the declaration in `tolerateRetiredRoomKeys` and this goes red while every
    // other test here stays green.
    const dir = path.join(os.tmpdir(), 'test-dork-tool-only-declared-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          rooms: { ...USER_CONFIG_DEFAULTS.rooms, toolOnlyReplies: true },
          __internal__: { migrations: { version: '0.81.0' } },
        }),
        'utf-8'
      );

      initConfigManager(dir);
      expect(applyConfigPatch({ rooms: { replyWaitMinutes: 25 } }).ok).toBe(true);

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        rooms: Record<string, unknown>;
      };
      expect('toolOnlyReplies' in onDisk.rooms).toBe(false);
      expect(onDisk.rooms.replyWaitMinutes).toBe(25);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedMaxConcurrentTurnsPerAgent migration (DOR-2104)', () => {
  it('reserves the leaf on a `rooms` block that predates the setting', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `rooms` block never inherits the new leaf
    // on its own. Drop the body and it reads `undefined`.
    const store = createMockStore({ rooms: { maxAgentDepth: 12, maxCanvasOpsPerTurn: 1 } });
    seedMaxConcurrentTurnsPerAgent(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 12,
      maxCanvasOpsPerTurn: 1,
      maxConcurrentTurnsPerAgent: 3,
    });
  });

  it('never overwrites a limit somebody chose (idempotent)', () => {
    // The stored value differs from the seeded one, so a body that wrote
    // unconditionally is caught here rather than passing on a coincidence.
    const store = createMockStore({ rooms: { maxConcurrentTurnsPerAgent: 1 } });
    seedMaxConcurrentTurnsPerAgent(store);
    expect(store.data.rooms).toEqual({ maxConcurrentTurnsPerAgent: 1 });
  });

  it('does nothing when there is no `rooms` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedMaxConcurrentTurnsPerAgent(store);
    expect(store.data.rooms).toBeUndefined();
  });

  it('a real pre-0.84.0 config file gains the leaf on disk (full conf path)', () => {
    // Reads the FILE: conf's `store` getter hands back a copy Ajv has already
    // filled the default into, so a `getDot` assertion passes with the body
    // deleted (DOR-1496). `projectVersion` is explicit because `SERVER_VERSION`
    // is `0.0.0` in a dev tree, which runs no migration at all.
    const onDisk = upgradeConfigFile<{
      rooms: Record<string, unknown>;
    }>(
      {
        rooms: { maxAgentDepth: 12, maxPostsPerTurn: 1, maxCanvasOpsPerTurn: 2 },
      },
      '0.83.0',
      '0.84.0'
    );
    expect(onDisk.rooms.maxConcurrentTurnsPerAgent).toBe(3);
    // The upgrade adds one leaf; it changes nothing the person had set.
    expect(onDisk.rooms.maxAgentDepth).toBe(12);
    expect(onDisk.rooms.maxPostsPerTurn).toBe(1);
    expect(onDisk.rooms.maxCanvasOpsPerTurn).toBe(2);
    expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
  });

  it('a fresh install gets the same value from both default declarations', () => {
    // The per-field default feeds a stored `rooms` block missing the leaf; the
    // section literal feeds an install with no `rooms` block at all. They must
    // agree, or which value a person gets depends on their config's history.
    expect(USER_CONFIG_DEFAULTS.rooms.maxConcurrentTurnsPerAgent).toBe(3);
    expect(UserConfigSchema.parse({ version: 1, rooms: {} }).rooms.maxConcurrentTurnsPerAgent).toBe(
      3
    );
  });
});
