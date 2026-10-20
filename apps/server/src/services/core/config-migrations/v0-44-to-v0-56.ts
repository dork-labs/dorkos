/**
 * Config migration helpers for the keys from `0.44.0` through `0.56.0`: the
 * first sections (workspace, harness, runtimes, providers, auth, cloud,
 * workbench), telemetry consent, and the first sidebar, shapes and onboarding
 * backfills.
 *
 * Each helper is a body that a key in `CONFIG_MIGRATIONS` (`./index.ts`)
 * calls, moved here verbatim from `config-manager.ts`. A body is frozen once
 * it merges: see `./index.ts` for the rules, and `contributing/configuration.md`
 * → Schema Migrations for the process.
 *
 * @module services/core/config-migrations/v0-44-to-v0-56
 */
import { ONBOARDING_STEPS } from '@dorkos/shared/config-schema';

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
