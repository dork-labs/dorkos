import { describe, it, expect, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  readClaudeAccountSettings,
} from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  initConfigManager,
  backfillClaudeCodeRuntimeDefaults,
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  migrateClaudeAccountRegistry,
} from '../../config-manager.js';
import { applyConfigPatch } from '../../operator/config-patch.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { wasBackedUp, createMockStore } from './config-manager.fixtures.js';

describe('migrateClaudeAccountRegistry migration (billing-account-ladder, DOR-1407)', () => {
  it('carries the chosen account across the rename and drops the old key', () => {
    // The half that is not additive: left behind, the operator's chosen billing
    // account is silently replaced by whatever the environment points at. The
    // old key is dropped so the file converges on one spelling — Ajv would
    // tolerate it (`tolerateUnknownKeys` reopens the object); two keys for one
    // billing setting is what must not survive.
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: '/Users/me/.claude2', accounts: [] },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: { defaultAccount: '/Users/me/.claude2', accounts: [] },
    });
  });

  it('carries a null default across too, rather than dropping the key', () => {
    const store = createMockStore({
      runtimes: { claudeCode: { activeAccount: null, accounts: [] } },
    });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toEqual({ claudeCode: { defaultAccount: null, accounts: [] } });
  });

  it('backfills an id from the label, slugified', () => {
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [{ path: '/Users/me/.claude2', label: 'Acme Corp' }],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: unknown[] } }).claudeCode.accounts
    ).toEqual([{ id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' }]);
  });

  it("falls back to the directory's basename when the account has no label", () => {
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [{ path: '/Users/me/.claude3', label: null }],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }).claudeCode
        .accounts[0]!.id
    ).toBe('claude3');
  });

  it('uniquifies ids that would collide', () => {
    // Two accounts an operator named the same thing, or two directories with the
    // same basename under different parents. A duplicate id would make one of
    // them unreachable and silently repoint every agent naming it.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'ACME corp' },
            { path: '/c/.claude', label: 'acme-corp' },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    const ids = (
      store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }
    ).claudeCode.accounts.map((account) => account.id);
    expect(ids).toEqual(['acme-corp', 'acme-corp-2', 'acme-corp-3']);
    expect(new Set(ids).size).toBe(3);
  });

  it('uniquifies against an id an earlier run already assigned', () => {
    // Half-migrated state is reachable: a re-run after a crash, or an operator
    // who hand-added an entry. A second pass must not mint a colliding id.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'Acme Corp' },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }).claudeCode.accounts
    ).toEqual([
      { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
      { id: 'acme-corp-2', path: '/b/.claude', label: 'Acme Corp' },
    ]);
  });

  it('is idempotent — a second run changes nothing', () => {
    // What this catches: a re-run (corrupt-recovery instantiates conf twice)
    // re-minting ids and breaking every agent that references one.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: '/Users/me/.claude2',
          accounts: [
            { path: '/Users/me/.claude2', label: 'Acme Corp' },
            { path: '/Users/me/.claude3', label: null },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);
    const afterFirst = structuredClone(store.data.runtimes);
    migrateClaudeAccountRegistry(store);

    expect(store.data.runtimes).toEqual(afterFirst);
  });

  it('leaves an already-migrated config completely alone', () => {
    const migrated = {
      claudeCode: {
        defaultAccount: '/Users/me/.claude2',
        accounts: [{ id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' }],
      },
    };
    const store = createMockStore({ runtimes: structuredClone(migrated) });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toEqual(migrated);
  });

  it('is a no-op when there is no runtimes block at all', () => {
    const store = createMockStore({ server: { port: 4242 } });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('a real pre-0.65.0 config file comes back renamed and referenceable (full conf path)', () => {
    // The mock store never crosses the conf/Ajv boundary, and Ajv is what
    // REJECTS a config the schema no longer admits. This is the only check that
    // an install carrying the old shape survives the upgrade with its billing
    // choice intact rather than being condemned and replaced.
    const dir = path.join(os.tmpdir(), 'test-dork-account-ladder-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      const cfgPath = path.join(dir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          ...USER_CONFIG_DEFAULTS,
          runtimes: {
            ...USER_CONFIG_DEFAULTS.runtimes,
            claudeCode: {
              activeAccount: '/Users/me/.claude2',
              accounts: [
                { path: '/Users/me/.claude2', label: 'Acme Corp' },
                { path: '/Users/me/.claude3', label: null },
              ],
            },
          },
          __internal__: { migrations: { version: '0.64.0' } },
        })
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // The SHIPPED schema, tolerances included. Constructing without one was
        // the defect this test had on review: `conf` only runs Ajv when it is
        // given a schema, so the test that claimed to prove the migrated file
        // validates was proving nothing at all.
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.65.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: { claudeCode: Record<string, unknown> };
      };
      expect(onDisk.runtimes.claudeCode).toMatchObject({
        defaultAccount: '/Users/me/.claude2',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' },
          { id: 'claude3', path: '/Users/me/.claude3', label: null },
        ],
      });
      expect(onDisk.runtimes.claudeCode).not.toHaveProperty('activeAccount');

      // And the migrated file is one the live schema accepts, which is the whole
      // point of doing it through conf.
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillClaudeCodeRuntimeDefaults migration (claude-code-accounts)', () => {
  it('adds claudeCode to an existing runtimes block without touching its siblings', () => {
    // The case the migration exists for: conf merges top-level defaults shallowly,
    // so a stored `runtimes` object never inherits a new nested section.
    const store = createMockStore({
      runtimes: {
        default: 'opencode',
        opencode: { enabled: true, binaryPath: '/opt/bin/opencode', port: 5111 },
        codex: { enabled: false, binaryPath: null, credentialRef: 'env:CODEX_KEY' },
      },
    });
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toEqual({
      default: 'opencode',
      opencode: { enabled: true, binaryPath: '/opt/bin/opencode', port: 5111 },
      codex: { enabled: false, binaryPath: null, credentialRef: 'env:CODEX_KEY' },
      claudeCode: { activeAccount: null, accounts: [] },
    });
  });

  it('is idempotent and never overwrites a chosen account or a registered roster', () => {
    const configured = {
      default: 'claude-code',
      claudeCode: {
        activeAccount: '/Users/me/.claude2',
        accounts: [{ path: '/Users/me/.claude2', label: 'Acme Corp' }],
      },
    };
    const store = createMockStore({ runtimes: structuredClone(configured) });
    backfillClaudeCodeRuntimeDefaults(store);
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toEqual(configured);
  });

  it('is a no-op when there is no runtimes block (the schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('a real pre-0.57.0 config file gains the section on disk (full conf path)', () => {
    // A real `conf` store over a real file — the mock never crosses the conf/Ajv
    // seam (`.claude/rules/safe-defaults.md`). `projectVersion` is stated
    // explicitly because SERVER_VERSION resolves to 0.0.0 in a dev tree, which
    // puts the unreleased key outside conf's `(storedVersion, projectVersion]`
    // window and would run no migration at all.
    //
    // The assertion reads the FILE, not the store: Ajv fills the missing section
    // in on every READ, so `store.get('runtimes')` would look right even with the
    // migration deleted. What only the migration does is write it through.
    const dir = path.join(os.tmpdir(), 'test-dork-claudecode-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const priorRuntimes = {
        default: 'claude-code',
        opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
        codex: { enabled: true, binaryPath: null, credentialRef: null },
      };
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          server: { port: 5000, cwd: null, boundary: null, open: true },
          runtimes: priorRuntimes,
          __internal__: { migrations: { version: '0.56.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        // The shipped schema, tolerances included — never rebuilt here (see CONF_JSON_SCHEMA).
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.57.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: Record<string, unknown>;
      };
      expect(onDisk.runtimes.claudeCode).toEqual({
        activeAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      });
      // The upgrade adds a section; it changes no runtime the person configured.
      expect(onDisk.runtimes).toMatchObject(priorRuntimes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a real config file that already names an account, through Ajv', () => {
    // Ajv, not Zod, is the validator on the config read path, and it REJECTS
    // unknown keys where Zod merely strips them. Booting a real manager over a
    // populated roster is the only way to prove the generated JSON Schema
    // actually admits this shape.
    const dir = path.join(os.tmpdir(), 'test-dork-claudecode-set-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          ...USER_CONFIG_DEFAULTS,
          runtimes: {
            ...USER_CONFIG_DEFAULTS.runtimes,
            claudeCode: {
              defaultAccount: '/Users/me/.claude3',
              accounts: [
                { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
                { id: 'claude3', path: '/Users/me/.claude3', label: null },
              ],
            },
          },
        })
      );
      const manager = initConfigManager(dir);
      expect(manager.get('runtimes').claudeCode).toEqual({
        defaultAccount: '/Users/me/.claude3',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
          { id: 'claude3', path: '/Users/me/.claude3', label: null },
        ],
        defaultAccountColor: null,
        defaultAccountOnlyProjects: null,
        projectAccounts: {},
        dismissedFolders: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: true,
        maxWarmProcesses: null,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Claude account registry written before ids, through the real conf load path', () => {
  // The expensive failure lives at the conf/Ajv seam, and the mock-store
  // migration tests above cannot see it: `accounts[].id` is REQUIRED and did not
  // exist before 0.65.0, so EVERY config file ever written is schema-invalid the
  // moment the `'0.65.0'` migration is skipped — and ConfigManager's recovery
  // path then backs up and replaces the WHOLE file, not just the accounts.
  //
  // `new ConfigManager(dir)` resolves SERVER_VERSION to `0.0.0` (the dev
  // /package.json fallback), so NO migration runs. That is what every `pnpm dev`
  // does, and what a release cut below 0.65.0 would do to every user on it.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A config file holding a pre-0.65.0 Claude account registry. */
  function seedPreLadder(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-pre-account-ladder-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        // Unrelated sections carrying real choices, so a silent whole-file reset
        // is visible rather than coincidentally identical to the defaults.
        mesh: { ...USER_CONFIG_DEFAULTS.mesh, scanRoots: ['/projects/alpha'] },
        telemetry: { userHasDecided: true, install: false, heartbeat: false },
        runtimes: {
          ...USER_CONFIG_DEFAULTS.runtimes,
          claudeCode: {
            activeAccount: '/Users/me/.claude2',
            accounts: [
              { path: '/Users/me/.claude2', label: 'Acme Corp' },
              { path: '/Users/me/.claude3', label: null },
            ],
          },
        },
        __internal__: { migrations: { version: '0.64.0' } },
      })
    );
    return { dir, configPath };
  }

  it('is not condemned — no backup is written and the file is not replaced', () => {
    const { dir } = seedPreLadder();
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
  });

  it('keeps every unrelated section, including a telemetry opt-out and the scan roots', () => {
    // The real cost of condemning the file, stated as an assertion: this is what
    // a person loses when a required field lands without a schema tolerance.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);
    expect(manager.get('mesh').scanRoots).toEqual(['/projects/alpha']);
    expect(manager.get('telemetry').userHasDecided).toBe(true);
    expect(manager.get('telemetry').install).toBe(false);
  });

  it('reads an id of the WRONG TYPE instead of condemning the file (DOR-2379)', () => {
    // The registry is shared with flow and hand-editable, and its read rules
    // skip or re-mint a bad row rather than refuse the file (contract
    // `flow-cli-core` §1.1a). A number where a slug belongs is re-minted on
    // read; resetting every setting over one account row is the worse answer.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-bad-account-id-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        runtimes: {
          ...USER_CONFIG_DEFAULTS.runtimes,
          claudeCode: {
            defaultAccount: null,
            accounts: [{ id: 42, path: '/Users/me/.claude2', label: null }],
          },
        },
        __internal__: { migrations: { version: '0.64.0' } },
      })
    );
    const manager = new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
    expect(
      readClaudeAccountSettings(manager.get('runtimes').claudeCode).accounts.map((a) => a.id)
    ).toEqual(['claude2']);
  });

  it('still accepts a settings write while the migration has not run', () => {
    // `applyConfigPatch` re-parses the whole MERGED config with Zod, and Zod is
    // the half that HEALS rather than tolerates. Without the backfill inside
    // `ClaudeCodeAccountsSchema` that parse fails on the missing ids and EVERY
    // settings write in the cockpit is refused — a theme change included —
    // until the migration runs. Ajv tolerance alone does not cover this.
    const { dir, configPath } = seedPreLadder();
    initConfigManager(dir);

    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      ui: { theme: string };
      runtimes: { claudeCode: { accounts: { path: string }[] } };
    };
    // The write landed, and the registry it did not name is untouched — conf
    // persists the sections a patch writes, so the ids are healed on every parse
    // rather than rewritten here. The migration is what settles them on disk.
    expect(onDisk.ui.theme).toBe('light');
    expect(onDisk.runtimes.claudeCode.accounts.map((a) => a.path)).toEqual([
      '/Users/me/.claude2',
      '/Users/me/.claude3',
    ]);
  });

  it("keeps the stored registry readable as-is — the healing is the READER's job", () => {
    // Deliberately NOT a claim about what a launch sees. This file's subject is
    // the conf load path: the file is accepted, and what conf hands back is what
    // is on disk, ids and all still absent until the migration writes them.
    //
    // Parsing it here with Zod would prove only that Zod heals, which is not the
    // question a LAUNCH asks — nothing on the launch path consults Zod. That
    // claim belongs to the seam the ladder actually reads, and it is made
    // against `describeClaudeCodeAccounts` and `resolveLaunchAccountRoot` in
    // `runtimes/claude-code/__tests__/pre-ladder-config.test.ts`.
    const { dir } = seedPreLadder();
    const stored = new ConfigManager(dir).getAll();
    expect(stored.runtimes.claudeCode.accounts.map((a) => a.path)).toEqual([
      '/Users/me/.claude2',
      '/Users/me/.claude3',
    ]);
  });
});
