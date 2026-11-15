/**
 * Config migration helpers for the keys from `0.57.0` through `0.59.0`: the
 * large `0.57.0` composite (approvals, rooms, runtimes, trust stops, sidebar
 * members) and the `0.59.0` sidebar, composer and welcome-back changes.
 *
 * Each helper is a body that a key in `CONFIG_MIGRATIONS` (`./index.ts`)
 * calls, moved here verbatim from `config-manager.ts`. A body is frozen once
 * it merges: see `./index.ts` for the rules, and `contributing/configuration.md`
 * → Schema Migrations for the process.
 *
 * @module services/core/config-migrations/v0-57-to-v0-59
 */
import { ComposerPrefsSchema, toSidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';

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
 * Migration body: backfill the `approvals` section (standing permissions,
 * DOR-501) for configs persisted before it existed. Additive + idempotent: only
 * writes when the key is absent.
 *
 * **The two branches have different standing, so do not read one verdict over
 * both.** The whole-section branch is a genuine anchor for the reason
 * {@link backfillProfileDefaults} spells out — `approvals` is TOP-LEVEL, conf
 * writes its merged `defaults` to the file before the first migration key runs,
 * and the section lands there whether or not this body exists. The second
 * branch is not: it adds a nested LEAF to an `approvals` object that is already
 * on the file, which that merge never reaches, so it is the only thing that
 * writes `standingGrantsVoidBefore` down (measured, DOR-1496).
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
 * Migration body: backfill `ui.composer: { richText: true }` onto an EXISTING
 * `ui` block (the message box's formatting preference, DOR-948). conf merges
 * top-level defaults SHALLOWLY, so a `ui` object already on disk never inherits
 * a newly-added nested section; the whole-`ui`-absent case needs nothing,
 * because the shallow merge brings in the default `ui` with this section already
 * in it. Same shape and same reasoning as {@link migrateStatusBarToPins}.
 *
 * Seeds `true`, matching the schema default — chat formats as you type, and the
 * Settings → Preferences switch turns it off.
 *
 * ## This body was EDITED after merging, and that was a mistake
 *
 * It originally seeded `false`, because that was the shipped default. The owner
 * flipped the default on 2026-08-12 and this body was rewritten in place, on the
 * reasoning that `0.59.0` had not been tagged yet, so it had run for nobody and
 * only development trees could have executed the `false` version.
 *
 * That reasoning was wrong (DOR-1222). A tag is not what runs a migration —
 * `projectVersion` is, and it is `SERVER_VERSION`: the version compiled into a
 * built CLI bundle or the desktop app, bumped in the repository before the tag
 * exists. The operator's own config was stamped `0.59.0` that same day, so his
 * machine ran whichever version of this body was on disk at that moment and will
 * never run this key again. Nothing here can reach him now.
 *
 * The rule the next change follows: a merged body is append-only, and a change
 * of default opens a NEW key above the newest tag, written so it can tell a
 * value this body seeded from one a person chose.
 * `__tests__/merged-migration-hashes.ts` fails the build if this body moves.
 *
 * Additive + idempotent: an existing `ui.composer` object is left exactly as it
 * stands, so re-running (corrupt-recovery, a hand-edited migration version)
 * never overwrites a choice somebody made.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillComposerPrefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;

  // The SCHEMA decides whether what is on disk is a `ComposerPrefs`, not
  // `typeof`. `typeof [] === 'object'`, so an on-disk `ui.composer: []` — or a
  // half-written object — would otherwise be left exactly where it is, and
  // conf's Ajv would condemn the whole config file on the next boot rather than
  // just this section (the DOR-584 lesson). Anything the schema rejects is
  // replaced with the shipped default; anything it accepts is left untouched,
  // which is what keeps this idempotent and keeps a person's `true` safe.
  //
  // `.strict()` because the generated JSON Schema for this object is
  // `additionalProperties: false` (verified, not assumed). A plain `safeParse`
  // would ACCEPT `{ rich: 'yes' }` — Zod strips unknown keys and fills the
  // default — and leave on disk exactly the shape Ajv is about to reject. The
  // check has to agree with the validator it is protecting against.
  const composer = (ui as { composer?: unknown }).composer;
  if (ComposerPrefsSchema.strict().safeParse(composer).success) return;

  store.set('ui', { ...(ui as Record<string, unknown>), composer: { richText: true } });
}

/**
 * Migration body: backfill `ui.autonomyAcknowledgedAt: null` onto an EXISTING
 * `ui` block (the standing Full-autonomy acknowledgement; spec `trust-dial`,
 * decision 5). conf merges top-level defaults SHALLOWLY, so a `ui` object
 * already on disk never inherits a newly-added nested key; the whole-`ui`-absent
 * case needs nothing, because the shallow merge brings in the default `ui` with
 * this key already in it.
 *
 * Seeds `null` — nobody has acknowledged anything. That direction is the whole
 * point: an upgrade must never hand out a consent nobody gave, so every
 * upgrading install sees the dialog the first time it reaches for Full autonomy,
 * exactly as a fresh one does.
 *
 * Additive + idempotent: an existing value, including one somebody has already
 * cleared back to `null`, is left exactly as it stands.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillAutonomyAcknowledgement(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  if ('autonomyAcknowledgedAt' in (ui as Record<string, unknown>)) return;
  store.set('ui', { ...(ui as Record<string, unknown>), autonomyAcknowledgedAt: null });
}

/**
 * Migration body: backfill the three room-section collapse flags onto an
 * EXISTING `ui.sidebar` — `channelsCollapsed` and `dmsCollapsed` (rooms sidebar,
 * DOR-525) and `threadsCollapsed` (the Threads section, room-messaging-design
 * §3), all `false`. conf merges top-level defaults SHALLOWLY, so a `ui.sidebar`
 * already on disk never inherits new nested fields on its own; this supplies
 * them. Additive + idempotent: only writes a field that is actually missing.
 *
 * `threadsCollapsed` joins the same unreleased key rather than taking one of
 * its own: it is the identical backfill on the identical object, and a second
 * function would run a second write for the same reason.
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
  if (
    s.channelsCollapsed !== undefined &&
    s.dmsCollapsed !== undefined &&
    s.threadsCollapsed !== undefined
  ) {
    return;
  }

  store.set('ui', {
    ...(ui as Record<string, unknown>),
    sidebar: {
      ...s,
      channelsCollapsed: s.channelsCollapsed ?? false,
      dmsCollapsed: s.dmsCollapsed ?? false,
      threadsCollapsed: s.threadsCollapsed ?? false,
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
    collectDebounceMs: 500,
    collectMaxEntries: 20,
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
 * Migration body: backfill the `welcomeBack` section (what agents may say when
 * you come back after being away; spec `team-room-home`, D5.2) for configs
 * persisted before it existed.
 *
 * Additive + idempotent: writes the whole section when it is absent, and fills
 * only the individual keys that are missing when it is present. conf merges
 * top-level defaults SHALLOWLY, so a `welcomeBack` block already on disk — from
 * an unreleased build, or from a later key being added to it — never inherits a
 * new nested field on its own. Filling here is what stops a return running with
 * no post cap at all — and, since DOR-1046, with no answer at all to whether a
 * greeting may spend a model turn on a next-step offer.
 *
 * `offersEnabled` seeds `true` (DOR-1121, reversing the `false` this key was
 * first written with hours earlier under DOR-1046). It is the one leaf in this
 * block that costs money, so the direction is a real decision rather than a
 * default falling out of a schema, and it was taken deliberately: an offer is
 * the part of coming back that is worth reading, and a switch nobody finds is a
 * feature nobody has. The spend it says yes to is bounded by `maxPosts` — at
 * most one turn each for the agents already allowed to speak — the switch beside
 * it names that cost in words, and the release notes say it changed.
 *
 * Seeding the SHIPPED value is also what keeps an upgraded install honest: every
 * other leaf here is filled with what a fresh install gets, and seeding `false`
 * under a schema that now defaults `true` would leave upgraded installs silently
 * different from new ones forever, with nothing on any surface saying why.
 *
 * What it must never do is override a person, and the `=== undefined` fill is
 * exactly that guarantee, in both directions: somebody who turned offers ON
 * keeps them, and somebody who turned offers OFF keeps that too — an explicit
 * `false` is a value, not an absence, so this never writes over it.
 *
 * The flip itself was made by EDITING this body inside `'0.59.0'` rather than
 * appending a key, on the reasoning that the key was still untagged and so had
 * run for nobody. That reasoning was wrong (DOR-1222): `projectVersion` comes
 * from `SERVER_VERSION`, which a built CLI or the desktop app carries before any
 * tag exists, and the operator's own config was stamped `0.59.0` on the day of
 * the flip. Anyone in that position kept the seeded `false` this body no longer
 * writes, and nothing here reaches them.
 *
 * The half of the argument that was sound stands, and is why the fix is not a
 * later key that re-seeds `true`: such a key could not tell a seeded `false`
 * from a chosen one, and would take the choice away from whoever had made it. A
 * correcting migration has to distinguish the two states — which is exactly the
 * bar the append-only rule sets, and the reason a change of mind is harder to
 * write than an edit and should be.
 *
 * Nothing depends on this having run: every leaf carries a Zod default, so an
 * install that skips the migration (a dev tree resolves `SERVER_VERSION` to
 * `0.0.0` and runs none of them) still reads the same shipped values.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillWelcomeBackDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const seeded = {
    enabled: true,
    absenceThresholdMinutes: 240,
    maxPosts: 3,
    offersEnabled: true,
  };
  const stored = store.get('welcomeBack');
  if (stored == null || typeof stored !== 'object') {
    store.set('welcomeBack', seeded);
    return;
  }
  const current = { ...(stored as Record<string, unknown>) };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (current[key] === undefined) {
      current[key] = value;
      changed = true;
    }
  }
  if (changed) store.set('welcomeBack', current);
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
   * through. Delegates to the shared {@link toSidebarItemRef}, which is the one
   * statement of what a stored string means.
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
 * The suggestion id the "group your agents" hint card became when Getting
 * started absorbed it (`specs/sidebar-now-today-library` §B). A person who
 * dismissed the card has already answered that suggestion, so the migration
 * records the dismissal as a retirement rather than asking again.
 */
export const GROUPS_HINT_SUGGESTION_ID = 'suggestion:groups-hint';

/**
 * The eight `ui.sidebar` keys the sidebar redesign retired, paired with the
 * section id each collapse flag becomes. Named once so the migration, the Ajv
 * tolerance below and the tests all read the same list.
 */
const RETIRED_SIDEBAR_COLLAPSE_KEYS = {
  ungroupedCollapsed: 'agents',
  channelsCollapsed: 'channels',
  dmsCollapsed: 'dms',
  threadsCollapsed: 'threads',
  recentsCollapsed: 'recents',
} as const;

/** Every key {@link migrateSidebarSectionPrefs} removes, collapse flags included. */
const RETIRED_SIDEBAR_KEYS = [
  ...Object.keys(RETIRED_SIDEBAR_COLLAPSE_KEYS),
  'ungroupedSortMode',
  'ungroupedDisplayFilter',
  'groupsHintDismissed',
] as const;

/**
 * Migration body: move the sidebar's seven per-section flags into the
 * `ui.sidebar.sections` record, translate the groups-hint dismissal into a
 * retired Getting-started suggestion, and delete all eight retired keys
 * (`specs/sidebar-now-today-library` §D, the table there is authoritative).
 *
 * | Retired key                | Becomes                                       |
 * | -------------------------- | --------------------------------------------- |
 * | `ungroupedCollapsed`       | `sections.agents.collapsed`                   |
 * | `channelsCollapsed`        | `sections.channels.collapsed`                 |
 * | `dmsCollapsed`             | `sections.dms.collapsed`                      |
 * | `threadsCollapsed`         | `sections.threads.collapsed`                  |
 * | `recentsCollapsed`         | `sections.recents.collapsed`                  |
 * | `ungroupedSortMode`        | `sections.agents.sortMode`                    |
 * | `ungroupedDisplayFilter`   | `sections.agents.displayFilter`               |
 * | `groupsHintDismissed: true`| `gettingStarted.retired += 'suggestion:…'`    |
 *
 * `pinned`, `groups` and `muted` are not touched at all. They are the person's
 * own manual structure, and the programme's promise is that it never moves.
 *
 * **A stored value equal to its old default is not carried across**, because on
 * both sides of this migration an absent key and the default mean the same
 * thing: `collapsed` reads `false` when the section is absent, and the Agents
 * section's sort and filter fall back to `name` / `all`. Copying them would
 * write a block of defaults into every config on earth to say nothing. What a
 * person actually changed is what moves.
 *
 * **Anything already in `sections` wins.** Someone who ran this, downgraded and
 * upgraded again has a `sections` record built from choices made SINCE the
 * retired flags were last written, so a stale flag must not overwrite it.
 *
 * Idempotent by construction: the whole body is gated on at least one retired
 * key still being present, and the run that carries them across is also the run
 * that deletes them — so a second run finds nothing and writes nothing.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function migrateSidebarSectionPrefs(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const ui = store.get('ui');
  if (!ui || typeof ui !== 'object') return;
  const sidebar = (ui as { sidebar?: unknown }).sidebar;
  if (!sidebar || typeof sidebar !== 'object') return;

  const s = sidebar as Record<string, unknown>;
  if (!RETIRED_SIDEBAR_KEYS.some((key) => key in s)) return;

  const storedSections = s.sections;
  const sections: Record<string, Record<string, unknown>> = storedSections &&
  typeof storedSections === 'object' &&
  !Array.isArray(storedSections)
    ? Object.fromEntries(
        Object.entries(storedSections as Record<string, unknown>).map(([id, value]) => [
          id,
          value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as Record<string, unknown>) }
            : {},
        ])
      )
    : {};

  /** Write one section field, unless the section already answers for it. */
  const carry = (id: string, field: string, value: unknown): void => {
    const section = (sections[id] ??= {});
    if (field in section) return;
    section[field] = value;
  };

  for (const [flag, id] of Object.entries(RETIRED_SIDEBAR_COLLAPSE_KEYS)) {
    if (s[flag] === true) carry(id, 'collapsed', true);
  }
  if (s.ungroupedSortMode === 'recent') carry('agents', 'sortMode', 'recent');
  if (s.ungroupedDisplayFilter === 'active' || s.ungroupedDisplayFilter === 'attention') {
    carry('agents', 'displayFilter', s.ungroupedDisplayFilter);
  }
  // `carry` seeds an empty object for a section it is asked about; drop any that
  // ended up with nothing to say rather than persisting `{}`.
  for (const [id, section] of Object.entries(sections)) {
    if (Object.keys(section).length === 0) delete sections[id];
  }

  const storedGettingStarted = s.gettingStarted;
  const retired =
    storedGettingStarted &&
    typeof storedGettingStarted === 'object' &&
    Array.isArray((storedGettingStarted as { retired?: unknown }).retired)
      ? [...((storedGettingStarted as { retired: unknown[] }).retired as unknown[])]
      : [];
  if (s.groupsHintDismissed === true && !retired.includes(GROUPS_HINT_SUGGESTION_ID)) {
    retired.push(GROUPS_HINT_SUGGESTION_ID);
  }

  const next: Record<string, unknown> = { ...s, sections, gettingStarted: { retired } };
  for (const key of RETIRED_SIDEBAR_KEYS) delete next[key];

  store.set('ui', { ...(ui as Record<string, unknown>), sidebar: next });
}

/**
 * Migration body: backfill the `profile` section (who the user is — roles,
 * tools, display name; spec `user-profile-onboarding`) for configs persisted
 * before it existed. Additive + idempotent: only writes when the key is absent.
 *
 * A genuine no-op anchor, and it is worth saying WHY, because the same sentence
 * was copied onto bodies where it is false (see {@link backfillPromoDismissals}).
 * `profile` is a whole TOP-LEVEL section. Before conf runs a single migration key
 * it merges `defaults` under the parsed file and WRITES the result when the two
 * differ, so a section the file has never carried lands on disk whatever this
 * table says. That is a file write, not Ajv's read-time fill — the distinction
 * that decides whether a body like this can be deleted. Seeds everything
 * empty/null: DorkOS knows nothing about the person until they say.
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
 * Migration body: backfill `runtimes.claudeCode` — which Claude account new
 * sessions run and bill on, and the accounts DorkOS knows about (spec
 * `claude-code-accounts` D1) — onto an EXISTING `runtimes` block.
 *
 * conf merges top-level defaults SHALLOWLY, so a `runtimes` object already on
 * disk never inherits a newly-added nested section on its own, and every install
 * upgraded past the `0.45.0` backfill has one. Ajv does fill the key in at READ
 * time, and that fill is never written back: conf's `store` getter re-reads the
 * file, validates the object it just parsed, and returns it, so `useDefaults`
 * only ever decorates a copy on its way out the door. This body is therefore the
 * one thing that puts the section on disk — NOT the no-op-anchor role
 * {@link backfillProfileDefaults} plays, which holds only because `profile` is a
 * whole top-level section and this is a nested one.
 *
 * Additive + idempotent: only writes when `claudeCode` is absent, and never
 * touches `default`, `opencode` or `codex`. The whole-`runtimes`-absent case
 * belongs to the schema default on read plus {@link backfillRuntimesDefaults}.
 *
 * Seeds `{ activeAccount: null, accounts: [] }` — no account chosen and none
 * registered, which is byte-for-byte the behavior before the field existed: the
 * inherited `$CLAUDE_CONFIG_DIR`, else `~/.claude`. An upgrade therefore never
 * moves anybody's work onto a different account.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillClaudeCodeRuntimeDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  if ('claudeCode' in runtimes) return;
  store.set('runtimes', {
    ...(runtimes as Record<string, unknown>),
    claudeCode: { activeAccount: null, accounts: [] },
  });
}

/**
 * @internal Exported for testing only — lets the migration-key invariant test
 * assert the newest key is always ahead of the current release (the DOR-339
 * "0.54.0 shipped mid-flight" class of bug: a key equal to or behind an
 * already-tagged version is silently excluded by conf's `(storedVersion,
 * projectVersion]` window, so it never runs for upgrading users).
 */
/**
 * Migration body: backfill the per-runtime execution defaults
 * (`defaultModel` on all three runtime sections, `defaultEffort` on claude-code
 * and codex only) onto `runtimes` blocks already on disk.
 *
 * Needed for the same reason {@link backfillClaudeCodeRuntimeDefaults} is:
 * conf's defaults-merge is SHALLOW, so an existing `runtimes.claudeCode` object
 * never gains a new nested key from the schema default alone.
 *
 * Additive + idempotent — each leaf is written only when absent, and every value
 * is `null`, which means "let the runtime choose". An upgrade therefore starts
 * nobody's sessions on a model they did not pick.
 *
 * OpenCode deliberately gets `defaultModel` and no `defaultEffort`: its prompt API
 * accepts no effort, so the field would be a setting that does nothing.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillRuntimeExecutionDefaults(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;

  /** Add the named leaves to one runtime section, leaving anything already set alone. */
  const seed = (section: string, leaves: readonly string[]): Record<string, unknown> | null => {
    const value = current[section];
    if (value == null || typeof value !== 'object') return null;
    const block = value as Record<string, unknown>;
    const missing = leaves.filter((leaf) => !(leaf in block));
    if (missing.length === 0) return null;
    return { ...block, ...Object.fromEntries(missing.map((leaf) => [leaf, null])) };
  };

  const claudeCode = seed('claudeCode', ['defaultModel', 'defaultEffort']);
  const codex = seed('codex', ['defaultModel', 'defaultEffort']);
  const opencode = seed('opencode', ['defaultModel']);
  if (!claudeCode && !codex && !opencode) return;

  store.set('runtimes', {
    ...current,
    ...(claudeCode ? { claudeCode } : {}),
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
  });
}

/**
 * Migration body: backfill the default-trust-stop leaves — the global
 * `runtimes.defaultTrustStop` and the per-runtime override on each of the three
 * runtime sections (spec `trust-dial`, decision 6).
 *
 * Needed for the same reason {@link backfillRuntimeExecutionDefaults} is: conf's
 * defaults-merge is SHALLOW, so a `runtimes` block already on disk never gains a
 * new key — nested or top-level — from the schema default alone.
 *
 * Additive + idempotent: every leaf is written only when absent, and every value
 * is `null`, which means "let the runtime decide". An upgrade therefore never
 * moves anybody's new sessions to a stop they did not choose, least of all the
 * one that stops asking.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillDefaultTrustStops(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;

  /** The section object with `defaultTrustStop: null` added, or null when it already has one. */
  const seed = (section: string): Record<string, unknown> | null => {
    const value = current[section];
    if (value == null || typeof value !== 'object') return null;
    const block = value as Record<string, unknown>;
    if ('defaultTrustStop' in block) return null;
    return { ...block, defaultTrustStop: null };
  };

  const claudeCode = seed('claudeCode');
  const codex = seed('codex');
  const opencode = seed('opencode');
  const global = 'defaultTrustStop' in current ? null : { defaultTrustStop: null };
  if (!claudeCode && !codex && !opencode && !global) return;

  store.set('runtimes', {
    ...current,
    ...(global ?? {}),
    ...(claudeCode ? { claudeCode } : {}),
    ...(codex ? { codex } : {}),
    ...(opencode ? { opencode } : {}),
  });
}

/**
 * Migration body: backfill `runtimes.claudeCode.persistentSession: false` onto a
 * `runtimes.claudeCode` block already on disk (whether a Claude Code chat keeps
 * its agent running between messages; spec `persistent-session-runtime` §P3,
 * DOR-1173).
 *
 * Needed for the same reason {@link backfillRuntimeExecutionDefaults} is: conf's
 * defaults-merge is SHALLOW, so a `runtimes.claudeCode` object already on disk
 * never gains a newly-added nested key from the schema default alone.
 *
 * This docblock used to go on to call the body an ANCHOR — something Ajv's
 * `useDefaults` would do anyway, kept only so the intent stays reviewable. That
 * was wrong, and measuring it is what settled it (DOR-1496): suppress this body
 * and `persistentSession` never reaches the file at all. Ajv does fill the leaf
 * during validation, but the object it fills is the throwaway copy conf's
 * `store` getter built from a fresh read and is about to hand back — the getter
 * re-reads and re-validates on EVERY access, and writes nothing. This body is
 * the only thing that puts the leaf on disk, so an upgrade-boot test for it has
 * to read `config.json` rather than call `get`. See "Which of these bodies is a
 * real no-op, and which only looks like one" above `CONFIG_MIGRATIONS`.
 *
 * Seeds `false`, so an upgrade leaves every chat running exactly the way it runs
 * today — one process per message. Turning it on is the operator's choice.
 *
 * Additive + idempotent: the leaf is written only when absent, so re-running
 * (corrupt-recovery, a hand-edited migration version) never flips somebody's
 * `true` back off.
 *
 * @internal Exported for testing only.
 * @param store - The `conf` store instance (provides `get`/`set`).
 */
export function backfillClaudeCodePersistentSession(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const runtimes = store.get('runtimes');
  if (runtimes == null || typeof runtimes !== 'object') return;
  const current = runtimes as Record<string, unknown>;

  const claudeCode = current.claudeCode;
  if (claudeCode == null || typeof claudeCode !== 'object') return;
  const block = claudeCode as Record<string, unknown>;
  if ('persistentSession' in block) return;

  store.set('runtimes', {
    ...current,
    claudeCode: { ...block, persistentSession: false },
  });
}

// Also read by the Ajv tolerance in `config-manager.ts`, so the migration and
// the tolerance retire the same list. Exported apart from its declaration so the
// declaration stays exactly as the migration guards pinned it.
export { RETIRED_SIDEBAR_COLLAPSE_KEYS };
