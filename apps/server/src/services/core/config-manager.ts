/**
 * Persistent user configuration — canonical entry point.
 *
 * Owns `~/.dork/config.json` via the `conf` library (v15.1.0). Zod is the
 * authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's
 * Ajv validation so we never hand-maintain JSON Schema. Handles first-run
 * detection, corrupt-config backup + recreate, and sensitive-field warnings.
 *
 * ## Migration semantics (conf's `projectVersion` model)
 *
 * `conf` tracks migration state **inside the config file itself**, in an
 * internal key at `__internal__.migrations.version`. On every instantiation:
 *
 *   1. Conf reads the stored `__internal__.migrations.version`.
 *   2. Compares against `projectVersion` passed to the constructor.
 *   3. Runs every migration whose semver key is greater than the stored
 *      version and less than or equal to `projectVersion`, in semver order.
 *   4. After all migrations run, writes `projectVersion` back.
 *
 * `projectVersion` is the **app version**, not a schema version. Migration
 * keys are the app versions at or after which each migration should fire.
 * Each migration runs at most once per user.
 *
 * ## Append-only rule
 *
 * Never edit a shipped migration body. Once a migration has run on real
 * users, its body is frozen — editing it leaves users in divergent states.
 * To fix a bad migration, append a new one at the next version.
 *
 * ## Adding or changing fields
 *
 * See `contributing/configuration.md` → **Schema Migrations** for the full
 * process, and `.claude/skills/adding-config-fields/SKILL.md` for the
 * guided flow. The `/system:release` command's Phase 2 Check 6 detects
 * schema drift and offers to scaffold missing migrations inline before the
 * release tag is cut.
 *
 * ## Implementation notes
 *
 * - `projectVersion` is sourced from `SERVER_VERSION` in `lib/version.ts`,
 *   which honors `DORKOS_VERSION_OVERRIDE`, the esbuild-injected
 *   `__CLI_VERSION__`, and the package.json dev fallback in that order. Do
 *   not hardcode a version string here.
 * - Both the primary and corrupt-recovery Conf constructors use a single
 *   `confOptions` object inside the constructor below so the migration
 *   chain and `projectVersion` apply equally on recovery. If you add new
 *   options, add them to `confOptions` — do not duplicate the literal.
 * - Migrations live in the module-level `CONFIG_MIGRATIONS` constant so
 *   they are append-only by construction and trivially testable in
 *   isolation.
 *
 * @module services/core/config-manager
 */
import Conf from 'conf';
import { type Schema } from 'conf';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
} from '@dorkos/shared/config-schema';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../lib/logger.js';
import { SERVER_VERSION } from '../../lib/version.js';

/**
 * Append-only `conf` migration chain keyed by app version. See
 * `contributing/configuration.md` → Schema Migrations and
 * `.claude/skills/adding-config-fields/SKILL.md` for the full process.
 *
 * Rules:
 *
 * 1. Never edit a shipped migration body. Append a new entry instead.
 * 2. Every migration must be idempotent (guard with `store.has()`).
 * 3. Keys are app versions (semver), matching real release versions.
 * 4. Conf tracks last-applied state internally at
 *    `__internal__.migrations.version` inside the config file itself.
 */
/**
 * Migration body: backfill `extensions.disabled: []` for configs persisted
 * before the two-list deviation model (Core Extensions). Additive and
 * idempotent — only writes when `disabled` is not already an array, and never
 * touches `enabled`. Configs with no `extensions` key are skipped (the schema
 * default supplies the object on read).
 *
 * Exported for direct unit testing: its {@link CONFIG_MIGRATIONS} key (`0.44.0`)
 * only fires for users upgrading across that release, so exercising the body
 * directly is the reliable test path.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillExtensionsDisabled(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (ext && typeof ext === 'object' && !Array.isArray((ext as { disabled?: unknown }).disabled)) {
    store.set('extensions', { ...(ext as Record<string, unknown>), disabled: [] });
  }
}

/**
 * Migration body: backfill the `workspace` section (WorkspaceManager, DOR-84)
 * for configs persisted before it existed. Additive + idempotent — only writes
 * when the key is absent; the schema default also yields this object on read, so
 * this just writes it through on the upgrade where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkspaceDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('workspace') == null) {
    store.set('workspace', {
      enabled: true,
      rootPath: null,
      portBase: 4250,
      portBlockSize: 10,
      defaultProvider: 'worktree',
      retentionCap: null,
    });
  }
}

/**
 * Migration body: backfill the `harness` section (Harness Sync auto-sync gate,
 * GAP-4) for configs persisted before it existed. Additive + idempotent: only
 * writes when the key is absent; the schema default also yields this object on
 * read, so this just writes it through on the upgrade where it lands. Defaults
 * `autoSync` to `true` (auto-sync on install/uninstall is on by default).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillHarnessDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('harness') == null) {
    store.set('harness', { autoSync: true });
  }
}

/**
 * Migration body: backfill the `runtimes` section (multi-runtime support,
 * additional-agent-runtimes spec) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema
 * default also yields this object on read, so this just writes it through on
 * the upgrade where it lands. Defaults the registry default to `claude-code`
 * with both optional runtimes (opencode, codex) enabled.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRuntimesDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('runtimes') == null) {
    store.set('runtimes', {
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0 },
      codex: { enabled: true, binaryPath: null },
    });
  }
}

/**
 * Migration body: backfill the `auth` section (local login gate,
 * accounts-and-auth P1) for configs persisted before it existed. Additive +
 * idempotent: only writes when the key is absent; the schema default also yields
 * `{ enabled: false }` on read, so this just writes the key through on the
 * upgrade where it lands. Defaults `enabled` to `false` (login is opt-in;
 * progressive disclosure).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillAuthDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('auth') == null) {
    store.set('auth', { enabled: false });
  }
}

const CONFIG_MIGRATIONS = {
  '1.0.0': (store: {
    has: (key: string) => boolean;
    set: (key: string, value: unknown) => void;
  }) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
  // Backfill `extensions.disabled: []` for configs persisted before the two-list
  // deviation model (Core Extensions). Resolved from a `<next-release>` placeholder
  // to v0.44.0 at release time (/system:release). Additive + idempotent; the schema
  // default also yields `disabled: []` on read, so this just writes the key through
  // on the upgrade where it lands.
  '0.44.0': backfillExtensionsDisabled,
  // Backfill the `workspace` section (WorkspaceManager, DOR-84). Keyed to the
  // next release; /system:release reconciles the concrete version at tag time.
  '0.45.0': backfillWorkspaceDefaults,
  // Backfill the `harness` section (Harness Sync auto-sync gate, GAP-4). Keyed
  // to the next ascending release; /system:release reconciles the concrete
  // version at tag time. Additive + idempotent; the schema default also yields
  // `{ autoSync: true }` on read, so this just writes the key through on the
  // upgrade where it lands.
  '0.46.0': backfillHarnessDefaults,
  // Backfill the `runtimes` section (multi-runtime support, DOR-180). Keyed to
  // the next ascending release; /system:release reconciles the concrete
  // version at tag time. Additive + idempotent; the schema default also yields
  // this object on read, so this just writes the key through on the upgrade
  // where it lands.
  '0.47.0': backfillRuntimesDefaults,
  // Backfill the `auth` section (local login gate, accounts-and-auth P1). Keyed
  // to the next ascending release; /system:release reconciles the concrete
  // version at tag time. `0.48.0` because DOR-180 took `0.47.0` for `runtimes`
  // on main. Additive + idempotent; the schema default also yields
  // `{ enabled: false }` on read, so this just writes the key through on the
  // upgrade where it lands.
  '0.48.0': backfillAuthDefaults,
} as const;

const jsonSchemaFull = z.toJSONSchema(UserConfigSchema, {
  target: 'jsonSchema2019-09',
}) as { properties?: Record<string, unknown> };
const jsonSchemaProperties = jsonSchemaFull.properties ?? {};

// Cast the runtime JSON schema to conf's Schema type. The Zod-generated schema
// is structurally compatible at runtime but TypeScript cannot verify it statically.
const confSchema = jsonSchemaProperties as unknown as Schema<UserConfig>;

/**
 * Manages persistent user configuration at ~/.dork/config.json.
 *
 * Uses `conf` for atomic JSON I/O with Ajv validation via the JSON Schema
 * generated from UserConfigSchema. Handles first-run detection, corrupt
 * config recovery (backup + recreate), and sensitive field warnings.
 */
class ConfigManager {
  private store: Conf<UserConfig>;
  private _isFirstRun = false;

  constructor(dorkHome: string) {
    const configDir = dorkHome;
    const configPath = path.join(configDir, 'config.json');
    this._isFirstRun = !fs.existsSync(configPath);

    // Single source of truth for Conf constructor options. Used by both the
    // primary instantiation (try branch) and the corrupt-recovery fallback
    // (catch branch) so migrations and projectVersion apply on recovery too.
    // Previously the catch branch silently dropped projectVersion and
    // migrations, which meant users who hit corrupt-recovery would never run
    // migrations on subsequent upgrades.
    const confOptions = {
      configName: 'config',
      cwd: configDir,
      schema: confSchema,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      // `projectVersion` is the app version — sourced from the canonical
      // version resolver (`lib/version.ts`) which honors
      // `DORKOS_VERSION_OVERRIDE`, the esbuild-injected CLI version, and the
      // package.json dev fallback in that order. Migration keys in
      // CONFIG_MIGRATIONS must be semver strings matching real releases.
      projectVersion: SERVER_VERSION,
      migrations: CONFIG_MIGRATIONS,
    } satisfies ConstructorParameters<typeof Conf<UserConfig>>[0];

    try {
      this.store = new Conf<UserConfig>(confOptions);
      logger.info(`[Config] Loaded from ${configPath} (first run: ${this._isFirstRun})`);
    } catch (_error) {
      if (fs.existsSync(configPath)) {
        const backupPath = configPath + '.bak';
        fs.copyFileSync(configPath, backupPath);
        fs.unlinkSync(configPath);
        logger.warn(`Corrupt config backed up to ${backupPath}`);
        logger.warn('Creating fresh config with defaults.');
      }
      // Reuse the exact same options so the recovered store still has the
      // migration chain wired up.
      this.store = new Conf<UserConfig>(confOptions);
    }
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /** Get a top-level config section */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    return this.store.get(key);
  }

  /** Get a nested value via dot-path (e.g., 'server.port') */
  getDot(key: string): unknown {
    return this.store.get(key as keyof UserConfig);
  }

  /** Set a top-level config section */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    this.store.set(key, value);
  }

  /** Set a nested value via dot-path. Returns warning if key is sensitive. */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    this.store.set(key as keyof UserConfig, value as UserConfig[keyof UserConfig]);
    return result;
  }

  /** Get the full config object */
  getAll(): UserConfig {
    return this.store.store;
  }

  /** Reset a specific key or all keys to defaults */
  reset(key?: string): void {
    if (key) {
      this.store.reset(key as keyof UserConfig);
    } else {
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
    }
  }

  /** Validate the current config against the Zod schema */
  validate(): { valid: boolean; errors?: string[] } {
    try {
      UserConfigSchema.parse(this.store.store);
      return { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        };
      }
      throw error;
    }
  }

  /** Absolute path to the config file */
  get path(): string {
    return this.store.path;
  }
}

export let configManager: ConfigManager;

/** Initialize the config manager. Called once at startup. */
export function initConfigManager(dorkHome: string): ConfigManager {
  configManager = new ConfigManager(dorkHome);
  return configManager;
}
