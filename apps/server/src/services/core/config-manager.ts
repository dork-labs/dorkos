/**
 * Persistent user configuration — canonical entry point.
 *
 * Owns `~/.dork/config.json` via the `conf` library (v15.1.0). Zod is the
 * authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's
 * Ajv validation so we never hand-maintain JSON Schema. Handles first-run
 * detection, corrupt-config backup + recreate, and sensitive-field warnings.
 *
 * ## Nothing is replaced that could not be read
 *
 * Recovery replaces the config file, so what counts as "corrupt" is a data-loss
 * decision, not a logging one. Two rules, and the second is the one that holds
 * absolutely:
 *
 * 1. A failure the OS raised — any errno error, including one `conf` stripped
 *    the code off — never replaces anything, however long it lasts
 *    ({@link classifyConfigLoadFailure}).
 * 2. Whatever rule 1 misses, nothing is replaced unless
 *    {@link readStoredConfigForSalvage} first read the file. A successful read
 *    is both the evidence that the file really is the problem and the only way
 *    a protection can be carried across, and it is a stronger guarantee than
 *    any judgement about an error's shape.
 *
 * Three more things are not the file's fault, and none of them condemns it. A
 * key this build does not declare belongs to another build — see
 * `config/version-skew.ts`, which is why an unrecognized key is no longer a
 * schema violation at all. A named scalar leaf holding a value a NEWER build
 * widened belongs to that build too — see `config/widened-leaves.ts`, which
 * takes those leaves away from Ajv and has Zod fall back to the schema default
 * in memory while the value stays on disk. And a migration body that throws is a
 * defect in DorkOS, which stops the boot loudly
 * ({@link ConfigMigrationFailedError}) rather than replacing anything.
 *
 * **What is left, and it is a real residual.** Tolerance stops where
 * preservation stops: inside a LIST or a RECORD. A new `ui.statusBar.pins` id,
 * a new `workbench.defaultViewers` viewer, a new `onboarding.completedSteps`
 * step written by a newer build still condemns the file, because an element has
 * a position rather than a name and no honest rule carries it back across a
 * write. So does a change to `version` itself. Both are named in
 * `contributing/configuration.md`.
 *
 * When a file really is replaced, the copy is timestamped and rotated
 * (`config/backups.ts`), so a second recovery cannot overwrite the settings the
 * first one saved.
 *
 * ## Migration semantics (conf's `projectVersion` model)
 *
 * `conf` tracks migration state **inside the config file itself**, in an
 * internal key at `__internal__.migrations.version`. On every instantiation:
 *
 *   1. Conf reads the stored `__internal__.migrations.version`.
 *   2. Compares against `projectVersion` passed to the constructor.
 *   3. Runs every migration whose semver key is greater than the stored
 *      version and less than or equal to `projectVersion`, in **object-insertion
 *      order** (conf does not sort the keys) — so keep the entries in ascending
 *      version order to match intent.
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
 *   isolation. The table is in `config-migrations/index.ts`, and the helpers
 *   its keys call sit beside it in files grouped by version range; a new key
 *   goes at the bottom of the table and its helper at the bottom of
 *   `config-migrations/v0-90-onward.ts`. This module re-exports all of it, so
 *   `CONFIG_MIGRATIONS` and every helper still import from here.
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
  toSidebarItemRef,
} from '@dorkos/shared/config-schema';
import type { UserConfig, SidebarItemRef } from '@dorkos/shared/config-schema';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { logger, logError } from '../../lib/logger.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { ConfigUnreadableError, formatConfigLoadError } from './config/boot-errors.js';
export {
  ConfigBootError,
  ConfigUnreadableError,
  ConfigMigrationFailedError,
} from './config/boot-errors.js';
import { browserSettingRefusal } from './config/browser-setting.js';
import { hubPinnedRead, hubSettingRefusal } from './config/hub-settings.js';
import { restoreProtectedState } from './safe-defaults/protected-state.js';
import { backupConfigFile } from './config/backups.js';
import { readStoredConfigForSalvage } from './config/salvage-read.js';
import { loadConfigStore } from './config/load-store.js';
import {
  tolerateLegacyClaudeAccountEncoding,
  tolerateRetiredSidebarKeys,
  tolerateRetiredRoomKeys,
  tolerateRetiredRuntimeKeys,
  tolerateRetiredUiKeys,
} from './config/retired-key-tolerance.js';
import { preserveUnknownKeys, schemaNodeAt, tolerateUnknownKeys } from './config/version-skew.js';
import {
  describeWidenedLeaf,
  findUnreadableLeaves,
  preserveWidenedLeaves,
  relaxWidenedLeaves,
  repairWidenedLeaves,
  unreadableSettingsWarning,
} from './config/widened-leaves.js';
import type { WidenedLeaf, WidenedLeafPolicy } from './config/widened-leaves.js';

export { classifyConfigLoadFailure, type ConfigLoadFailureKind } from './config/load-failure.js';
import { CONFIG_MIGRATIONS } from './config-migrations/index.js';
import { RETIRED_SIDEBAR_COLLAPSE_KEYS } from './config-migrations/v0-57-to-v0-59.js';
export { CONFIG_MIGRATIONS } from './config-migrations/index.js';
export * from './config-migrations/v0-44-to-v0-56.js';
export * from './config-migrations/v0-57-to-v0-59.js';
export * from './config-migrations/v0-60-to-v0-89.js';
export * from './config-migrations/v0-90-onward.js';

/**
 * One line describing a load failure, for a log or an error message.
 *
 * Node's `fs` errors already begin with their errno code
 * (`EMFILE: too many open files, open '…'`), so the message alone is the whole
 * story for the case this exists to report.
 *
 * @param error - Whatever was thrown.
 */
function describeLoadError(error: unknown): string {
  return formatConfigLoadError(error);
}

/**
 * Backoff before each retry of a config read that failed for a reason other
 * than corruption, in milliseconds. Its length is the retry count: four
 * attempts in total, 750ms of waiting in the worst case.
 *
 * Sized for the failure it exists for. File-descriptor exhaustion is a burst:
 * the fds come back within milliseconds once whatever grabbed them settles, so
 * a short staircase converts most of those boots into a normal one. Waiting
 * longer buys little at boot, and any failure that outlives the staircase is
 * reported rather than guessed at.
 */
export const CONFIG_LOAD_RETRY_DELAYS_MS = [50, 200, 500] as const;

/**
 * The pre-DOR-579 name for a section's member list.
 *
 * Named here rather than spelled inline because two things read it: the shipped
 * `0.59.0` migration, and `ConfigManager.canonicalSidebar`, which catches the
 * installs that migration's version window misses.
 */
const LEGACY_MEMBERS_KEY = 'agentPaths';

/**
 * Retire the standing-permission settings (spec `agent-permissions` D13, phase
 * 2): delete `approvals.standingGrants`, `approvals.trustWindowMinutes` and
 * `approvals.standingGrantsVoidBefore`, and the `approvals` section itself once
 * nothing else is in it. "Always allow" on a request card replaced standing
 * permissions; the grants themselves were ended at upgrade, not converted (see
 * `permissions/ended-standing-grants.ts`).
 *
 * A top-level section this build no longer declares, so nothing else ever
 * writes it again: this body is the whole removal. Anything else a newer build
 * put under `approvals` is kept, on the version-skew rule.
 *
 * Deliberately NOT a config migration. A migration runs whenever the config
 * store opens, and the CLI opens it before the server has migrated the
 * database, so a migration would erase the settings the capture of live
 * standing permissions needs (the master switch and the void floor) before it
 * ran. The server calls this once the capture is done, through
 * {@link ConfigManager.retireStandingGrantSettings}; until then the section is an
 * unknown key, carried across writes like any other.
 *
 * @param store - The config store.
 */
export function retireStandingGrantSettings(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const stored = store.get('approvals');
  if (stored === undefined) return;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    store.delete('approvals');
    return;
  }
  const {
    standingGrants: _standingGrants,
    trustWindowMinutes: _trustWindowMinutes,
    standingGrantsVoidBefore: _standingGrantsVoidBefore,
    ...rest
  } = stored as Record<string, unknown>;
  if (Object.keys(rest).length === 0) store.delete('approvals');
  else store.set('approvals', rest);
}

/**
 * Which permission area each retired `agentContext` switch folds into.
 */
const AGENT_CONTEXT_AREAS = {
  tasksTools: 'tasks',
  relayTools: 'messages',
  meshTools: 'agents',
  adapterTools: 'connections',
} as const satisfies Record<string, PermissionAreaId>;

/**
 * Retire the four `agentContext.*Tools` switches (spec `agent-permissions` D13,
 * phase 3). Each switch a person turned OFF becomes its area Blocked in
 * `permissions.defaults.areas` for everyone, unless that area is already set
 * there (an area a person set through DorkOS wins); then the section is deleted.
 *
 * The switches only ever left tool docs out of Claude Code's context, and the
 * tools stayed callable (ADR 260726-171347, superseded). A Blocked area hides
 * AND refuses them on every runtime, so the fold is faithful to what a person
 * who turned one off meant, and slightly stronger than what they got.
 *
 * Deliberately NOT a `CONFIG_MIGRATIONS` body, on the precedent of
 * {@link retireStandingGrantSettings}: a migration runs once per version, so an
 * install that already ran this version's key under an earlier build (a
 * dogfood install always has) would never be folded, and a migration runs
 * before the Activity log exists, so it could not record the change it made.
 * This runs at every boot, from the permission upgrade, acts only while the
 * section is on disk, and returns what it Blocked so the caller can record it.
 * Running it twice is a no-op: the first run removed the section.
 *
 * `agentContext` is a top-level section this build no longer declares, so
 * nothing else ever writes it again; until this runs it is an unknown key,
 * carried across writes like any other.
 *
 * @param store - The config store.
 * @returns The areas it set to Blocked, in a stable order, or `null` when there
 *   was no `agentContext` section to retire.
 */
export function retireAgentContextSettings(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): PermissionAreaId[] | null {
  const stored = store.get('agentContext');
  if (stored === undefined) return null;
  const section =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const off = (Object.keys(AGENT_CONTEXT_AREAS) as (keyof typeof AGENT_CONTEXT_AREAS)[])
    .filter((key) => section[key] === false)
    .map((key) => AGENT_CONTEXT_AREAS[key]);

  const blocked: PermissionAreaId[] = [];
  if (off.length > 0) {
    const permissions = store.get('permissions');
    const current =
      permissions && typeof permissions === 'object' && !Array.isArray(permissions)
        ? (permissions as Record<string, unknown>)
        : { preset: null, defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null };
    const defaults =
      current.defaults && typeof current.defaults === 'object' && !Array.isArray(current.defaults)
        ? (current.defaults as Record<string, unknown>)
        : { areas: {}, actions: {} };
    const areas: Record<string, unknown> = {
      ...((defaults.areas as Record<string, unknown> | undefined) ?? {}),
    };
    for (const area of off) {
      if (Object.hasOwn(areas, area)) continue;
      areas[area] = 'blocked';
      blocked.push(area);
    }
    if (blocked.length > 0) {
      store.set('permissions', {
        ...current,
        defaults: { actions: {}, ...defaults, areas },
      });
    }
  }
  store.delete('agentContext');
  return blocked;
}

const jsonSchemaFull = z.toJSONSchema(UserConfigSchema, {
  target: 'jsonSchema2019-09',
  // Two tolerances, composed. `z.toJSONSchema` takes ONE override, so a second
  // one added later must join this function rather than replace the argument —
  // silently dropping the other is a whole config file condemned.
  override: (ctx) => {
    tolerateRetiredSidebarKeys(ctx, {
      collapseKeys: Object.keys(RETIRED_SIDEBAR_COLLAPSE_KEYS),
      legacyMembersKey: LEGACY_MEMBERS_KEY,
    });
    tolerateLegacyClaudeAccountEncoding(ctx);
  },
}) as { properties?: Record<string, unknown> };

// A key this build does not declare is another build's key, not damage. Zod
// closes every object it generates, and conf validates on every read, so one
// such key made the whole file unloadable and cost a person their settings.
// See `config/version-skew.ts` — this call is what keeps an unrecognized-key
// violation from ever reaching the recovery path below.
tolerateUnknownKeys(jsonSchemaFull);

// The retired `runtimes.dorkosTools`, DECLARED. It runs after the generation
// above rather than inside its `override` because `runtimes` is an inline object
// with no schema symbol to match on; see the function for why that is the
// smaller change.
tolerateRetiredRuntimeKeys(jsonSchemaFull);

// And the retired `rooms.toolOnlyReplies`, for the same reason and by the same
// route. Two calls rather than one call doing both: they name two sections, and
// a miss on either is a husk that never leaves.
tolerateRetiredRoomKeys(jsonSchemaFull);

// And the retired power-door and autonomy-acknowledgement leaves under `ui`.
tolerateRetiredUiKeys(jsonSchemaFull);

/**
 * The per-top-level-key JSON Schema conf validates against, tolerances included.
 *
 * Exported so a test that builds its own `Conf` — the only way to pin a
 * `projectVersion` and exercise one migration boundary — validates against the
 * SAME schema production does. A test that rebuilt it from `UserConfigSchema`
 * would silently drop every `override` above, and then fail on a config shape
 * the shipped code accepts. That has already happened once.
 *
 * @internal Exported for testing only.
 */
export const CONF_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFull.properties ?? {};

/**
 * The named scalar leaves Ajv no longer checks, so Zod can check them inside
 * DorkOS instead.
 *
 * A value a NEWER build wrote under a setting it widened is skew, not damage,
 * and condemning the file over it costs everything else the person configured.
 * See `config/widened-leaves.ts` — this call is what keeps such a value from
 * ever reaching the recovery path below, and what it returns is the exact list
 * of leaves {@link ConfigManager} may fall back to a default on.
 *
 * @internal Exported for testing only.
 */
export const WIDENED_LEAF_POLICY: WidenedLeafPolicy = relaxWidenedLeaves(CONF_JSON_SCHEMA);

// Cast the runtime JSON schema to conf's Schema type. The Zod-generated schema
// is structurally compatible at runtime but TypeScript cannot verify it statically.
const confSchema = CONF_JSON_SCHEMA as unknown as Schema<UserConfig>;

/** Construction-time overrides for {@link ConfigManager}. */
export interface ConfigManagerOptions {
  /**
   * Backoff between attempts when a load or a salvage read fails for a reason
   * that is not the file's fault. Defaults to
   * {@link CONFIG_LOAD_RETRY_DELAYS_MS}; its LENGTH is the retry count.
   *
   * Exists for the tests, and earns its place there. Proving that a config
   * survives a storm takes dozens of constructions that each exhaust the
   * staircase, and `sleepSync` parks the worker thread for real: at the shipped
   * delays that suite held a vitest worker for around thirty seconds and made
   * timing-sensitive tests in other files flake. Shortening the delays keeps
   * every attempt, and the attempt count is what those tests are about. One
   * test deliberately uses the default schedule so the shipped path is still
   * exercised end to end.
   */
  retryDelaysMs?: readonly number[];
}

/**
 * Manages persistent user configuration at ~/.dork/config.json.
 *
 * Uses `conf` for atomic JSON I/O with Ajv validation via the JSON Schema
 * generated from UserConfigSchema. Handles first-run detection, corrupt
 * config recovery (backup + recreate), and sensitive field warnings.
 *
 * Construction throws {@link ConfigUnreadableError} when the operating system
 * would not let DorkOS read the file. That is the loud half of the guarantee in
 * {@link classifyConfigLoadFailure}: the file is neither replaced nor deleted,
 * and a restart picks it up. Every other failure recovers rather than
 * throwing.
 *
 * The class is exported alongside the {@link configManager} singleton for one
 * reason: a SECOND manager over the same directory is the faithful stand-in for
 * `dorkos config set`, which is a different process holding its own manager over
 * the same file. Tests that need to reproduce an out-of-process write build one
 * here rather than re-running {@link initConfigManager}, which would replace the
 * singleton and read like a restart — the very thing those tests must not
 * simulate. Production code uses the singleton.
 */
/**
 * What a settings write tells its subscribers.
 *
 * Only the sections, never the values: a listener that cares reads the value it
 * cares about back off the manager, which keeps this event from going stale
 * between the write and the read, and keeps a credential out of an event object
 * that anything may subscribe to.
 */
export interface ConfigChange {
  /** Top-level sections this write touched, e.g. `['runtimes']`. */
  sections: readonly string[];
  /**
   * The exact key paths this write stored, e.g. `['runtimes.default']` for a
   * dot-path write, `['ui']` for a whole section. A subscriber that must tell
   * one field inside a section from the rest of it — the settings broadcast
   * leaving remembered Community navigation out, for one — reads this; every
   * other subscriber keeps to `sections`.
   */
  paths: readonly string[];
}

/** Called after a settings write lands. See {@link ConfigManager.onChange}. */
export type ConfigChangeListener = (change: ConfigChange) => void;

/**
 * Reads and writes the persistent user settings at `~/.dork/config.json`.
 *
 * The `conf`-backed store is the durable half; {@link UserConfigSchema} is the
 * authoritative shape, and every schema change ships a semver-keyed migration
 * (see `contributing/configuration.md`). Writes notify
 * {@link ConfigChangeListener}s with the sections they touched.
 */
export class ConfigManager {
  private store: Conf<UserConfig>;
  private _isFirstRun = false;
  /** Whether {@link ConfigManager.canonicalSidebar} has already had its one look. */
  private sidebarConverted = false;
  private listeners = new Set<ConfigChangeListener>();

  /**
   * Open the config store, recovering or refusing per the rules above.
   *
   * @param dorkHome - The DorkOS data directory holding `config.json`.
   * @param options - Overrides for the retry policy. Production passes none.
   */
  constructor(dorkHome: string, options: ConfigManagerOptions = {}) {
    const retryDelaysMs = options.retryDelaysMs ?? CONFIG_LOAD_RETRY_DELAYS_MS;
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

    // Only a failure the file itself caused reaches the recovery branch. An
    // errno failure — a busy file, a machine out of file descriptors, a
    // permission that changed — is retried and then reported by
    // `loadConfigStore`, with the file untouched, however long it lasts. See
    // {@link classifyConfigLoadFailure}.
    const opened = loadConfigStore(confOptions, configPath, retryDelaysMs);
    if ('store' in opened) {
      this.store = opened.store;
      logger.info(`[Config] Loaded from ${configPath} (first run: ${this._isFirstRun})`);
    } else {
      // The actual reason, logged before anything is moved. Without it, the
      // only record of WHY a config was replaced was the fact that it had been.
      logger.warn(
        `[Config] ${configPath} could not be used: ${describeLoadError(opened.corruptedBy)}`
      );
      // Read the doomed file BEFORE deleting it. The common failure is a file
      // that parses as JSON but holds a shape the schema does not describe (a
      // skipped rename, a hand edit), so the person's privacy and
      // permission choices are sitting right there, perfectly readable, in the
      // file we are about to replace. Losing state must not lose a protection.
      let stored: unknown;
      let backupPath: string | undefined;
      if (fs.existsSync(configPath)) {
        const salvage = readStoredConfigForSalvage(configPath, retryDelaysMs);
        if (!salvage.read) {
          // NOTHING GETS REPLACED THAT COULD NOT BE READ. This is the general
          // guarantee behind the errno classification, and it holds even when
          // the classifier was fooled: a failure that looked deterministic but
          // is really a machine in trouble shows up again here, because the
          // machine is still in trouble. Replacing now would destroy a file we
          // have no evidence against and cannot salvage a single protection
          // from.
          logger.error(
            `[Config] Refusing to replace ${configPath}: it could not be read`,
            logError(salvage.error)
          );
          throw new ConfigUnreadableError(configPath, salvage.error);
        }
        stored = salvage.value;
        try {
          // Timestamped and rotated, never one fixed `.bak`: the backup holds
          // the person's settings, and a second recovery used to overwrite the
          // first one's copy. See `config/backups.ts`.
          backupPath = backupConfigFile(configPath);
          fs.unlinkSync(configPath);
        } catch (error) {
          // Same rule, one step later: if the backup or the removal is
          // refused, stop rather than half-replace. The original is still
          // where the person left it, so the plain message is the true one.
          logger.error(`[Config] Could not replace ${configPath}`, logError(error));
          throw new ConfigUnreadableError(configPath, error);
        }
        logger.warn(`Corrupt config backed up to ${backupPath}`);
        logger.warn('Creating fresh config with defaults.');
      }
      // Reuse the exact same options so the recovered store still has the
      // migration chain wired up. `backupPath` only changes what a failure
      // here SAYS: the original is gone by now, so the message has to send the
      // person to the backup rather than to a path that no longer holds their
      // settings.
      const recovered = loadConfigStore(confOptions, configPath, retryDelaysMs, backupPath);
      if (!('store' in recovered)) {
        // Defaults that `conf` itself condemns are a defect in the defaults,
        // not in anything the person did, and there is nothing further to
        // recover to. Wrapped rather than rethrown bare: both callers of the
        // constructor print a `ConfigUnreadableError` and swallow its stack,
        // and rethrow anything else. A bare error here would reach the person
        // as the uncaught stack trace that wrapping exists to prevent.
        logger.error(`[Config] Could not create a fresh config`, logError(recovered.corruptedBy));
        throw new ConfigUnreadableError(configPath, recovered.corruptedBy, backupPath);
      }
      this.store = recovered.store;
      restoreProtectedState(this.store, stored, 'Recovered a damaged config');
    }
    this.announceUnreadableSettings();
  }

  /**
   * Bring a `ui.sidebar` written before DOR-579 into the shape this build
   * stores — once, the first time anything reads `ui`.
   *
   * ## The case this exists for
   *
   * `migrateSidebarMembersToItemRefs` (the `0.59.0` body) moved almost
   * everybody, and `conf` runs a migration key only when it lands in
   * `(storedVersion, projectVersion]` — so it never runs at all in a tree whose
   * version resolves to `0.0.0`, which is every `pnpm dev`, and it is skipped
   * for anyone whose stored version has already passed it. For an additive
   * backfill that is harmless. For a RENAME it is not, and the dangerous shape
   * is the one that looks fine: a config whose `pinned` and `muted` are already
   * references and whose only old part is `groups[].agentPaths`. That key is
   * declared to Ajv (see `tolerateRetiredSidebarKeys`) so it survives the read,
   * but nothing else knows it — the section loads with no members and is written
   * back that way by the next config change of any kind. Nobody sees a warning;
   * a person just finds the sections they built are empty.
   *
   * ## Why on first read, and not at boot
   *
   * At boot it would cost a read of a file the operating system may be refusing,
   * on a machine already in trouble, for work that can wait — and this class
   * promises that a boot it cannot complete leaves the settings exactly where
   * they are. Here it costs nothing: the caller is already reading `ui`, this
   * inspects the object they were handed, and the latch asks the question once
   * per process rather than once per read. That last part is what separates it
   * from the read-time conversion DOR-588 removed, which scanned three lists on
   * every read for ever to answer "no".
   *
   * The write-through is best effort: a conversion that could not be persisted
   * still returns the right value to this caller, and the next boot tries again.
   *
   * @param ui - The stored `ui` section, as `conf` handed it over.
   */
  private canonicalSidebar(ui: UserConfig['ui']): UserConfig['ui'] {
    if (this.sidebarConverted) return ui;
    this.sidebarConverted = true;
    const sidebar = ui?.sidebar;
    if (!sidebar) return ui;
    const groups: unknown = sidebar.groups;
    const legacy = (group: unknown): group is Record<string, unknown> =>
      group !== null && typeof group === 'object' && LEGACY_MEMBERS_KEY in group;
    /** A membership list still holding bare agent paths. */
    const bare = (list: unknown): list is unknown[] =>
      Array.isArray(list) && list.some((entry) => typeof entry === 'string');

    const staleGroups = Array.isArray(groups) ? groups.filter(legacy).length : 0;
    if (staleGroups === 0 && !bare(sidebar.pinned) && !bare(sidebar.muted)) return ui;

    const converted = (Array.isArray(groups) ? groups : []).map((group) => {
      if (!legacy(group)) return group;
      const { [LEGACY_MEMBERS_KEY]: retired, ...rest } = group;
      // An `items` that already holds something wins: only a file written before
      // DOR-579 carries the retired key, so the two can never hold different
      // truths, and preferring `items` keeps this from resurrecting a list the
      // person has since edited.
      const source = Array.isArray(rest.items) && rest.items.length > 0 ? rest.items : retired;
      return {
        ...rest,
        items: (Array.isArray(source) ? source : []).map((entry) =>
          toSidebarItemRef(entry as SidebarItemRef | string)
        ),
      };
    });

    /** One stored list, every bare path wrapped. */
    const refs = (list: unknown) =>
      Array.isArray(list)
        ? list.map((entry) => toSidebarItemRef(entry as SidebarItemRef | string))
        : list;

    const next = {
      ...ui,
      sidebar: {
        ...sidebar,
        pinned: refs(sidebar.pinned),
        muted: refs(sidebar.muted),
        groups: converted,
      },
    } as unknown as UserConfig['ui'];
    logger.warn(
      `[Config] Converted a pre-0.59 sidebar in ${this.store.path}: ` +
        `pins, mutes and ${staleGroups} section(s) now store their members as item references`
    );
    try {
      this.store.set('ui', next);
    } catch (error) {
      // Never the reason a read fails. Every failure this class raises is a
      // `ConfigBootError`, and a raw errno escaping from a tidy-up would reach
      // the person as the stack trace that contract exists to prevent. The value
      // returned below is already correct for this caller.
      logger.warn(`[Config] Could not persist the converted sidebar`, logError(error));
    }
    return next;
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /**
   * Every setting whose stored value this build cannot interpret, read fresh.
   *
   * See `config/widened-leaves.ts`. Recomputed rather than cached because
   * `dorkos config set` in another process can change the answer under a running
   * server, and a stale "all clear" is the wrong way for this to be wrong.
   */
  unreadableSettings(): readonly WidenedLeaf[] {
    return findUnreadableLeaves(this.store.store, WIDENED_LEAF_POLICY);
  }

  /**
   * Say once, at boot, which settings this build is running past.
   *
   * ## Why silence was not an option
   *
   * Falling back to a default is the right behaviour and the wrong secret. The
   * relaxed set includes leaves that decide things: `auth.enabled`,
   * `mcp.enabled`, `telemetry.usage`. Before this feature a file holding a value one of those
   * could not take was condemned LOUDLY — "could not be used", a rotated backup,
   * a line the operator saw. Tolerating it quietly would turn that into a login
   * gate silently off, or a bound somebody tightened silently back at its
   * default, with nothing anywhere to say so (`.claude/rules/safe-defaults.md`,
   * rule 2). The skew is not damage, but it is news.
   *
   * Once per boot, not per read: `get` runs the same repair on every call, and a
   * warning per config read would bury the one that matters. `dorkos doctor` and
   * `dorkos config validate` ask {@link ConfigManager.unreadableSettings} for the
   * same list on demand.
   */
  private announceUnreadableSettings(): void {
    const warning = unreadableSettingsWarning(this.unreadableSettings(), this.store.path);
    if (warning) logger.warn(warning);
  }

  /**
   * The section this build can actually run on.
   *
   * A leaf whose stored value a NEWER build widened is no longer refused by Ajv
   * (`config/widened-leaves.ts`), so it arrives here intact and meaningless —
   * `ui.theme: 'midnight'` on a build with three themes. Zod is what still
   * checks those leaves, and this is where it runs: the unreadable leaf falls
   * back to its own schema default and everything else is untouched.
   *
   * Returns its input by reference when nothing needed repairing, which is every
   * boot that is not straddling two builds.
   *
   * @param key - The top-level section name.
   * @param value - The section as `conf` handed it over.
   */
  private readable<K extends keyof UserConfig>(key: K, value: UserConfig[K]): UserConfig[K] {
    const repaired = repairWidenedLeaves(key as string, value, WIDENED_LEAF_POLICY).value;
    return hubPinnedRead(key as string, repaired) as UserConfig[K];
  }

  /** Get a top-level config section */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    const stored = this.store.get(key);
    // `ui` is the only section that can still carry the pre-DOR-579 encoding,
    // and the conversion asks once per process rather than once per read.
    const value =
      key === 'ui' ? (this.canonicalSidebar(stored as UserConfig['ui']) as UserConfig[K]) : stored;
    return this.readable(key, value);
  }

  /**
   * Get a nested value via dot-path (e.g., 'server.port').
   *
   * Reads the store verbatim in one respect: a dot-path INTO `ui.sidebar` on a
   * config that predates DOR-579 reports the stored encoding rather than the
   * canonical one, and nothing derives behaviour from that.
   *
   * It does NOT report a leaf whose value belongs to a newer build. The CLI
   * decides real things through this accessor — `server.port`, `logging.level`,
   * `tunnel.enabled` — so handing back a value this build cannot interpret would
   * put the CLI and the server on different settings from the same file. What
   * comes back is what DorkOS is running on, which is also the honest answer to
   * `dorkos config get`; the file itself is one `dorkos config path` away.
   *
   * `conf` still does the lookup, so `dot-prop`'s escaping (`a.b\.c` for a key
   * with a literal dot in it) keeps working exactly as before. The repair is
   * applied to what came back rather than by re-walking the path here — an
   * escaped dot can only address a RECORD key, and records hold no relaxed
   * leaves, so such a read simply matches nothing and passes straight through.
   */
  getDot(key: string): unknown {
    const stored = this.store.get(key as keyof UserConfig);
    return hubPinnedRead(key, repairWidenedLeaves(key, stored, WIDENED_LEAF_POLICY).value);
  }

  /** Set a top-level config section */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    this.write(key, value);
    this.emitChange([key as string], [key as string]);
  }

  /**
   * Write one path, keeping any settings underneath it that belong to another
   * build of DorkOS.
   *
   * Every write here arrives having been through Zod, which strips what this
   * build does not declare. Left alone, an older build saving a theme would
   * delete a newer build's settings from the file one section at a time — the
   * same loss as a wipe, just quieter. So the keys the schema does not know
   * about are carried across from what is already on disk.
   *
   * The same is true one level down, of a leaf whose stored VALUE belongs to
   * another build. This build read it as its schema default, so the value it is
   * about to write back IS that default, and the person's real choice would go
   * with the write. So a leaf whose written value is exactly what this build
   * handed out is carried across too — the test is equality, not absence; see
   * {@link preserveWidenedLeaves} for what that does and does not cover.
   *
   * See `config/version-skew.ts` and `config/widened-leaves.ts` for what does
   * and does not get carried.
   *
   * @param keyPath - A top-level section, or a dot-path into one.
   * @param value - The value to store.
   */
  private write(keyPath: string, value: unknown): void {
    const browserRefusal = browserSettingRefusal(keyPath, value);
    if (browserRefusal) throw new Error(browserRefusal);
    const hubRefusal = hubSettingRefusal(keyPath, value);
    if (hubRefusal) throw new Error(hubRefusal);
    const stored = this.store.get(keyPath as keyof UserConfig);
    const { skewed } = repairWidenedLeaves(keyPath, stored, WIDENED_LEAF_POLICY);
    const kept = preserveWidenedLeaves(skewed, keyPath, value);
    const node = schemaNodeAt(CONF_JSON_SCHEMA, keyPath);
    const merged = preserveUnknownKeys(node, stored, kept);
    this.store.set(keyPath as keyof UserConfig, merged as UserConfig[keyof UserConfig]);
  }

  /**
   * Subscribe to settings changes made through this manager.
   *
   * ## Why this exists
   *
   * Most settings are read at use, so a change simply applies to the next thing
   * that reads them. A few are APPLIED once — `runtimes.default` is set on the
   * registry at boot and never re-read — and shipping a Settings screen over a
   * field like that is a quiet lie: the person changes it, the screen agrees,
   * and nothing happens until they restart. This is the seam that lets the
   * applied ones re-apply (spec `execution-defaults` §3.2).
   *
   * ## What it does and does not see
   *
   * It fires on every write **this process** makes: `PATCH /api/config` (via
   * `applyConfigPatch`), the `config_patch` operator tool, and every internal
   * `set`/`setDot`/`reset` caller — including a write that changes nothing,
   * since it reports the sections a write TOUCHED rather than diffing them.
   * Subscribers are therefore expected to be idempotent, which the one that
   * exists is: re-applying the same default runtime is a no-op and says nothing.
   *
   * It does NOT see `dorkos config set` run in a terminal, or somebody editing
   * `~/.dork/config.json` by hand while the server runs — those still take effect
   * at the next restart, exactly as today.
   *
   * That boundary was chosen over conf's own file watcher (`watch: true`), which
   * would cover the out-of-process cases too. Three reasons not to: conf's
   * `onDidChange` is unreachable from outside this class (the store is private,
   * and exposing it hands every caller the unvalidated store), a live `fs.watch`
   * on the config file is a handle held by every `ConfigManager` a test
   * constructs, and the case this feature was actually asked for — a person
   * changing a setting in the cockpit and expecting it to hold — is in-process
   * by construction. If out-of-process live-apply is ever the complaint, the
   * upgrade is `watch: true` plus an internal `onDidChange` bridge into this same
   * emitter; nothing above this line changes.
   *
   * Listener errors are caught and logged: a subscriber that throws must not
   * turn somebody's settings write into a 500 after the value has been persisted.
   *
   * @param listener - Called after a write lands, with the sections it touched.
   * @returns An unsubscribe function.
   */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Notify subscribers that the named sections, at the named key paths, were just written. */
  private emitChange(sections: string[], paths: string[]): void {
    if (this.listeners.size === 0) return;
    const change: ConfigChange = { sections, paths };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        logger.warn('[Config] a change listener threw; the write itself is unaffected', { err });
      }
    }
  }

  /** Set a nested value via dot-path. Returns warning if key is sensitive. */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    this.write(key, value);
    // Subscribers speak in top-level sections, so a dot-path reports the section
    // it wrote into: `runtimes.default` and `runtimes` are the same news.
    this.emitChange([key.split('.')[0]!], [key]);
    return result;
  }

  /** Get the full config object. */
  getAll(): UserConfig {
    const stored = this.store.store;
    const ui = this.canonicalSidebar(stored.ui);
    const canonical = ui === stored.ui ? stored : { ...stored, ui };
    let repaired: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(canonical)) {
      const readable = hubPinnedRead(
        key,
        repairWidenedLeaves(key, value, WIDENED_LEAF_POLICY).value
      );
      if (readable === value) continue;
      repaired ??= { ...canonical };
      repaired[key] = readable;
    }
    return (repaired ?? canonical) as UserConfig;
  }

  /**
   * Reset a specific key, or every key, to defaults.
   *
   * A whole-config reset keeps the settings a person moved to the protective
   * side — their telemetry answer, a login gate they switched on, a bound they
   * tightened (see `safe-defaults/protected-state.ts`). "Reset my preferences" is not
   * consent to start sharing again, and this is the verb the operator's own
   * phrasing was about: the safe option has to win *in case things get reset*.
   *
   * Resetting one key is the escape hatch and stays literal: `reset('telemetry')`
   * really does put the telemetry block back to its defaults, because naming the
   * section IS the explicit act that the blanket reset lacks.
   *
   * Reset is also the one write that does NOT carry another build's keys across
   * ({@link ConfigManager.write}), for the same reason: "put this back to the
   * defaults" is an instruction, not an accident, and a build that owns those
   * keys writes them again the next time it starts.
   *
   * @param key - The top-level section to reset, or omitted for all of them.
   */
  reset(key?: string): void {
    if (key) {
      this.store.reset(key as keyof UserConfig);
    } else {
      const stored = this.store.store;
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
      restoreProtectedState(this.store, stored, 'Reset your config');
    }
    // A whole-config reset is news about every section, so subscribers that
    // applied something once get to apply it again.
    const sections = key ? [key] : Object.keys(this.store.store);
    this.emitChange(sections, sections);
  }

  /**
   * Remove the retired standing-permission settings, once boot has captured the
   * grants they licensed. See {@link retireStandingGrantSettings}.
   */
  retireStandingGrantSettings(): void {
    retireStandingGrantSettings(
      this.store as unknown as Parameters<typeof retireStandingGrantSettings>[0]
    );
  }

  /**
   * Fold the retired `agentContext` switches into the permission defaults and
   * remove them. See {@link retireAgentContextSettings}.
   *
   * @returns The areas it set to Blocked, or `null` when nothing was left to retire.
   */
  retireAgentContext(): PermissionAreaId[] | null {
    return retireAgentContextSettings(
      this.store as unknown as Parameters<typeof retireAgentContextSettings>[0]
    );
  }

  /**
   * Validate the current config against the Zod schema.
   *
   * Asks about the config DorkOS is RUNNING on, not the bytes on disk, which is
   * the difference that matters once a newer build has widened a setting. The
   * file may hold `ui.theme: 'midnight'`; this build reads that as `system`,
   * starts normally, and keeps everything else. Calling that a validation
   * failure would send somebody to delete the very file this exists to keep —
   * `dorkos config validate` exits non-zero and prints "validation failed",
   * which reads as "your settings are broken".
   *
   * It is still not silent about them. A widened value comes back in `warnings`,
   * named, so the command keeps its point for the case it was written for: a
   * hand edit that put a value somewhere DorkOS will not use.
   */
  validate(): { valid: boolean; errors?: string[]; warnings?: string[] } {
    const unreadable = this.unreadableSettings();
    const warnings = unreadable.length === 0 ? undefined : unreadable.map(describeWidenedLeaf);
    try {
      UserConfigSchema.parse(this.getAll());
      return warnings ? { valid: true, warnings } : { valid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          valid: false,
          errors: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
          ...(warnings ? { warnings } : {}),
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
