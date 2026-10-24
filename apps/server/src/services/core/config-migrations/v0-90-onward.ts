/**
 * Config migration helpers for the keys from `0.90.0` on. A helper for a new
 * key goes at the bottom of this file.
 *
 * Each helper is a body that a key in `CONFIG_MIGRATIONS` (`./index.ts`)
 * calls, moved here verbatim from `config-manager.ts`. A body is frozen once
 * it merges: see `./index.ts` for the rules, and `contributing/configuration.md`
 * → Schema Migrations for the process.
 *
 * @module services/core/config-migrations/v0-90-onward
 */
import type Conf from 'conf';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

/**
 * Migration body: seed `extensions.dismissedApprovals: {}` for configs persisted
 * before the Activity inbox could be told "Not now" about an extension waiting
 * to run (DOR-2517).
 *
 * Seeds the map empty. A config that predates it has never declined anything,
 * so there is nothing to carry over, and losing it could only mean being asked
 * once more. Additive and idempotent: writes only when `dismissedApprovals` is
 * not already an object, and never touches the other `extensions` members. A
 * config with no `extensions` key is skipped (the schema default supplies the
 * object on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedExtensionsDismissedApprovals(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return;
  const dismissed = (ext as { dismissedApprovals?: unknown }).dismissedApprovals;
  if (dismissed && typeof dismissed === 'object' && !Array.isArray(dismissed)) return;
  store.set('extensions', { ...(ext as Record<string, unknown>), dismissedApprovals: {} });
}

/**
 * Migration body: seed `extensions.approvedPermissions: {}` for configs
 * persisted before an approval recorded the permission set it covers
 * (DOR-2686).
 *
 * Seeds the map empty, and that is not a loss of anything: a missing entry
 * means the full in-process set, which is exactly what every earlier approval
 * was given for, so every extension approved before keeps running. Additive
 * and idempotent: writes only when `approvedPermissions` is not already an
 * object, and never touches the other `extensions` members. A config with no
 * `extensions` key is skipped (the schema default supplies the object on
 * read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedExtensionsApprovedPermissions(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return;
  const permissions = (ext as { approvedPermissions?: unknown }).approvedPermissions;
  if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) return;
  store.set('extensions', { ...(ext as Record<string, unknown>), approvedPermissions: {} });
}

/**
 * Migration body: seed `runtimes.codex.transport: 'auto'` for configs persisted
 * before DorkOS could run Codex on `codex app-server` (ADR 261005-113107).
 *
 * `auto` is the only honest seed: it means "whatever DorkOS runs by default",
 * which is exactly what a config that predates the choice was getting. The
 * value is resolved by the server (`resolveCodexTransport`), never here, so a
 * later change of default reaches this config without another migration.
 * Additive and idempotent: writes only when `transport` is not already one of
 * the known values, and never touches the other `runtimes.codex` members. A
 * config with no `runtimes.codex` object is skipped (the schema default
 * supplies it on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedCodexTransport(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const codex = (runtimes as { codex?: unknown }).codex;
  if (!codex || typeof codex !== 'object' || Array.isArray(codex)) return;
  const current = (codex as { transport?: unknown }).transport;
  if (current === 'auto' || current === 'app-server' || current === 'exec') return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    codex: { ...(codex as Record<string, unknown>), transport: 'auto' },
  });
}

/**
 * Migration body: seed `spaces.official: { url: '' }` for configs persisted
 * before the official DorkOS space had a setting (spec
 * `official-community-space` D4).
 *
 * `''` is the only honest seed: it means "no official space", which is what a
 * config that predates the setting had. A link reaches an install through a
 * release default or a person, never through this body. Additive and
 * idempotent: writes only when `official.url` is not already a string, and
 * keeps every other `spaces` member (`enabled` above all). A config with no
 * `spaces` object is skipped: a whole missing section is written by conf's own
 * defaults merge before any key runs.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedSpacesOfficial(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const spaces = store.get('spaces');
  if (!spaces || typeof spaces !== 'object' || Array.isArray(spaces)) return;
  const official = (spaces as { official?: unknown }).official;
  if (
    official &&
    typeof official === 'object' &&
    !Array.isArray(official) &&
    typeof (official as { url?: unknown }).url === 'string'
  )
    return;
  store.set('spaces', { ...(spaces as Record<string, unknown>), official: { url: '' } });
}

/**
 * Migration body: seed `extensions.trustedSources: []` for configs persisted
 * before a person could trust a code source outright (spec `flow-multiproject`
 * §9.3).
 *
 * Seeds the list empty. A config that predates it trusts no source, and an
 * empty list is the strict reading: every extension keeps asking on its own.
 * Additive and idempotent: writes only when `trustedSources` is not already an
 * array, and never touches the other `extensions` members. A config with no
 * `extensions` key is skipped (the schema default supplies the object on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedExtensionsTrustedSources(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ext = store.get('extensions');
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return;
  if (Array.isArray((ext as { trustedSources?: unknown }).trustedSources)) return;
  store.set('extensions', { ...(ext as Record<string, unknown>), trustedSources: [] });
}

/**
 * Migration body: seed `cloud.credits` for configs persisted before DorkOS
 * credits were a choice in Runs on (ADR 261001-000811).
 *
 * **Never arms anything.** No runtime gets a credits default from here, linked
 * or not: a computer already linked is owed one dismissible offer instead
 * (`offer: 'pending'`), and an unlinked one owes nothing (`'none'`); its next
 * link fills the gaps then. Additive and idempotent: writes only when `cloud`
 * is an object with no `credits` member, and never touches the link fields
 * beside it. A config with no `cloud` key is skipped (the schema default
 * supplies `{ defaults: {}, offer: 'none' }` on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedCloudCreditsChoices(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const cloud = store.get('cloud');
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return;
  if ('credits' in cloud && (cloud as { credits?: unknown }).credits != null) return;
  const token = (cloud as { instanceToken?: unknown }).instanceToken;
  const linked = typeof token === 'string' && token.trim() !== '';
  store.set('cloud', {
    ...(cloud as Record<string, unknown>),
    credits: { defaults: {}, offer: linked ? 'pending' : 'none' },
  });
}

/**
 * Migration body: seed `cloud.remote` for configs persisted before managed
 * remote access existed (DOR-2086).
 *
 * **Seeds the mode the person already has, and nothing else.** A computer whose
 * own ngrok tunnel is switched on (`tunnel.enabled === true`) is seeded `byo`,
 * so it reads back as the remote access it already uses; every other computer
 * is seeded `off`. No enrolment, no link binding, no credential reference, no
 * hosts: only a person's approval on this computer creates an enrolment, so an
 * upgrade can never stand for one. `tunnel` is READ for that one flag and never
 * written: the person's own ngrok token stays exactly where it is and is never
 * copied into managed storage.
 *
 * The literal is written out here rather than taken from
 * `defaultRemoteAccessSettings()`, so this frozen body cannot move when the
 * schema's defaults do; a test pins that the two agree today.
 *
 * Additive and idempotent: writes only when `cloud` is an object whose
 * `remote` member is not, and never touches the link fields or `credits`
 * beside it. A config with no `cloud` key is skipped (the schema default
 * supplies the whole section on read, and conf persists a missing top-level
 * section on its own).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedCloudRemoteAccess(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const cloud = store.get('cloud');
  if (!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return;
  const remote = (cloud as { remote?: unknown }).remote;
  if (remote && typeof remote === 'object' && !Array.isArray(remote)) return;
  const tunnel = store.get('tunnel');
  const byoEnabled =
    tunnel !== null &&
    typeof tunnel === 'object' &&
    (tunnel as { enabled?: unknown }).enabled === true;
  store.set('cloud', {
    ...(cloud as Record<string, unknown>),
    remote: {
      mode: byoEnabled ? 'byo' : 'off',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
      credentialRef: null,
      credentialId: null,
      fingerprint: null,
      hosts: [],
      edgeProofRef: null,
      edgeProofHeader: null,
    },
  });
}

/** A stored value as a plain object, or `null` when it is anything else. */
function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Migration body: move an existing install to the Trusted posture once, unless
 * the person already chose to be asked (DOR-2739, ADR 261006-225605, spec
 * `trusted-by-default-flip` §5.7).
 *
 * | Stored                                                        | Becomes                                                     |
 * | ------------------------------------------------------------- | ----------------------------------------------------------- |
 * | `permissions.preset: 'careful'`                               | unchanged; `ui.trustNoticeSeenAt` stamped (no notice)       |
 * | preset `null` or `'trusted'`, and `ui.fullPowerChoice: 'supervised'` | preset `'careful'`; `ui.trustNoticeSeenAt` stamped     |
 * | anything else (`null`, `'balanced'`, `'full'`, unknown)       | preset `'trusted'`; notice left to show                     |
 * | `runtimes.defaultTrustStop` `null` or `'act'`, on that last row | `'autonomy'` (`'ask'` and `'autonomy'` kept)              |
 * | `ui.fullPowerDecidedAt`, `ui.fullPowerChoice`                 | deleted (the door is retired)                               |
 *
 * **Why an explicit Careful choice is respected.** A person who already said
 * "keep asking me" answered the question the notice asks; moving them would be
 * the silent flip the ADR forbids. Full and Balanced were both answers to "how
 * much should agents ask", and Trusted is what that answer now means.
 *
 * **Why `'trusted'` counts as unanswered beside `'supervised'`.** Before this
 * release no build offered Trusted, so a stored `'trusted'` is conf's own
 * top-level defaults merge: an install from before `permissions` existed gets
 * the section from `USER_CONFIG_DEFAULTS` before any key runs, and `'0.83.0'`
 * (which maps a "keep asking me" answer to Careful) then sees a preset and steps
 * aside. Reading that seed as an answer would move exactly the person who chose
 * to be asked.
 *
 * **What it leaves alone.** `permissions.defaults` and every per-agent override
 * (a person's own changes stay on top of the preset), the per-runtime stops
 * (`null` already follows the global one), and a stop a person set to `'ask'`.
 * `permissions.trustedStoresAppliedAt` is not set here: the mesh rules and the
 * database are not in this file, so the boot steps that change them stamp it.
 *
 * Idempotent: a second run finds the preset it wrote, keeps a stamped notice,
 * and has no door fields left to delete.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 * @param now - The time to stamp; injectable for tests.
 */
export function applyTrustedPosture(
  store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  },
  now: Date = new Date()
): void {
  const permissions = plainObject(store.get('permissions'));
  const ui = plainObject(store.get('ui'));
  const preset = permissions?.preset ?? null;
  const keptAsking =
    preset === 'careful' ||
    ((preset === null || preset === 'trusted') && ui?.fullPowerChoice === 'supervised');

  const nextPermissions = {
    ...(permissions ?? { defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null }),
    preset: keptAsking ? 'careful' : 'trusted',
  };
  if (nextPermissions.preset !== preset) store.set('permissions', nextPermissions);

  if (!keptAsking) {
    const runtimes = plainObject(store.get('runtimes'));
    const stop = runtimes?.defaultTrustStop ?? null;
    if (runtimes && (stop === null || stop === 'act')) {
      store.set('runtimes', { ...runtimes, defaultTrustStop: 'autonomy' });
    }
  }

  if (!ui) return;
  const { fullPowerDecidedAt: _decidedAt, fullPowerChoice: _choice, ...nextUi } = ui;
  if (keptAsking && (nextUi.trustNoticeSeenAt ?? null) === null) {
    nextUi.trustNoticeSeenAt = now.toISOString();
  }
  const changed =
    'fullPowerDecidedAt' in ui ||
    'fullPowerChoice' in ui ||
    nextUi.trustNoticeSeenAt !== ui.trustNoticeSeenAt;
  if (changed) store.set('ui', nextUi);
}

/**
 * Migration body: remove `rooms.maxPostsPerTurn` and `rooms.maxCanvasOpsPerTurn`
 * (DOR-2739).
 *
 * Both capped how often one of our own agents could post into a room, or change
 * its canvas, inside one turn. ADR 261006-225605 retires agent-only caps on
 * routine output: etiquette is held by review and the record, not refusal, and
 * the loop guards (cascade guard, turn budgets) still stop runaway exchanges. So
 * neither leaf is declared any more, and both are deleted rather than left
 * riding along in every config.
 *
 * Idempotent: only deletes a key when it is present. Nothing else under `rooms`
 * is touched.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance.
 */
export function dropAgentTurnCaps(store: Pick<Conf, 'has' | 'delete'>): void {
  for (const key of ['rooms.maxPostsPerTurn', 'rooms.maxCanvasOpsPerTurn']) {
    if (store.has(key)) store.delete(key);
  }
}

/**
 * Migration body: remove `ui.autonomyAcknowledgedAt` (DOR-2739).
 *
 * It recorded that a person had read what Full autonomy means, and the server
 * refused every Full-autonomy write without it. ADR 261006-225605 retires that
 * ritual: our own agents run at full power by default and the audit trail is
 * the record, so the field gates nothing and is no longer declared. Deleting it
 * rather than leaving it is what keeps a key no build reads from riding along
 * in every config for ever.
 *
 * Idempotent: only deletes the key when it is present. Nothing else under `ui`
 * is touched.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `has`/`delete`).
 */
export function dropAutonomyAcknowledgement(store: {
  has: (key: string) => boolean;
  delete: (key: string) => void;
}): void {
  if (store.has('ui.autonomyAcknowledgedAt')) {
    store.delete('ui.autonomyAcknowledgedAt');
  }
}

/**
 * Migration body: seed `runtimes.claudeCode.defaultAccountColor: null` for
 * configs persisted before the standalone default Claude account could be
 * given a color (DOR-2492).
 *
 * `null` is "the default for its position", which is exactly the color that
 * account was drawn in before the field existed, so nothing anyone sees
 * changes. A nested leaf under a block every stored config already has, so
 * conf's defaults merge never writes it and this body is the only thing that
 * does.
 *
 * Additive and idempotent: writes only when the key is absent, and keeps every
 * other `runtimes.claudeCode` member. A config with no `runtimes.claudeCode`
 * object is skipped (the schema default supplies the block on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedDefaultAccountColor(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const block = (runtimes as Record<string, unknown>).claudeCode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  if ('defaultAccountColor' in block) return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { ...(block as Record<string, unknown>), defaultAccountColor: null },
  });
}

/**
 * Migration body: seed the account rules (spec `flow-multiproject` §8.1, N6)
 * for configs persisted before an account could be kept to projects:
 * `runtimes.claudeCode.projectAccounts: {}`,
 * `runtimes.claudeCode.defaultAccountOnlyProjects: null`, and
 * `onlyProjects: null` on each registry row that lacks it.
 *
 * Every value is "no rule", which is exactly how every account behaved before
 * the rules existed, so nothing anyone sees changes. Nested leaves under a
 * block every stored config already has, so conf's defaults merge never writes
 * them and this body is the only thing that does.
 *
 * Additive and idempotent: writes only what is absent, edits rows by position
 * so every other member of every row survives (as `seedDefaultAccountColor`
 * keeps every other `claudeCode` member), and writes the whole `runtimes`
 * section, never a dotted key: `projectAccounts` is keyed by paths, which
 * contain dots. A config with no `runtimes.claudeCode` object is skipped (the
 * schema default supplies the block on read).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedAccountProjectRules(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const block = (runtimes as Record<string, unknown>).claudeCode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  const current = block as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  if (!('projectAccounts' in current)) {
    next.projectAccounts = {};
    changed = true;
  }
  if (!('defaultAccountOnlyProjects' in current)) {
    next.defaultAccountOnlyProjects = null;
    changed = true;
  }
  if (Array.isArray(current.accounts)) {
    let rowsChanged = false;
    const rows = current.accounts.map((row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || 'onlyProjects' in row) {
        return row;
      }
      rowsChanged = true;
      return { ...(row as Record<string, unknown>), onlyProjects: null };
    });
    if (rowsChanged) {
      next.accounts = rows;
      changed = true;
    }
  }
  if (!changed) return;
  store.set('runtimes', { ...(runtimes as Record<string, unknown>), claudeCode: next });
}

/**
 * Migration body: seed `runtimes.claudeCode.dismissedFolders` as an empty list
 * (spec `claude-account-ui` §7.4): the account folders a person dismissed from
 * Settings' "Found on this computer" list.
 *
 * A nested leaf inside a section every stored config already has, so conf's
 * shallow defaults-merge never adds it and this body is what writes it.
 * Empty on purpose: nothing was dismissed before the list existed.
 *
 * Additive and idempotent: writes only when the leaf is not already an array,
 * and keeps every other `claudeCode` member. A config with no `runtimes` or no
 * `claudeCode` block is skipped (the schema default supplies it on read).
 *
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedClaudeDismissedFolders(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const block = (runtimes as Record<string, unknown>).claudeCode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  if (Array.isArray((block as Record<string, unknown>).dismissedFolders)) return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { ...(block as Record<string, unknown>), dismissedFolders: [] },
  });
}

/**
 * Seed `profile.timezone`, `profile.workingHours` and `profile.away` — a
 * person's zone, hours and away note (spec `heartbeats` §3.5).
 *
 * **The mechanism, not an anchor**, for the reason
 * {@link seedDisplayNameSourceDefault} gives: nested leaves inside a section
 * every stored config already carries, and conf's pre-migration merge is
 * shallow, so nothing else writes them to disk for an upgraded install.
 *
 * **Each seeds `null`, which is the honest answer for all three.** Nobody has
 * told this install a zone yet: the app fills `timezone` from the browser the
 * first time it opens, and seeding the server's own zone here would decide it
 * from a machine that may sit in a container or another country. `null` hours
 * read as Monday to Friday, 09:00 to 17:00, and `null` away means here.
 *
 * Per leaf, and absence is tested with `in`: the defaults are `null`, so a
 * `== null` guard would rewrite a stored `null` on every corrupt-recovery
 * re-run, and a person who already set one leaf keeps it.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedWorkingHoursDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const profile = store.get('profile');
  if (profile == null || typeof profile !== 'object') return;
  const current = profile as Record<string, unknown>;
  const missing = (['timezone', 'workingHours', 'away'] as const).filter(
    (leaf) => !(leaf in current)
  );
  if (missing.length === 0) return;
  store.set('profile', {
    ...current,
    ...Object.fromEntries(missing.map((leaf) => [leaf, USER_CONFIG_DEFAULTS.profile[leaf]])),
  });
}

/**
 * Migration body: seed the three first-run leaves (spec
 * `one-minute-onboarding` §7) on an `onboarding` block that predates them:
 * `firstRunPath`, `welcomeEntryId` and `priorRuntime`.
 *
 * `onboarding` is a section every stored config already carries, and conf's
 * pre-write merge is SHALLOW, so this body is the only thing that puts the
 * leaves on the file; see "Which of these bodies is a real no-op" above
 * {@link CONFIG_MIGRATIONS}.
 *
 * **Each seeds `null`.** An install that already onboarded never picked a
 * first-run path, posted no first-run welcome, and had no runtime to undo to.
 * Absence is tested with `in`, per leaf, for the reason
 * {@link seedWorkingHoursDefaults} gives.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedFirstRunOnboardingLeaves(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const onboarding = store.get('onboarding');
  if (onboarding == null || typeof onboarding !== 'object') return;
  const current = onboarding as Record<string, unknown>;
  const leaves = ['firstRunPath', 'welcomeEntryId', 'priorRuntime'].filter((l) => !(l in current));
  if (leaves.length > 0)
    store.set('onboarding', { ...current, ...Object.fromEntries(leaves.map((l) => [l, null])) });
}

/** Seed a new runtime without choosing a model or changing existing runtimes. */
export function seedDoeRuntime(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('runtimes.doe') === undefined)
    store.set('runtimes.doe', { enabled: true, inference: null, defaultTrustStop: null });
  if (store.get('runtimes.environment.inherit.doe') === undefined)
    store.set('runtimes.environment.inherit.doe', []);
}

/**
 * Seed `ui.panelTabs` (spec `mini-app-placement`): where each mini app's
 * right-panel tab shows. An empty list, so every tab keeps following its mini
 * app's own default, which is where it already showed.
 *
 * A nested leaf in a section every stored config already has, so nothing else
 * writes it to disk (conf's top-level merge is shallow). Idempotent: a list
 * already there, or any value a person or agent wrote, is left alone.
 *
 * @param store - The conf store, narrowed to what this body reads and writes.
 */
export function seedUiPanelTabs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object' || Array.isArray(ui) || 'panelTabs' in ui) return;
  store.set('ui', { ...ui, panelTabs: [] });
}

/**
 * Migration body: seed `runtimes.doe.defaultModel: null` (DOR-2784) — the
 * model new DorkOS chats prefer on credits; `null` means DorkOS picks.
 *
 * **The mechanism, not an anchor**: a nested leaf inside `runtimes.doe`, which
 * the `'0.101.0'` key already wrote without it, and conf's pre-migration merge
 * is shallow. Absence is tested with `in`, so a stored `null` or a person's
 * pick is never rewritten on a corrupt-recovery re-run.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function seedDoeDefaultModel(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const doe = store.get('runtimes.doe');
  if (doe == null || typeof doe !== 'object' || 'defaultModel' in doe) return;
  store.set('runtimes.doe', { ...doe, defaultModel: null });
}

/**
 * Seed `server.lanAccess` as off where the stored `server` section lacks it.
 *
 * `server` is a section every stored config already carries, and conf's
 * pre-migration merge is shallow, so a stored `server` object wins wholesale
 * and never gains a new member on its own. This body is the only thing that
 * writes the leaf to disk. It never touches a value already there, so a person
 * who turned the switch on keeps it on, and running it twice changes nothing.
 *
 * @param store - The conf store, narrowed to the two calls this needs.
 */
export function seedLanAccess(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const server = store.get('server');
  if (server === null || typeof server !== 'object' || Array.isArray(server)) return;
  if ('lanAccess' in server) return;
  store.set('server', { ...server, lanAccess: false });
}

/**
 * Seed `runtimes.claudeCode.maxWarmProcesses` as `null` (sized to the machine)
 * where the stored `runtimes.claudeCode` section lacks it (DOR-3012).
 *
 * A nested leaf inside a section every config that ran a Claude Code chat
 * already carries, and conf's pre-migration merge is shallow, so this body is
 * the only thing that writes it to disk. Absence is tested with `in`, so a
 * number a person chose is never rewritten, and running it twice changes
 * nothing.
 *
 * @param store - The conf store, narrowed to the two calls this needs.
 */
export function seedMaxWarmProcesses(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const claudeCode = store.get('runtimes.claudeCode');
  if (claudeCode === null || typeof claudeCode !== 'object' || Array.isArray(claudeCode)) return;
  if ('maxWarmProcesses' in claudeCode) return;
  store.set('runtimes.claudeCode', { ...claudeCode, maxWarmProcesses: null });
}

/**
 * Raise the engaged window from the old shipped defaults to the new ones
 * (DOR-2823): 10 minutes to 60, and 5 messages to 15.
 *
 * Only a value still AT the old default, or missing, moves. A person who chose
 * a number, including the operator's own stopgap of 60 and 15, keeps it. A
 * stored `10` cannot say whether somebody chose it, and the old default is the
 * far likelier reading: the setting has no UI. Missing is filled because a
 * stored `rooms` block never inherits a new leaf from conf's shallow defaults.
 *
 * @param store - The conf store.
 */
export function raiseEngagedWindowDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  if (store.get('rooms') === undefined) return;
  const minutes = store.get('rooms.engagedWindowMinutes');
  if (minutes === 10 || minutes === undefined) store.set('rooms.engagedWindowMinutes', 60);
  const posts = store.get('rooms.engagedWindowPosts');
  if (posts === 5 || posts === undefined) store.set('rooms.engagedWindowPosts', 15);
}

/**
 * The one registered Claude account the `'0.124.1'` migration keeps out of
 * automatic moves (Re-seat P0, Security's review). Named only here: everything
 * else reads the flag the migration writes, never this id.
 */
const KEPT_FROM_AUTO_MOVES_ACCOUNT_ID = 'claude-ab1';

/**
 * Migration body: keep one registered Claude account out of automatic moves,
 * by setting `noAutoMove: true` on its row (Re-seat P0).
 *
 * A tightening, and a narrow one. It touches only the first row whose id is
 * {@link KEPT_FROM_AUTO_MOVES_ACCOUNT_ID} (the row every reader lists), and
 * only when that row carries no `noAutoMove` at all, so a choice already
 * written is never overwritten and running it twice changes nothing. Every
 * other row, and every other member of that row, is kept as stored. A config
 * with no such row is left alone.
 *
 * Writes the whole `runtimes` section, as `seedAccountProjectRules` does. The
 * permission-history line this owes is written at the first boot after, once
 * the Activity service exists (`permissions/kept-from-auto-moves.ts`).
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function keepAccountOutOfAutoMoves(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (!runtimes || typeof runtimes !== 'object' || Array.isArray(runtimes)) return;
  const block = (runtimes as Record<string, unknown>).claudeCode;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return;
  const accounts = (block as Record<string, unknown>).accounts;
  if (!Array.isArray(accounts)) return;
  const index = accounts.findIndex(
    (row: unknown) =>
      !!row &&
      typeof row === 'object' &&
      (row as Record<string, unknown>).id === KEPT_FROM_AUTO_MOVES_ACCOUNT_ID
  );
  if (index === -1 || 'noAutoMove' in (accounts[index] as Record<string, unknown>)) return;
  const rows = accounts.map((row: unknown, at: number) =>
    at === index ? { ...(row as Record<string, unknown>), noAutoMove: true } : row
  );
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { ...(block as Record<string, unknown>), accounts: rows },
  });
}

/**
 * Seed `ui.dmView: false` and `ui.showSessions: false` where the stored `ui`
 * section lacks them (DOR-3074).
 *
 * Two nested leaves inside a section every stored config already carries, and
 * conf's pre-migration merge is shallow, so this body is the only thing that
 * writes them to disk. Absence is tested with `in`, so a choice a person made is
 * never rewritten, and running it twice changes nothing.
 *
 * @param store - The conf store, narrowed to the two calls this needs.
 */
export function seedUiDmViewLeaves(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (ui === null || typeof ui !== 'object' || Array.isArray(ui)) return;
  if ('dmView' in ui && 'showSessions' in ui) return;
  store.set('ui', {
    ...ui,
    ...(!('dmView' in ui) && { dmView: false }),
    ...(!('showSessions' in ui) && { showSessions: false }),
  });
}
