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
  ONBOARDING_STEPS,
  SidebarItemRefSchema,
  SidebarGroupSchema,
  toSidebarItemRef,
  normalizeSidebarPrefs,
} from '@dorkos/shared/config-schema';
import type { UserConfig, SidebarItemRef } from '@dorkos/shared/config-schema';
import { logger } from '../../lib/logger.js';
import { SERVER_VERSION } from '../../lib/version.js';
import { latestInstant, restoreProtectedState } from './safe-defaults/protected-state.js';

/**
 * Read a config file that `conf` just refused, so its protections can be
 * salvaged before the file is replaced.
 *
 * Best-effort by design and never throws. A file that fails schema validation
 * usually still parses as JSON — that is the whole reason salvage is possible —
 * but a genuinely truncated file does not, and the caller is already handling a
 * failure. An unreadable file simply yields `undefined` and the recovery
 * proceeds on defaults, exactly as it did before.
 *
 * @param configPath - Absolute path to the config file being replaced.
 * @returns The parsed contents, or `undefined` when they cannot be read.
 */
function readStoredConfigForSalvage(configPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

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
 * Migration body: backfill `extensions.approvedToRun: []` for configs persisted
 * before extension code needed a person's approval to run in-process (DOR-516).
 *
 * Seeds the list EMPTY, which means nothing an upgrading user already had
 * installed is pre-approved. That is the deliberate choice, and it is the one
 * place this migration could have gone wrong: backfilling from
 * `extensions.enabled` would read "the person once toggled this on in the
 * cockpit" as "the person reviewed this code", and an agent can turn an extension
 * on through an ungated route. An upgrade must never hand out an approval nobody
 * gave. The cost is that anyone already running a user extension with a server
 * entry approves it once, which is one click and is stated in the changelog.
 *
 * Core extensions are unaffected either way — they are exempt by origin, not by
 * this list (see `extension-load-policy.ts`), so the shipped `linear-issues`
 * data proxy keeps working across the upgrade with nothing to click.
 *
 * Additive and idempotent — only writes when `approvedToRun` is not already an
 * array, and never touches `enabled` or `disabled`. Configs with no `extensions`
 * key are skipped (the schema default supplies the object on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillExtensionsApprovedToRun(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (
    ext &&
    typeof ext === 'object' &&
    !Array.isArray((ext as { approvedToRun?: unknown }).approvedToRun)
  ) {
    store.set('extensions', { ...(ext as Record<string, unknown>), approvedToRun: [] });
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
 * Migration body: backfill `harness.approvedHooks: []` for configs persisted
 * before an installed package needed a person's approval to write shell commands
 * into a coding agent's hook files (DOR-522).
 *
 * Seeds the list EMPTY, exactly as {@link backfillExtensionsApprovedToRun} does
 * and for the same reason: an upgrade must never hand out an approval nobody
 * gave. Anyone already running a hook-shipping plugin is asked once, on the next
 * install into that project, and the commands land the moment they say yes.
 *
 * Additive and idempotent — only writes when `approvedHooks` is not already an
 * array, and never touches `autoSync`. Configs with no `harness` key are skipped
 * (the schema default supplies the object on read, and
 * {@link backfillHarnessDefaults} seeds the section itself).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillHarnessApprovedHooks(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const harness = store.get('harness');
  if (
    harness &&
    typeof harness === 'object' &&
    !Array.isArray((harness as { approvedHooks?: unknown }).approvedHooks)
  ) {
    store.set('harness', { ...(harness as Record<string, unknown>), approvedHooks: [] });
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

/**
 * Migration body: backfill the `approvals` section (standing permissions,
 * DOR-501) for configs persisted before it existed. Additive + idempotent: only
 * writes when the key is absent, and the schema default yields the same shape on
 * read, so this just writes the key through on the upgrade where it lands.
 *
 * Seeds `standingGrants: false`. A safety feature does not get quietly relaxed
 * by an upgrade — nothing changes for an existing user until they ask for it.
 *
 * Also seeds `standingGrantsVoidBefore: null` (DOR-520) onto an `approvals` block
 * an earlier build of this same unreleased key already created, which is why the
 * two seeds are separate `if`s rather than one. `null` means "nothing has been
 * voided yet", which is the honest starting point: no upgrade should retroactively
 * end permissions the person still expects to hold.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillApprovalsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const approvals = store.get('approvals');
  if (approvals == null) {
    store.set('approvals', {
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    return;
  }
  const section = approvals as Record<string, unknown>;
  if (!('standingGrantsVoidBefore' in section)) {
    store.set('approvals', { ...section, standingGrantsVoidBefore: null });
  }
}

/**
 * Migration body: remove the tunnel passcode fields (`tunnel.passcodeEnabled`,
 * `tunnel.passcodeHash`, `tunnel.passcodeSalt`) and the root `sessionSecret`
 * from stored configs. The tunnel passcode auth path and the cookie-session
 * signing secret were removed in the accounts-and-auth spec — Better Auth is the
 * one auth path and manages its own session signing. Existing passcode hashes
 * are discarded, not migrated. Idempotent: only rewrites `tunnel` when a stale
 * passcode key is present, and only deletes `sessionSecret` when it exists.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`/`delete`).
 */
export function dropTunnelPasscodeAndSessionSecret(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const tunnel = store.get('tunnel');
  if (tunnel && typeof tunnel === 'object') {
    const t = tunnel as Record<string, unknown>;
    if ('passcodeEnabled' in t || 'passcodeHash' in t || 'passcodeSalt' in t) {
      const {
        passcodeEnabled: _passcodeEnabled,
        passcodeHash: _passcodeHash,
        passcodeSalt: _passcodeSalt,
        ...rest
      } = t;
      store.set('tunnel', rest);
    }
  }
  if (store.get('sessionSecret') !== undefined) {
    store.delete('sessionSecret');
  }
}

/**
 * Migration body: backfill the `cloud` section (device-link instance token,
 * accounts-and-auth P2, task 2.4) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema default
 * also yields `{ instanceToken: null, instanceName: null, linkedAccountLabel:
 * null }` on read, so this just writes the key through on the upgrade where it
 * lands. A fresh install is never linked (all three fields `null`).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillCloudDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('cloud') == null) {
    store.set('cloud', { instanceToken: null, instanceName: null, linkedAccountLabel: null });
  }
}

/**
 * Migration body: backfill the `workbench` section (right-panel workbench
 * viewer registry overrides, DOR-219) for configs persisted before it existed.
 * Additive + idempotent: only writes when the key is absent; the schema default
 * also yields `{ defaultViewers: {} }` on read, so this just writes the key
 * through on the upgrade where it lands. A fresh install has no overrides.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('workbench') == null) {
    store.set('workbench', { defaultViewers: {} });
  }
}

/**
 * Migration body: backfill the credential substrate (CredentialProvider port,
 * effortless-runtime-switching T1, ADR-0315) for configs persisted before it
 * existed. Two additive, idempotent steps:
 *
 * 1. Add the top-level `providers` registry (`{}`) when absent — the shallow
 *    conf defaults-merge already yields it on read, so this just writes the key
 *    through on the upgrade where it lands.
 * 2. Backfill the new per-runtime credential fields onto an EXISTING `runtimes`
 *    block (`codex.credentialRef`, `opencode.provider`, `opencode.baseURL`).
 *    conf merges top-level defaults SHALLOWLY, so a `runtimes` object already on
 *    disk never inherits new nested defaults — this step supplies them. Only
 *    writes the fields that are missing; never overwrites a set value and never
 *    touches the whole-object-absent case (handled by the schema default on
 *    read + the `runtimes` backfill).
 *
 * Never writes a secret: the new fields are seeded to `null` (delegate/host
 * auth), never a plaintext key.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillProvidersDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('providers') == null) {
    store.set('providers', {});
  }

  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const r = runtimes as Record<string, unknown>;
  let changed = false;

  const codex = r.codex;
  if (codex && typeof codex === 'object' && !('credentialRef' in codex)) {
    r.codex = { ...(codex as Record<string, unknown>), credentialRef: null };
    changed = true;
  }

  const opencode = r.opencode;
  if (opencode && typeof opencode === 'object') {
    const o = opencode as Record<string, unknown>;
    if (!('provider' in o) || !('baseURL' in o)) {
      r.opencode = {
        ...o,
        ...(!('provider' in o) ? { provider: null } : {}),
        ...(!('baseURL' in o) ? { baseURL: null } : {}),
      };
      changed = true;
    }
  }

  if (changed) store.set('runtimes', r);
}

/**
 * Migration body: backfill `workbench.terminalGraceTtlMinutes` (embedded-terminal
 * re-attach grace window, DOR-225) onto an EXISTING `workbench` block. conf merges
 * top-level defaults SHALLOWLY, so a `workbench` object already on disk never
 * inherits the new nested default — this step supplies it. Additive + idempotent:
 * only writes when the field is absent, never overwrites a set value. The
 * whole-object-absent case is handled by {@link backfillWorkbenchDefaults} (which
 * runs first) plus the schema default on read. Defaults to 10 minutes, matching
 * the schema and the terminal manager's prior hardcoded grace period.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchTerminalGraceTtl(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const workbench = store.get('workbench');
  if (workbench && typeof workbench === 'object' && !('terminalGraceTtlMinutes' in workbench)) {
    store.set('workbench', {
      ...(workbench as Record<string, unknown>),
      terminalGraceTtlMinutes: 10,
    });
  }
}

/**
 * Migration body: generalize the `telemetry` section into the shared opt-in
 * consent namespace (DOR-293, ADR 260711-141639). Two additive, idempotent
 * steps on an EXISTING `telemetry` block:
 *
 * 1. Rename `telemetry.enabled` → `telemetry.install` (the marketplace-install
 *    channel), preserving the user's prior choice exactly. Only runs when the
 *    legacy `enabled` key is present and `install` is not, then deletes
 *    `enabled` so the block matches the new schema.
 * 2. Backfill the two new peer channel flags — `heartbeat` and
 *    `errorReporting` — to `false` when absent. conf merges top-level defaults
 *    SHALLOWLY, so a `telemetry` object already on disk never inherits these
 *    nested defaults; this step supplies them without touching consent.
 *
 * Never flips a user from opted-out to opted-in: the new channels default OFF
 * and `userHasDecided` is left untouched, so a user who already answered the
 * marketplace consent is not re-prompted but is also not silently enrolled in
 * the heartbeat. The whole-object-absent case is handled by the schema default
 * on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`/`delete`).
 */
export function generalizeTelemetryConsent(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  let changed = false;

  if ('enabled' in t && !('install' in t)) {
    t.install = t.enabled;
    delete t.enabled;
    changed = true;
  }
  if (!('heartbeat' in t)) {
    t.heartbeat = false;
    changed = true;
  }
  if (!('errorReporting' in t)) {
    t.errorReporting = false;
    changed = true;
  }

  if (changed) store.set('telemetry', t);
}

/**
 * Migration body: backfill `workbench.autoOpenDiff` (auto-open the diff review
 * surface on agent edits, DOR-212) onto an EXISTING `workbench` block. conf merges
 * top-level defaults SHALLOWLY, so a `workbench` object already on disk never
 * inherits the new nested default — this supplies it. Additive + idempotent: only
 * writes when the field is absent, never overwrites a set value. Defaults to
 * `true`, matching the schema.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWorkbenchAutoOpenDiff(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const workbench = store.get('workbench');
  if (workbench && typeof workbench === 'object' && !('autoOpenDiff' in workbench)) {
    store.set('workbench', {
      ...(workbench as Record<string, unknown>),
      autoOpenDiff: true,
    });
  }
}

/**
 * Migration body: backfill `telemetry.lastPromptedVersion` (the consent
 * re-prompt anchor, DOR-312, ADR 260713-143958 Phase 1) onto an EXISTING
 * `telemetry` block. conf merges top-level defaults SHALLOWLY, so a `telemetry`
 * object already on disk never inherits the new nested default — this supplies
 * it. Additive + idempotent: only writes when the field is absent, never
 * overwrites a set value. Seeds `null` (never prompted), which preserves the
 * consent-flip semantics: a never-answered install is not enrolled until a
 * later phase shows the notice. The whole-object-absent case is handled by the
 * schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryLastPromptedVersion(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('lastPromptedVersion' in telemetry)) {
    store.set('telemetry', {
      ...(telemetry as Record<string, unknown>),
      lastPromptedVersion: null,
    });
  }
}

/**
 * Migration body: flip the Tier 1 telemetry channels (`install`, `heartbeat`) to
 * the new opt-out default for never-answered installs (DOR-314, ADR
 * 260713-143958 Phase 2). Operates on an EXISTING `telemetry` block:
 *
 * - If `userHasDecided === true`, the user made an explicit choice (either way) —
 *   change NOTHING, so a prior "no" (or "yes") survives byte-identical.
 * - Otherwise (never answered), set `install = true` and `heartbeat = true`,
 *   enrolling the install in the anonymous opt-out channels. `errorReporting`
 *   (Tier 2, opt-in) and every other field are left untouched.
 *
 * This only flips the config flags; the notice-before-first-send gate
 * (`hasTier1SendGate`, evaluated at boot) still holds back every Tier 1 send
 * until the first-run notice has been shown, so enrollment never means an
 * immediate send. Idempotent: a fully-enrolled never-answered block, and any
 * explicit-choice block, are left as-is. The whole-object-absent case is handled
 * by the schema default on read (which already yields the new `true` defaults).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function applyTier1OptOutDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  // An explicit prior choice is never overridden.
  if (t.userHasDecided === true) return;
  // Idempotent short-circuit: already enrolled, nothing to write.
  if (t.install === true && t.heartbeat === true) return;
  store.set('telemetry', { ...t, install: true, heartbeat: true });
}

/**
 * Migration body: return the Tier 1 telemetry channels (`install`, `heartbeat`,
 * `usage`) to opt-in for every install that never answered a consent prompt
 * (ADR 260727-181825, superseding 260713-143958's Tier 1 posture).
 *
 * The mirror image of {@link applyTier1OptOutDefaults}, which is shipped and
 * therefore frozen — this reverses its effect for the population it enrolled,
 * rather than editing it:
 *
 * - If `userHasDecided === true`, the person made an explicit choice (either
 *   way) — change NOTHING. Someone who chose to keep sharing keeps sharing.
 * - Otherwise (never answered), set all three channels `false`. That includes
 *   installs the 0.48.0 migration enrolled and installs that have since had
 *   their first-run notice shown, which is the point: enrolment by silence is
 *   what this reverses.
 *
 * The consequence is deliberate and is the whole cost of the change: installs
 * that are sending anonymous data today, having never been asked, stop sending
 * it. They are not re-prompted here — `lastPromptedVersion` is untouched, so the
 * cockpit's consent surfaces remain the way back in.
 *
 * Idempotent: an already-opted-out never-answered block, and any
 * explicit-choice block, are left as-is. The whole-object-absent case is handled
 * by the schema default on read, which now yields `false`.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function applyTier1OptInDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry == null || typeof telemetry !== 'object') return;
  const t = telemetry as Record<string, unknown>;
  // An explicit prior choice is never overridden — the same rule the opt-out
  // flip honored, applied in the other direction.
  if (t.userHasDecided === true) return;
  // Idempotent short-circuit: already opted out, nothing to write.
  if (t.install === false && t.heartbeat === false && t.usage === false) return;
  store.set('telemetry', { ...t, install: false, heartbeat: false, usage: false });
}

/**
 * Migration body: backfill `telemetry.usage` (the anonymous feature-usage
 * channel, DOR-315, ADR 260713-143958 Phase 3) onto an EXISTING `telemetry`
 * block. conf merges top-level defaults SHALLOWLY, so a `telemetry` object
 * already on disk never inherits the new nested default — this supplies it.
 *
 * Consent-flip semantics: a user who already answered a telemetry consent
 * prompt (`userHasDecided === true`) answered one that did NOT include this
 * channel, so we must not silently expand their explicit choice — they get
 * `usage: false`. A never-answered install gets the Tier 1 default `true`
 * (still gated by the first-run notice before anything sends). Additive +
 * idempotent: only writes when the field is absent, never overwrites a set
 * value. The whole-object-absent case is handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryUsageChannel(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('usage' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    // An explicit prior "no" (or "yes") to the older channels is never widened:
    // if they decided, the new channel starts OFF; otherwise it takes the Tier 1
    // default ON (notice-gated at send time).
    const userDecided = t.userHasDecided === true;
    store.set('telemetry', { ...t, usage: !userDecided });
  }
}

/**
 * Migration body: backfill `telemetry.linkAnalyticsToAccount` (the device-link
 * analytics merge opt-in, DOR-320, ADR 260713-143958 Phase 4) onto an EXISTING
 * `telemetry` block. conf merges top-level defaults SHALLOWLY, so a `telemetry`
 * object already on disk never inherits the new nested default — this supplies
 * it.
 *
 * This is a Tier 2, explicit-opt-in flag: unlike the Tier 1 usage backfill, it
 * always seeds `false` regardless of `userHasDecided`. The consent for this
 * channel is captured in the account-link flow, never inferred from a prior
 * telemetry choice, so every upgraded install starts OFF and only turns on by an
 * explicit choice at link time. Additive + idempotent: only writes when the
 * field is absent, never overwrites a set value. The whole-object-absent case is
 * handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryLinkAnalyticsToAccount(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('linkAnalyticsToAccount' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    store.set('telemetry', { ...t, linkAnalyticsToAccount: false });
  }
}

/**
 * Migration body: backfill `telemetry.aiMetadata` (the opt-in AI-run metadata
 * bridge, DOR-319, ADR 260713-143958 Phase 7) onto an EXISTING `telemetry`
 * block. conf merges top-level defaults SHALLOWLY, so a `telemetry` object
 * already on disk never inherits the new nested default — this supplies it.
 *
 * Unlike the Tier 1 channels, this is a Tier 2 OPT-IN channel: it seeds `false`
 * for EVERY existing install, regardless of `userHasDecided`. A prior consent
 * choice never enrolls anyone in a new opt-in channel — turning it on is always
 * a fresh, explicit act. Additive + idempotent: only writes when the field is
 * absent, never overwrites a set value. The whole-object-absent case is handled
 * by the schema default on read (which already yields `false`).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillTelemetryAiMetadataChannel(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const telemetry = store.get('telemetry');
  if (telemetry && typeof telemetry === 'object' && !('aiMetadata' in telemetry)) {
    const t = telemetry as Record<string, unknown>;
    store.set('telemetry', { ...t, aiMetadata: false });
  }
}

/**
 * Migration body: backfill `ui.sidebar` (server-persisted sidebar organization —
 * groups, pinned, per-section sort/collapse; DOR-329) onto an EXISTING `ui`
 * block. conf merges top-level defaults SHALLOWLY, so a `ui` object already on
 * disk never inherits the new nested `sidebar` default — this supplies it.
 * Additive + idempotent: only writes when `ui.sidebar` is absent, never
 * overwrites a user's existing organization. The whole-`ui`-absent case is
 * handled by the schema default on read (which already yields the sidebar
 * defaults). Seeds an empty, unorganized sidebar (no pins, no groups).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui && typeof ui === 'object' && (ui as { sidebar?: unknown }).sidebar === undefined) {
    store.set('ui', {
      ...(ui as Record<string, unknown>),
      sidebar: {
        pinned: [],
        groups: [],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
      },
    });
  }
}

/**
 * Migration body: backfill `ui.shapes` (person-scoped Shape state — active
 * Shape, reverse affinity hints, follow toggle; DOR-355) onto an EXISTING `ui`
 * block. conf merges top-level defaults SHALLOWLY, so a `ui` object already on
 * disk never inherits the new nested `shapes` default — this supplies it.
 * Additive + idempotent: only writes when `ui.shapes` is absent, never
 * overwrites an existing value. The whole-`ui`-absent case is handled by the
 * schema default on read (which already yields the shapes defaults). Seeds no
 * active Shape, no affinity hints, and follow off.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillShapesDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui && typeof ui === 'object' && (ui as { shapes?: unknown }).shapes === undefined) {
    store.set('ui', {
      ...(ui as Record<string, unknown>),
      shapes: {
        active: null,
        agentDefaults: {},
        autoFollowAgent: false,
      },
    });
  }
}

/**
 * Migration body: put `ui.statusBar` into its pins shape (`{ pins: [] }`) on an
 * EXISTING `ui` block. conf merges top-level defaults SHALLOWLY, so a `ui`
 * object already on disk never inherits the new nested `statusBar` default —
 * this supplies it. The whole-`ui`-absent case needs nothing: the shallow merge
 * brings in the default `ui`, pins included.
 *
 * Two cases, one write:
 *
 * 1. `ui.statusBar` absent (an upgrade from any released version) — seed
 *    `{ pins: [] }`.
 * 2. `ui.statusBar` holding the retired ten-boolean visibility shape — replace
 *    it with `{ pins: [] }`. **This drops the old show/hide choices rather than
 *    translating them, deliberately.** The semantics inverted: the ten booleans
 *    were subtractive (everything visible, hide what you don't want) and pins
 *    are additive (nothing but news, pin what you always want). Mapping
 *    "visible" to "pinned" would hand anyone still on the defaults ten pins and
 *    erase the quiet-by-default line the pins exist to serve, so this is a
 *    one-time reset (spec composer-status-redesign §5.1, DOR-452).
 *
 * The retired shape can only be on disk from a pre-release build: `ui.statusBar`
 * was introduced (as ten booleans) after v0.56.0 and never appeared in a tagged
 * release, so case 2 only ever fires on a machine that ran `main` between
 * DOR-431 and DOR-452. It is handled here rather than in a later key because the
 * booleans now violate the schema (`additionalProperties: false`, `pins`
 * required) and conf validates the whole store once migrations finish — leaving
 * them for a `0.58.0` key would hard-fail startup on any release cut as 0.57.0.
 *
 * Idempotent: a `statusBar` that already carries a `pins` array is left exactly
 * as it is, so re-running (corrupt-recovery, a hand-edited migration version)
 * never clears someone's pins.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateStatusBarToPins(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;

  const statusBar = (ui as { statusBar?: unknown }).statusBar;
  const alreadyPinned =
    statusBar !== null &&
    typeof statusBar === 'object' &&
    Array.isArray((statusBar as { pins?: unknown }).pins);
  if (alreadyPinned) return;

  store.set('ui', { ...(ui as Record<string, unknown>), statusBar: { pins: [] } });
}

/**
 * Migration body: backfill the DOR-339 display-filter/mute fields onto an
 * EXISTING `ui.sidebar` — `muted: []` and `ungroupedDisplayFilter: 'all'` on
 * the section itself, plus `displayFilter: 'all'` and `muted: false` on every
 * already-stored group. conf merges top-level defaults SHALLOWLY and never
 * reaches inside array elements at all, so a `ui.sidebar` already on disk —
 * including every group inside it — never inherits these new fields on its
 * own; this supplies them. Additive + idempotent: only writes a field that is
 * actually missing, never overwrites an existing value (a user who already
 * set a group's filter, or muted a group or agent, keeps that choice
 * untouched). The whole-section-absent case is handled by the schema default
 * on read (already yields these defaults) and by `backfillSidebarDefaults`
 * for an existing `ui` block with no `sidebar` at all.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarSettingsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;

  let groups = s.groups;
  let groupsChanged = false;
  if (Array.isArray(s.groups)) {
    groups = s.groups.map((g: unknown) => {
      if (!g || typeof g !== 'object') return g;
      const group = g as Record<string, unknown>;
      if (group.displayFilter !== undefined && group.muted !== undefined) return group;
      groupsChanged = true;
      return {
        ...group,
        displayFilter: group.displayFilter ?? 'all',
        muted: group.muted ?? false,
      };
    });
  }

  const needsSectionFields = s.muted === undefined || s.ungroupedDisplayFilter === undefined;
  if (!needsSectionFields && !groupsChanged) return;

  store.set('ui', {
    ...(ui as Record<string, unknown>),
    sidebar: {
      ...s,
      muted: s.muted ?? [],
      ungroupedDisplayFilter: s.ungroupedDisplayFilter ?? 'all',
      groups,
    },
  });
}

/**
 * Migration body: backfill the two room-section collapse flags onto an EXISTING
 * `ui.sidebar` — `channelsCollapsed` and `dmsCollapsed`, both `false` (rooms
 * sidebar, DOR-525). conf merges top-level defaults SHALLOWLY, so a `ui.sidebar`
 * already on disk never inherits new nested fields on its own; this supplies
 * them. Additive + idempotent: only writes a field that is actually missing.
 * The whole-section-absent case is handled by the schema default on read and by
 * `backfillSidebarDefaults` for an existing `ui` block with no `sidebar`.
 *
 * Both start expanded. A person upgrading into this release should SEE the two
 * new sections rather than have to discover two collapsed headers.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSidebarRoomSections(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (s.channelsCollapsed !== undefined && s.dmsCollapsed !== undefined) return;

  store.set('ui', {
    ...(ui as Record<string, unknown>),
    sidebar: {
      ...s,
      channelsCollapsed: s.channelsCollapsed ?? false,
      dmsCollapsed: s.dmsCollapsed ?? false,
    },
  });
}

/**
 * Migration body: backfill the `connectors` section (`rawMcpServers`, the
 * remote MCP servers the raw-MCP connector offers; connector-completion spec)
 * for configs persisted before it existed. Additive + idempotent: only writes
 * when the key is absent; the schema default also yields `{ rawMcpServers: [] }`
 * on read, so this just writes it through on the upgrade where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `has`/`set`).
 */
export function backfillConnectorsDefaults(store: {
  has: (key: string) => boolean;
  set: (key: string, value: unknown) => void;
}): void {
  if (!store.has('connectors')) {
    store.set('connectors', { rawMcpServers: [] });
  }
}

/**
 * Migration body: backfill the `rooms` section (the cascade ceiling agents
 * reply within, DOR-526) for configs persisted before it existed. Additive +
 * idempotent: only writes when the key is absent; the schema default also
 * yields this object on read, so this just writes it through on the upgrade
 * where it lands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRoomsDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const seeded = {
    maxAgentDepth: 3,
    maxAutomaticTurnsPerRoomPerHour: 60,
    maxAutomaticTurnsTotalPerHour: 240,
    replyWaitMinutes: 10,
    lateReplyCeilingMinutes: 60,
    engagedWindowMinutes: 10,
    engagedWindowPosts: 5,
  };
  const rooms = store.get('rooms');
  if (rooms == null) {
    store.set('rooms', seeded);
    return;
  }
  // conf merges top-level defaults SHALLOWLY, so a `rooms` block already on disk
  // never inherits a new nested field on its own. Supplying them here is what
  // stops an upgrade landing with no spend cap at all.
  const current = { ...(rooms as Record<string, unknown>) };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  // `maxAutomaticTurnsPerHour` only ever existed on unreleased builds of this
  // feature; it was split into the per-room and total caps before shipping.
  // Carry its value onto the per-room cap rather than silently resetting a
  // number somebody chose, then drop it so the schema stops rejecting it.
  if (current.maxAutomaticTurnsPerHour !== undefined) {
    if (typeof current.maxAutomaticTurnsPerHour === 'number') {
      current.maxAutomaticTurnsPerRoomPerHour = current.maxAutomaticTurnsPerHour;
    }
    delete current.maxAutomaticTurnsPerHour;
    changed = true;
  }
  if (changed) store.set('rooms', current);
}

/**
 * Migration body: backfill `kind: 'manual'` onto every EXISTING stored group
 * (smart-agent-groups, DOR-338). conf merges top-level defaults SHALLOWLY and
 * never reaches inside array elements, so a `ui.sidebar.groups` array already
 * on disk never inherits the new `kind` discriminator on its own — every
 * pre-DOR-338 group would read back with `kind: undefined` even though the
 * `SidebarGroupSchema` type says it's always `'manual' | 'smart'`. Additive +
 * idempotent: only writes `kind` when it is actually missing, never touches
 * `rules` (absent is correct for a manual group). The whole-`ui`/whole-section
 * -absent cases are handled by the schema default on read.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillSmartGroupKindDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (!Array.isArray(s.groups)) return;

  let changed = false;
  const groups = s.groups.map((g: unknown) => {
    if (!g || typeof g !== 'object') return g;
    const group = g as Record<string, unknown>;
    if (group.kind !== undefined) return group;
    changed = true;
    return { ...group, kind: 'manual' };
  });
  if (!changed) return;

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: { ...s, groups } });
}

/**
 * Migration body: convert the three sidebar membership lists from bare agent
 * `projectPath` strings to `SidebarItemRef` objects, and rename
 * `groups[].agentPaths` to `groups[].items` (sidebar-groups, DOR-579).
 *
 * `ui.sidebar.pinned`, `ui.sidebar.muted` and every group's member list used to
 * hold a `string[]` of agent paths, which left nowhere to reference a room (a
 * room has a ULID, not a path). They now hold
 * `{ kind: 'agent'; path } | { kind: 'room'; roomId }`.
 *
 * **The rename is not additive, so this backfill is load-bearing.** Without it
 * an upgraded config reads back with `items` absent, takes the Zod default of
 * `[]`, and every group silently empties while the real data sits in an
 * `agentPaths` key nothing reads. It is keyed to the release that ships the new
 * schema for exactly that reason.
 *
 * The mapping is total: every string in these arrays predates rooms in the
 * sidebar, so all of them ARE agent paths and none can be misread. Idempotent —
 * an entry that is already an object passes through untouched, a group that
 * already has `items` keeps it, and a run that finds nothing to convert writes
 * nothing. `agentPaths` is dropped rather than left beside `items`: the
 * generated JSON Schema closes each group object, so a leftover key would fail
 * validation on the first read after the migration.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateSidebarMembersToItemRefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  let changed = false;

  /**
   * Wrap each stored path; anything already an object is a ref and passes
   * through. Delegates to the shared {@link toSidebarItemRef} so this file and
   * the read-time `normalizeSidebarPrefs` conversion state the rule once.
   */
  const toItemRefs = (value: unknown): unknown[] =>
    (Array.isArray(value) ? value : []).map((entry) =>
      toSidebarItemRef(entry as SidebarItemRef | string)
    );
  /** Whether a list still holds the pre-DOR-579 shape (and so needs converting). */
  const hasStringEntry = (value: unknown): boolean =>
    Array.isArray(value) && value.some((entry) => typeof entry === 'string');

  const next: Record<string, unknown> = { ...s };

  for (const field of ['pinned', 'muted'] as const) {
    if (!hasStringEntry(s[field])) continue;
    next[field] = toItemRefs(s[field]);
    changed = true;
  }

  if (Array.isArray(s.groups)) {
    next.groups = s.groups.map((g: unknown) => {
      if (!g || typeof g !== 'object') return g;
      const group = g as Record<string, unknown>;
      if (!('agentPaths' in group) && !hasStringEntry(group.items)) return group;
      changed = true;
      const { agentPaths, ...rest } = group;
      return {
        ...rest,
        // An existing `items` wins over a leftover `agentPaths`: only a config
        // written before DOR-579 carries the old key, so the two can never hold
        // different truths, and preferring `items` keeps a re-run from
        // resurrecting a list the person has since edited.
        items: toItemRefs(group.items ?? agentPaths),
      };
    });
  }

  if (!changed) return;

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: next });
}

/**
 * Migration body: scrub retired onboarding step ids from a persisted
 * `onboarding` block. The first-run flow was shortened, narrowing
 * `ONBOARDING_STEPS` from four values to two — `'tasks'` and `'adapters'` no
 * longer exist. A config carrying either in `completedSteps`/`skippedSteps`
 * (most upgraders do: the old finish path recorded a synthetic `'adapters'`
 * completion) would fail the narrowed enum's final validation, so this filters
 * both arrays down to the still-valid set.
 *
 * Additive-safe + idempotent: only rewrites an array when it actually contains a
 * retired value, so re-running is a no-op. conf skips validation during
 * migrations, so the stale values pass through every earlier migration's writes
 * unharmed; this body just has to run before the single post-migration validate.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function scrubRetiredOnboardingSteps(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const onboarding = store.get('onboarding');
  if (onboarding == null || typeof onboarding !== 'object') return;
  const valid = new Set<string>(ONBOARDING_STEPS);
  const o = onboarding as Record<string, unknown>;
  let changed = false;
  const next = { ...o };
  // The old flow's finish path recorded a synthetic 'adapters' completion, so
  // its presence means this user already finished onboarding. Backfill the new
  // authoritative signal BEFORE scrubbing it away, or every already-onboarded
  // user would be re-onboarded on upgrade.
  const completed = Array.isArray(o.completedSteps) ? o.completedSteps : [];
  if (completed.includes('adapters') && typeof o.completedAt !== 'string') {
    next.completedAt = typeof o.startedAt === 'string' ? o.startedAt : new Date().toISOString();
    changed = true;
  }
  for (const field of ['completedSteps', 'skippedSteps'] as const) {
    const arr = o[field];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((step) => typeof step === 'string' && valid.has(step));
    if (filtered.length !== arr.length) {
      next[field] = filtered;
      changed = true;
    }
  }
  if (changed) store.set('onboarding', next);
}

/**
 * Migration body: backfill the `profile` section (who the user is — roles,
 * tools, display name; spec `user-profile-onboarding`) for configs persisted
 * before it existed. Additive + idempotent: only writes when the key is absent;
 * conf's top-level defaults-merge also yields this object on read, so this is a
 * no-op anchor that writes the key through on the upgrade where it lands. Seeds
 * everything empty/null: DorkOS knows nothing about the person until they say.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillProfileDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('profile') == null) {
    store.set('profile', { roles: [], tools: [], displayName: null, rolePromptDismissedAt: null });
  }
}

/**
 * @internal Exported for testing only — lets the migration-key invariant test
 * assert the newest key is always ahead of the current release (the DOR-339
 * "0.54.0 shipped mid-flight" class of bug: a key equal to or behind an
 * already-tagged version is silently excluded by conf's `(storedVersion,
 * projectVersion]` window, so it never runs for upgrading users).
 */
export const CONFIG_MIGRATIONS = {
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
  // Everything below shipped together in v0.45.0. Each body was authored on a
  // placeholder "next ascending release" key (0.45.0-0.53.0) while on main;
  // /system:release reconciled them to the one real release at tag time
  // (2026-07-09). Order matters: conf runs entries in insertion order, and
  // `backfillWorkbenchTerminalGraceTtl` must follow `backfillWorkbenchDefaults`.
  // Every body is idempotent, so re-running the composite is safe.
  '0.45.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  }) => {
    // `workspace` section (WorkspaceManager, DOR-84).
    backfillWorkspaceDefaults(store);
    // `harness` section (Harness Sync auto-sync gate, GAP-4).
    backfillHarnessDefaults(store);
    // `runtimes` section (multi-runtime support, DOR-180).
    backfillRuntimesDefaults(store);
    // Credential substrate (`providers` registry, DOR-183, ADR-0315). Seeds
    // only references/nulls, never a plaintext secret.
    backfillProvidersDefaults(store);
    // `auth` section (local login gate, accounts-and-auth P1).
    backfillAuthDefaults(store);
    // Remove tunnel passcode fields + root `sessionSecret` (accounts-and-auth
    // P1, task 1.6). Better Auth replaced them; stale hashes are discarded,
    // not migrated.
    dropTunnelPasscodeAndSessionSecret(store);
    // `cloud` section (device-link instance token, accounts-and-auth P2).
    backfillCloudDefaults(store);
    // `workbench` section (viewer-registry overrides, DOR-219).
    backfillWorkbenchDefaults(store);
    // `workbench.terminalGraceTtlMinutes` (terminal re-attach grace window,
    // DOR-225) — supplies the nested field conf's shallow defaults-merge won't
    // add to a `workbench` block the previous body just created.
    backfillWorkbenchTerminalGraceTtl(store);
  },
  // Both authored on the next-ascending-release placeholder while on main;
  // /system:release reconciles the key to the real release at tag time. One
  // composite body (an object literal can't repeat the key); order is
  // insertion order and both are idempotent + independent.
  '0.46.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
    delete: (key: string) => void;
  }) => {
    // Generalize `telemetry` into the shared opt-in consent namespace (DOR-293,
    // ADR 260711-141639): rename `telemetry.enabled` → `telemetry.install` and
    // backfill the new `heartbeat` + `errorReporting` channel flags (both OFF).
    generalizeTelemetryConsent(store);
    // `workbench.autoOpenDiff` (auto-open the diff review surface on agent
    // edits, DOR-212).
    backfillWorkbenchAutoOpenDiff(store);
  },
  // Reconciled from the `0.47.0` placeholder to `0.48.0` at release time
  // (DOR-315 watch-item): a `v0.47.0` tag briefly existed on a divergent commit,
  // so the telemetry backfills ship in 0.48.0 — keying them here guarantees
  // every 0.46.0 -> 0.48.0 upgrade actually runs them.
  '0.48.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // Backfill `telemetry.lastPromptedVersion` (consent re-prompt anchor,
    // DOR-312, ADR 260713-143958 Phase 1). Additive + idempotent; seeds `null`.
    backfillTelemetryLastPromptedVersion(store);
    // Flip the Tier 1 channels (`install`, `heartbeat`) to opt-out for
    // never-answered installs (DOR-314, ADR 260713-143958 Phase 2). Preserves an
    // explicit prior choice; the notice-before-first-send gate still applies.
    applyTier1OptOutDefaults(store);
    // Backfill `telemetry.usage` (anonymous feature-usage channel, DOR-315,
    // ADR 260713-143958 Phase 3). Additive + idempotent; already-decided
    // installs start OFF, never-answered take the Tier 1 default ON.
    backfillTelemetryUsageChannel(store);
    // Backfill `telemetry.linkAnalyticsToAccount` (device-link analytics merge
    // opt-in, DOR-320, ADR 260713-143958 Phase 4). Additive + idempotent; Tier 2
    // opt-in, so every upgraded install starts OFF regardless of prior choice.
    backfillTelemetryLinkAnalyticsToAccount(store);
    // Backfill `telemetry.aiMetadata` (opt-in AI-run metadata bridge, DOR-319,
    // ADR 260713-143958 Phase 7). Additive + idempotent; Tier 2 opt-in, so it
    // seeds OFF for every existing install regardless of a prior consent choice.
    backfillTelemetryAiMetadataChannel(store);
  },
  // Backfill `ui.sidebar` (server-persisted sidebar organization — groups,
  // pinned, per-section sort/collapse; DOR-329) onto an existing `ui` block.
  // Additive + idempotent; seeds an empty, unorganized sidebar.
  '0.50.0': backfillSidebarDefaults,
  // Backfill `ui.shapes` (person-scoped Shape state — active Shape, reverse
  // affinity hints, follow toggle; DOR-355) onto an existing `ui` block.
  // Additive + idempotent; seeds no active Shape. Keyed to the next unreleased
  // version (0.51.0 is already tagged); /system:release reconciles the key at
  // tag time if the real release differs.
  '0.52.0': backfillShapesDefaults,
  // Composite: both DOR-339 and DOR-338 targeted "the next unreleased
  // version" while developed concurrently and landed on the same key
  // (0.55.0) — a plain object literal can't repeat a key, so their bodies
  // compose here in insertion order (same convention as the 0.45.0/0.46.0/
  // 0.48.0 composites above). Each body is independent and idempotent.
  '0.55.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // Backfill the DOR-339 display-filter/mute fields (`ui.sidebar.muted`,
    // `ui.sidebar.ungroupedDisplayFilter`, and `displayFilter`/`muted` on
    // every stored group) onto an existing `ui.sidebar`. Additive +
    // idempotent; every filter defaults to 'all' and nothing starts muted.
    backfillSidebarSettingsDefaults(store);
    // Backfill `kind: 'manual'` onto every existing stored group
    // (smart-agent-groups, DOR-338). Additive + idempotent; runs AFTER the
    // DOR-339 backfill above so it sees the same groups array (order is
    // immaterial here since the two bodies touch disjoint fields, but
    // matches the "append yours after it" sequencing).
    backfillSmartGroupKindDefaults(store);
    // Scrub retired onboarding step ids (`'tasks'`, `'adapters'`) from
    // `onboarding.completedSteps`/`skippedSteps` so the narrowed
    // `ONBOARDING_STEPS` enum's final validation never rejects an upgraded
    // config (shorter first-run flow). Additive-safe + idempotent.
    scrubRetiredOnboardingSteps(store);
  },
  // Composite: DOR-452, DOR-501, DOR-516, DOR-522, DOR-525, DOR-526 and DOR-579
  // all target "the next unreleased version" (0.56.0 is already tagged) and an
  // object literal cannot repeat a key, so their bodies compose here in
  // insertion order — the same convention as the 0.45.0/0.46.0/0.48.0/0.55.0
  // composites above. All seven are independent and idempotent.
  // /system:release reconciles the key at tag time if the real release differs.
  //
  // Composing rather than opening a 0.58.0 key is not a style choice here.
  // `conf` only runs a migration when `key > storedVersion && key <=
  // projectVersion`, so a 0.58.0 body would NOT run on the 0.57.0 release that
  // carries this schema — and DOR-579 renames a field, so skipping it empties
  // every group a person has. The rule is "never edit a SHIPPED migration";
  // extending the next unreleased one is the convention.
  '0.57.0': (store: {
    get: (key: string) => unknown;
    has: (key: string) => boolean;
    set: (key: string, value: unknown) => void;
  }) => {
    // Put `ui.statusBar` into its pins shape on an existing `ui` block —
    // status-bar preferences live in server config so devices/agents can read +
    // flip them (DOR-431), and the line is now quiet by default with an additive
    // pin list instead of ten subtractive visibility booleans (DOR-452). Seeds
    // nothing pinned, and drops the retired booleans on the one machine shape
    // that can still carry them (see `migrateStatusBarToPins` for why the reset
    // is deliberate and why it is not deferred to a later key).
    migrateStatusBarToPins(store);
    // `approvals` section (standing permissions, DOR-501). Additive +
    // idempotent; seeds the feature OFF, so an upgrade never relaxes the gate.
    backfillApprovalsDefaults(store);
    // `extensions.approvedToRun` (extension load approval, DOR-516). Additive +
    // idempotent; seeds the list EMPTY, so an upgrade never hands out an approval
    // nobody gave.
    backfillExtensionsApprovedToRun(store);
    // `harness.approvedHooks` (a package writing shell commands into a coding
    // agent's hook files, DOR-522). Additive + idempotent; seeds the list EMPTY,
    // so an upgrade never hands out an approval nobody gave.
    backfillHarnessApprovedHooks(store);
    // `ui.sidebar.channelsCollapsed` / `ui.sidebar.dmsCollapsed` (the Channels
    // and Direct messages sections, DOR-525). Additive + idempotent; both seed
    // expanded so an upgrade shows the new sections rather than hiding them.
    backfillSidebarRoomSections(store);
    // The `rooms` section (DOR-526): `maxAgentDepth`, how far agents may reply
    // to each other before a room stops them, plus the two spend caps that hold
    // whoever the caller claims to be — per room, and across the whole install.
    // Extended by DOR-621 with the two turn-wait bounds (`replyWaitMinutes`,
    // `lateReplyCeilingMinutes`), and again by RP4 with the two engaged-window
    // ceilings (`engagedWindowMinutes`, `engagedWindowPosts`), all of which ship
    // in this same unreleased key.
    // Additive + idempotent; seeds the shipped defaults, so every bound is on
    // for every upgraded install.
    backfillRoomsDefaults(store);
    // Return the Tier 1 telemetry channels to opt-in for every install that
    // never answered a consent prompt (ADR 260727-181825). Reverses the 0.48.0
    // enrolment for that population only; an explicit choice, either way, is
    // left exactly as it stands.
    applyTier1OptInDefaults(store);
    // Convert `ui.sidebar.pinned`, `ui.sidebar.muted` and every group's member
    // list from agent-path strings to `SidebarItemRef` objects, renaming
    // `groups[].agentPaths` -> `groups[].items` (sidebar-groups, DOR-579).
    // Idempotent, but NOT additive: this is a rename, so an install that skips
    // it reads `items` as the schema default `[]` and loses its groups. Runs
    // after the sidebar backfills above so it sees the same `ui.sidebar` object
    // (order is otherwise immaterial — they touch disjoint fields).
    migrateSidebarMembersToItemRefs(store);
    // The `profile` section (who the user is; spec user-profile-onboarding).
    // Added-with-defaults, so this is a no-op anchor: conf's defaults-merge
    // supplies the block on read, and this writes it through on the upgrade
    // where it lands. Composed into this same next-unreleased key per
    // .claude/rules/safe-defaults.md (a fresh key above the release that ships
    // the schema would never run).
    backfillProfileDefaults(store);
    // The `connectors` section (`rawMcpServers`, connector-completion spec):
    // the remote MCP servers the raw-MCP connector offers as connectable
    // services. Additive + idempotent; seeds the list EMPTY, so an upgrade
    // never grants a tool endpoint nobody configured. Independent of the
    // profile backfill above — disjoint fields, order-immaterial.
    backfillConnectorsDefaults(store);
  },
} as const;

/**
 * Widen the generated JSON Schema so conf's Ajv ACCEPTS a `ui.sidebar` written
 * before DOR-579, instead of condemning the whole config file.
 *
 * ## Why this has to exist at all
 *
 * DOR-579 is the first change in this file's migration history that RENAMES a
 * field rather than adding one. Every additive backfill degrades safely when its
 * migration is skipped: the key is absent, a Zod default fills in, nothing
 * breaks. A rename does not. Skipping it leaves `agentPaths` on a group object
 * whose schema is now closed (`additionalProperties: false`), and bare path
 * strings in `pinned`/`muted` where objects are now required — so a config that
 * was valid yesterday becomes schema-INVALID, `new Conf(...)` throws, and the
 * constructor's recovery path backs the file up and replaces it with defaults.
 *
 * That is not "the sidebar forgets its groups". It resets the ENTIRE file:
 * `mesh.scanRoots`, `approvals`, `runtimes`, `cloud`, `onboarding`.
 *
 * It no longer takes the person's privacy choice with it —
 * `safe-defaults/protected-state.ts` salvages that (and every other protective
 * value) before the file is replaced, which is what DOR-584 closed. Do not read
 * that as making this widening optional: salvage keeps protections, not
 * preferences, and it needs the doomed file to still parse as JSON. Not
 * condemning the file in the first place is still the goal.
 *
 * And the migration is skipped more often than it sounds. `conf` runs a key only
 * when `key > storedVersion && key <= projectVersion`, so: a dev tree resolves
 * `SERVER_VERSION` to `0.0.0` and runs NO migrations at all, and shipping this
 * schema in a patch release below the migration key would skip it for every
 * user. Correctness must not hang on the migration running.
 *
 * ## Why it is here and not in the Zod schema
 *
 * Ajv is the ONLY validator on the config read path — nothing calls Zod on a
 * stored object, and `z.toJSONSchema` emits a pipe's OUTPUT schema, so a Zod
 * `.preprocess` would neither run nor widen what Ajv sees. Keying the widening
 * off the schema identities here keeps the exported TypeScript types strict
 * (`SidebarItemRef[]`, no legacy field), which is what makes the compiler
 * enumerate every membership test, and keeps the legacy encoding out of the
 * operator disclosure walker and the OpenAPI export — both of which build their
 * own schema without this override.
 *
 * ## One thing not to assume
 *
 * `SidebarItemRefSchema` is used at THREE sites (`pinned`, `muted`, and each
 * group's `items`), but this fires ONCE for it — Zod emits the node a single
 * time and clones it into each site afterwards, so one widening reaches all
 * three. That is Zod's un-referencing pass, an implementation detail rather
 * than a contract. The fixture in `'a config written before DOR-579 is not
 * condemned'` exercises all three lists together precisely so a Zod change that
 * stopped sharing the node, or a regression widening only one site, goes red
 * rather than silently leaving two paths condemning the file.
 *
 * ## Removing it
 *
 * This is back-compat for ONE release: delete this function and its `override`
 * once the DOR-579 migration has shipped, together with the read-time
 * `normalizeSidebarPrefs` conversion and `ConfigManager.canonicalUi`. The tests
 * named above fail if it is removed early.
 *
 * @param ctx - The `z.toJSONSchema` override context for one schema node.
 */
function tolerateLegacySidebarEncoding(ctx: {
  zodSchema: unknown;
  jsonSchema: Record<string, unknown>;
}): void {
  // `pinned`, `muted` and `groups[].items` all held a bare agent projectPath.
  if (ctx.zodSchema === SidebarItemRefSchema) {
    ctx.jsonSchema.anyOf = [{ type: 'string', minLength: 1 }, { oneOf: ctx.jsonSchema.oneOf }];
    delete ctx.jsonSchema.oneOf;
    return;
  }
  // `groups[].items` was `groups[].agentPaths`; the group object is closed, so
  // the retired key has to be named for Ajv to let it through.
  if (ctx.zodSchema === SidebarGroupSchema) {
    const properties = ctx.jsonSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) return;
    properties.agentPaths = { type: 'array', items: { type: 'string' } };
    // conf builds Ajv with `useDefaults`, so a declared `default` is WRITTEN IN
    // during validation, and Zod marks a defaulted field `required` because its
    // OUTPUT always has one. Left alone, an un-migrated group would gain an
    // empty `items` before anything could read its `agentPaths`, and the
    // read-time conversion — which treats a present `items` as authoritative —
    // would hand back an empty group. Dropping both keeps "absent" meaning
    // absent, so the conversion can tell the two encodings apart at all.
    // `normalizeSidebarPrefs` supplies `[]` for a group that genuinely has
    // neither, and the Zod default still applies wherever Zod parses.
    delete properties.items?.default;
    const required = ctx.jsonSchema.required;
    if (Array.isArray(required)) {
      ctx.jsonSchema.required = required.filter((key) => key !== 'items');
    }
  }
}

const jsonSchemaFull = z.toJSONSchema(UserConfigSchema, {
  target: 'jsonSchema2019-09',
  override: tolerateLegacySidebarEncoding,
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
 *
 * The class is exported alongside the {@link configManager} singleton for one
 * reason: a SECOND manager over the same directory is the faithful stand-in for
 * `dorkos config set`, which is a different process holding its own manager over
 * the same file. Tests that need to reproduce an out-of-process write build one
 * here rather than re-running {@link initConfigManager}, which would replace the
 * singleton and read like a restart — the very thing those tests must not
 * simulate. Production code uses the singleton.
 */
export class ConfigManager {
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
      // Read the doomed file BEFORE deleting it. The common failure is a file
      // that parses as JSON but no longer satisfies the schema (a skipped
      // rename, a narrowed enum, a hand edit), so the person's privacy and
      // permission choices are sitting right there, perfectly readable, in the
      // file we are about to replace. Losing state must not lose a protection.
      let stored: unknown;
      if (fs.existsSync(configPath)) {
        stored = readStoredConfigForSalvage(configPath);
        const backupPath = configPath + '.bak';
        fs.copyFileSync(configPath, backupPath);
        fs.unlinkSync(configPath);
        logger.warn(`Corrupt config backed up to ${backupPath}`);
        logger.warn('Creating fresh config with defaults.');
      }
      // Reuse the exact same options so the recovered store still has the
      // migration chain wired up.
      this.store = new Conf<UserConfig>(confOptions);
      restoreProtectedState(this.store, stored, 'Recovered a damaged config');
    }
  }

  /** Whether this is the first time the config file has been created */
  get isFirstRun(): boolean {
    return this._isFirstRun;
  }

  /**
   * Put a stored `ui` section into the canonical sidebar encoding.
   *
   * **This class is the server's read boundary for the legacy encoding.** A
   * `ui.sidebar` written before DOR-579 holds bare agent paths and
   * `groups[].agentPaths`; the widened conf schema lets conf LOAD that file, but
   * the declared `UserConfig` type says otherwise, and every server-side reader
   * believes the type. Normalizing here — rather than at each consumer — is what
   * makes the type true at the one place the value is handed out, so a new
   * reader cannot reintroduce the gap by forgetting to convert.
   *
   * It matters most on the WRITE path: `applyConfigPatch` merges a patch onto
   * this value and re-validates with Zod, which is strict. Un-normalized, a
   * legacy `pinned` fails that validation and every config write is refused —
   * theme, telemetry consent, onboarding, all of it — and a legacy `agentPaths`
   * is silently stripped by Zod and persisted as an empty group.
   *
   * Returns its input unchanged once the file is canonical, so callers keep
   * referential equality and the steady state costs one scan per list.
   *
   * Removed with the rest of the DOR-579 back-compat, one release on.
   *
   * @param ui - The stored `ui` section, in either encoding.
   */
  private canonicalUi(ui: UserConfig['ui']): UserConfig['ui'] {
    const sidebar = ui?.sidebar;
    if (!sidebar) return ui;
    const normalized = normalizeSidebarPrefs(sidebar);
    return normalized === sidebar ? ui : { ...ui, sidebar: normalized };
  }

  /** Get a top-level config section */
  get<K extends keyof UserConfig>(key: K): UserConfig[K] {
    const value = this.store.get(key);
    // `ui` is the only section that can carry the pre-DOR-579 sidebar encoding.
    return key === 'ui' ? (this.canonicalUi(value as UserConfig['ui']) as UserConfig[K]) : value;
  }

  /**
   * Get a nested value via dot-path (e.g., 'server.port').
   *
   * Reads the store verbatim, so a dot-path INTO `ui.sidebar` on a config that
   * predates DOR-579 reports the stored encoding rather than the canonical one.
   * That is deliberate: this is the "show me what is on disk" accessor behind
   * `dorkos config get`, and no code path derives behaviour from it. Everything
   * that acts on the sidebar goes through {@link ConfigManager.get} or
   * {@link ConfigManager.getAll}, which normalize.
   */
  getDot(key: string): unknown {
    return this.store.get(key as keyof UserConfig);
  }

  /** Set a top-level config section */
  set<K extends keyof UserConfig>(key: K, value: UserConfig[K]): void {
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    this.store.set(key, value);
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
  }

  /** Set a nested value via dot-path. Returns warning if key is sensitive. */
  setDot(key: string, value: unknown): { warning?: string } {
    const result: { warning?: string } = {};
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      result.warning = `'${key}' contains sensitive data. Consider using environment variables instead.`;
    }
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    this.store.set(key as keyof UserConfig, value as UserConfig[keyof UserConfig]);
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
    return result;
  }

  /**
   * Get the full config object, in the canonical sidebar encoding
   * (see {@link ConfigManager.canonicalUi}).
   */
  getAll(): UserConfig {
    const config = this.store.store;
    const ui = this.canonicalUi(config.ui);
    return ui === config.ui ? config : { ...config, ui };
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
   * @param key - The top-level section to reset, or omitted for all of them.
   */
  reset(key?: string): void {
    const licensedBefore = this.standingGrantsLicensed();
    const floorBefore = this.standingGrantVoidFloor();
    if (key) {
      this.store.reset(key as keyof UserConfig);
    } else {
      const stored = this.store.store;
      this.store.clear();
      this.store.set(USER_CONFIG_DEFAULTS);
      restoreProtectedState(this.store, stored, 'Reset your config');
    }
    this.stampStandingGrantVoidFloor(licensedBefore, floorBefore);
  }

  /**
   * Whether the two settings, as stored RIGHT NOW, license a standing permission
   * to exist: local login is on (a cookie is the only thing that tells the person
   * in the cockpit from an agent on the same machine) and the master switch is on.
   *
   * Reads the store rather than taking a posture argument, because the callers are
   * the write methods and the answer has to reflect the file on both sides of the
   * write. Mirrors `readStandingGrantPosture` in
   * `services/core/approvals/standing-grant-settings.ts`, which cannot be reused
   * here: it reads the module singleton, and this may be any manager — including
   * the one the CLI holds in another process, which is the whole point.
   */
  private standingGrantsLicensed(): boolean {
    return (
      this.store.get('auth')?.enabled === true &&
      this.store.get('approvals')?.standingGrants === true
    );
  }

  /** The posture floor as stored right now, or `null` when nothing has narrowed. */
  private standingGrantVoidFloor(): string | null {
    return this.store.get('approvals')?.standingGrantsVoidBefore ?? null;
  }

  /**
   * Hold the posture floor at or above where it was before this write, and move
   * it to now when this write is what took the license away (DOR-520).
   *
   * ## Why the marker lives in the config file, written here
   *
   * `revokeStandingGrantsIfPostureNarrowed` ends live permissions, but it only
   * fires on a write the SERVER performs. `dorkos config set
   * approvals.standingGrants false` and `dorkos config reset` are a different
   * process holding its own manager, with no database and no route — so they end
   * nothing, and switching the setting back on used to wake every surviving
   * permission. This method is on the one seam BOTH processes travel: every write
   * to `~/.dork/config.json` in DorkOS goes through a `ConfigManager`.
   *
   * The floor is durable, which the alternatives are not. It survives the server
   * being down for the whole round trip — the case a config-file watcher cannot
   * see at all, and the case the boot sweep misses too, because by the time the
   * server starts the settings look fine again.
   *
   * ## The floor is MONOTONIC, and that is the whole guarantee
   *
   * The first version stamped on the licensed → unlicensed TRANSITION and nothing
   * else. Review broke it in one line: any write performed while the posture was
   * ALREADY narrowed is not a transition, so it did not stamp — while
   * `dorkos config reset` had meanwhile rewritten the whole file from defaults and
   * put the leaf back to `null`. Switch off, reset, switch on, and the permission
   * was live again, through nothing but the verbs this feature claims to cover.
   *
   * The same shape reached `PATCH /api/config`: `applyConfigPatch` computes the
   * merged value ONCE from the pre-write snapshot and then writes each top-level
   * section in turn, so a batch carrying `auth` before `approvals` stamped the
   * floor and then wrote the snapshot's stale `null` straight back over it.
   *
   * So the rule is stated as an invariant on the STORED value rather than as a
   * reaction to a transition: after any write, the floor is `floorBefore`, except
   * on a narrowing where it becomes `max(floorBefore, now)`. Never lower, on any
   * path, whatever the write happened to contain.
   *
   * `max` rather than `now` is what makes it monotonic rather than merely current:
   * a backwards clock (an NTP correction, a container with a bad RTC) would
   * otherwise lower a floor that had already voided permissions.
   *
   * ## It still writes nothing when nothing narrowed
   *
   * Stating the rule as "stamp whenever the posture is unlicensed after the write"
   * would also close the hole, and would move the floor on EVERY config write for
   * the vast majority of installs, which never switch this feature on — doubling
   * config write I/O to maintain a marker with nothing to void. Comparing against
   * the stored value first keeps the common path free.
   *
   * @param licensedBefore - Whether the posture licensed a permission before the
   *   write that just happened.
   * @param floorBefore - The floor as it stood before the write, which this write
   *   may raise but must never lower.
   */
  private stampStandingGrantVoidFloor(licensedBefore: boolean, floorBefore: string | null): void {
    const narrowed = licensedBefore && !this.standingGrantsLicensed();
    const required = narrowed ? latestInstant(floorBefore, new Date().toISOString()) : floorBefore;
    if (required === null) return;

    const approvals = this.store.get('approvals');
    if (approvals?.standingGrantsVoidBefore === required) return;
    this.store.set('approvals', { ...approvals, standingGrantsVoidBefore: required });
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
