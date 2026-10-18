/**
 * The `conf` migration table, `CONFIG_MIGRATIONS`, and the one place a new
 * migration key is added. The helpers its keys call live beside it, grouped by
 * the version range of the key that first calls them; a helper for a new key
 * goes in `v0-90-onward.ts`. `config-manager.ts` hands this table to `conf`
 * and re-exports everything in this folder, so callers import from there.
 *
 * @module services/core/config-migrations
 */
import {
  backfillExtensionsDisabled,
  backfillWorkspaceDefaults,
  backfillHarnessDefaults,
  backfillRuntimesDefaults,
  backfillAuthDefaults,
  dropTunnelPasscodeAndSessionSecret,
  backfillCloudDefaults,
  backfillWorkbenchDefaults,
  backfillProvidersDefaults,
  backfillWorkbenchTerminalGraceTtl,
  generalizeTelemetryConsent,
  backfillWorkbenchAutoOpenDiff,
  backfillTelemetryLastPromptedVersion,
  applyTier1OptOutDefaults,
  backfillTelemetryUsageChannel,
  backfillTelemetryLinkAnalyticsToAccount,
  backfillTelemetryAiMetadataChannel,
  backfillSidebarDefaults,
  backfillShapesDefaults,
  backfillSidebarSettingsDefaults,
  backfillSmartGroupKindDefaults,
  scrubRetiredOnboardingSteps,
} from './v0-44-to-v0-56.js';
import {
  backfillExtensionsApprovedToRun,
  backfillHarnessApprovedHooks,
  backfillApprovalsDefaults,
  applyTier1OptInDefaults,
  migrateStatusBarToPins,
  backfillComposerPrefs,
  backfillAutonomyAcknowledgement,
  backfillSidebarRoomSections,
  backfillConnectorsDefaults,
  backfillRoomsDefaults,
  backfillWelcomeBackDefaults,
  migrateSidebarMembersToItemRefs,
  migrateSidebarSectionPrefs,
  backfillProfileDefaults,
  backfillClaudeCodeRuntimeDefaults,
  backfillRuntimeExecutionDefaults,
  backfillDefaultTrustStops,
  backfillClaudeCodePersistentSession,
} from './v0-57-to-v0-59.js';
import {
  seedExtensionsApprovedSources,
  dropSchedulerTimezone,
  raiseRoomTurnLimits,
  seedA2aDisabled,
  backfillPromoDismissals,
  backfillNotificationDefaults,
  migrateClaudeAccountRegistry,
  renameReservedClaudeAccountIds,
  seedFullPowerDecision,
  raiseSchedulerConcurrencyFloor,
  warmClaudeCodeSessionsByDefault,
  seedMemoryProviderDefault,
  seedRoomRepoDefaults,
  dropRetiredDorkosTools,
  retireToolOnlyReplies,
  seedDisplayNameSourceDefault,
  seedIdentityPromptDismissedDefault,
  seedHarnessRefusedHooks,
  seedHarnessGlobal,
  seedHarnessAutoAdopt,
  seedRoomCanvasOps,
  seedMaxConcurrentTurnsPerAgent,
  seedCommunityNavigationPrefs,
  seedPermissionPresetFromDoor,
} from './v0-60-to-v0-89.js';
import {
  seedExtensionsDismissedApprovals,
  seedExtensionsApprovedPermissions,
  seedCodexTransport,
  seedSpacesOfficial,
  seedExtensionsTrustedSources,
  seedCloudCreditsChoices,
  seedCloudRemoteAccess,
  applyTrustedPosture,
  dropAgentTurnCaps,
  dropAutonomyAcknowledgement,
  seedDefaultAccountColor,
  seedAccountProjectRules,
  seedClaudeDismissedFolders,
  seedWorkingHoursDefaults,
  seedFirstRunOnboardingLeaves,
  seedDoeRuntime,
  seedUiPanelTabs,
  seedDoeDefaultModel,
  seedLanAccess,
  seedMaxWarmProcesses,
  raiseEngagedWindowDefaults,
} from './v0-90-onward.js';

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
/**
 * The `conf` migration chain, keyed by the app version each entry ships in.
 *
 * ## Where a new migration goes
 *
 * Under a NEW key strictly greater than the newest `v*` tag in the repository
 * (`git tag -l 'v*' | sort -V | tail -1`). Nothing else is safe, for one reason:
 * `conf` runs a key only when `storedVersion < key <= projectVersion`. So a key
 * at or below a version that already shipped is skipped for everybody already on
 * it — no error, no warning, the backfill simply never happens (DOR-339).
 *
 * Three things follow, and all three have been got wrong here before:
 *
 * - **Never append to a key that has shipped.** The key being present is not the
 *   point; the BODY is what runs. Appending to an already-tagged composite key
 *   ships dead code that looks alive (DOR-988).
 * - **Never edit a shipped migration body.** Everyone who upgraded past it ran
 *   the old body, and no re-run is coming. Write a new, idempotent entry that
 *   corrects the state instead.
 * - **A body is frozen from the moment it MERGES, not from the moment it is
 *   tagged.** This one reads like a technicality and is not (DOR-1222). See
 *   below.
 *
 * ## "It is not released yet" is not a licence to edit
 *
 * The table used to carry the opposite rule: a key above the newest tag had run
 * for nobody, so its body could be amended freely. That was false, and it was
 * false on the machine of the person who wrote it. `projectVersion` is
 * `SERVER_VERSION` (`lib/version.ts`), which is the version compiled into a
 * built CLI bundle or the desktop app — and that version is bumped in the
 * repository BEFORE the tag exists. Only a raw dev tree is exempt, because
 * `apps/server/package.json` reads `0.0.0`. So anybody who builds and runs
 * during the merge-to-release window is stamped with the new version, has run
 * whatever the body said that day, and will never run the key again.
 *
 * `'0.59.0'` is the worked example. It was amended in place twice while
 * "unreleased" — `welcomeBack.offersEnabled` OFF to ON, then the composer prefs
 * seed — and the operator's own config had been stamped `0.59.0` on 2026-08-12
 * before either landed. Both amendments skipped him in silence. A change of mind
 * about a merged body opens a NEW key above the newest tag, written so it can
 * tell a value this body seeded from one a person chose.
 *
 * ## Both rules are enforced, and they are enforced differently
 *
 * - `__tests__/migration-safety.ts` compares a shipped key against the newest
 *   release TAG. Its TABLE SLICE must be byte-identical, and byte-identity is
 *   deliberate there: a rule that skipped comments would need a parser deciding
 *   which lines are code, and "an appended line the parser mis-read as a
 *   comment" is the same class of hole it exists to close. The consequence is
 *   that a stale sentence inside a shipped body cannot be corrected in place —
 *   `'0.57.0'` still carries one, pointing at the composition convention this
 *   docblock replaced. Correct that kind of thing HERE, or in the comment
 *   directly above a key (both sit outside every key's slice), not inside the
 *   body. It then follows the key into the code it CALLS and compares that too
 *   (DOR-1135), because most of this table is a composite and comparing the
 *   slice alone was comparing the call rather than what runs: a tamper seeded
 *   into `backfillAutonomyAcknowledgement`, which `'0.57.0'` calls, used to pass
 *   while the identical tamper written inline went red. Helpers are compared
 *   normalized, not byte for byte, so a helper's own prose stays correctable.
 * - `__tests__/migration-append-only.ts` pins a hash per merged key against
 *   `__tests__/merged-migration-hashes.ts`. It covers the same CLOSURE — the
 *   table slice plus every top-level function AND constant in this file the key
 *   reaches, including a list like `RETIRED_SIDEBAR_KEYS` that decides what a
 *   helper does — and it needs no tag, which is what lets it hold inside the
 *   window where no tag exists yet. Both rules read the file through
 *   `__tests__/migration-closure.ts`, and they differ in what they answer to: a
 *   pin is a value in this repository and repinning it is the escape hatch,
 *   while a tag cannot be edited at all.
 *
 * `config-manager.test.ts` runs both over the real repository on every CI run.
 *
 * ## Which of these bodies is a real no-op, and which only looks like one
 *
 * Several bodies below describe themselves as "no-op anchors": the claim is that
 * conf's own defaults would produce the same config, so the body exists to keep
 * the intent reviewable rather than to make the value reachable. That claim is
 * true for exactly one of the two shapes, and the difference is not the one the
 * older comments in this file assumed. Both halves are measured
 * (`config-manager.test.ts`, and the per-migration files beside it), not
 * reasoned from conf's documentation.
 *
 * - **A whole TOP-LEVEL section** (`a2a`, `notifications`, `profile`,
 *   `approvals`) really is covered. Before it runs a single key, conf's
 *   `#runMigrations` builds `Object.assign({}, defaults, fileStore)` and WRITES
 *   it when it differs from the file, so a section the file has never heard of
 *   arrives on disk whatever the table says. Delete such a body and nothing
 *   about the resulting file changes.
 *
 *   Sharper than "redundant", and worth stating because it has a consequence:
 *   such a body is **unreachable**. It guards on absence (`if (store.get('x') ==
 *   null)`), and by the time it runs, the pre-write has already put the section
 *   on the file it is about to read — on the upgrade path and the fresh-install
 *   path alike. The `set` never executes; measured by handing the body a probe
 *   store after a real boot and watching `set` go uncalled. So the value written
 *   in the table is not the value that reaches anybody: if it ever diverged from
 *   the object literal in `USER_CONFIG_DEFAULTS`, the file would silently take
 *   the literal and this table would document an intent that never ran. That is
 *   the defaults-declared-twice trap wearing a migration for a disguise — the
 *   per-field Zod default and the object literal are already two declarations,
 *   and an anchor body is a third that cannot win.
 * - **A nested leaf inside a section the file already has** (`ui.composer`,
 *   `ui.promos`, `runtimes.claudeCode.persistentSession`) is NOT covered, and a
 *   body that seeds one is the only thing that writes it. The merge above is
 *   shallow, so a stored `ui` object wins wholesale and never gains a new
 *   member. Ajv's `useDefaults` does fill the leaf in — but only into the object
 *   `conf`'s `store` GETTER just built: that getter re-reads and re-parses the
 *   file on every access, validates the copy it is about to hand back, and
 *   throws the copy away. A boot that only READS leaves the file sparse. (A
 *   later `set` of any kind does persist the fill, because `Conf.set` assigns
 *   the validated object straight back — see "`config.json` holds the effective
 *   config" in `contributing/configuration.md`. That is a different event from
 *   the upgrade this table is responsible for.)
 *
 * The consequence for tests is sharp enough to state here, because it is what
 * the DOR-1496 audit found: reading such a leaf back through
 * `configManager.get`/`getDot` proves NOTHING about a migration, since the fill
 * happens on the way out. One whole upgrade-boot suite (`ui.composer`) and two
 * further cases (`rooms`' two added leaves, and the `ui.statusBar` composition
 * check inside the approvals full-conf-path test) stayed green with their
 * bodies suppressed, and `ui.promos` had no on-disk case at all. An upgrade-boot
 * test for a nested seed has to read `config.json` itself.
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
  // to v0.44.0 at release time (/system:release). Additive + idempotent.
  //
  // This comment used to add "the schema default also yields `disabled: []` on
  // read, so this just writes the key through" — the no-op-anchor claim. It is
  // wrong here, and measured wrong (DOR-1496): the body writes a nested LEAF
  // into an `extensions` object the file already has, which conf's shallow
  // pre-migration defaults merge never reaches, and Ajv's read-time fill lands
  // in the throwaway copy the `store` getter is about to return. Boot a config
  // carrying `extensions: { enabled: [...] }` with no key running and the file
  // still has no `disabled`. This body is the only thing that writes it. (The
  // whole-`extensions`-absent case IS covered by the merge, and the function's
  // own docblock says so correctly — that is the case this comment confused
  // with the one the key actually serves.) See "Which of these bodies is a real
  // no-op, and which only looks like one" in the docblock above the table.
  '0.44.0': backfillExtensionsDisabled,
  // Everything below shipped together in v0.45.0. Each body was authored on a
  // placeholder "next ascending release" key (0.45.0-0.53.0) while on main, and
  // the keys were collapsed onto the one real release when it was tagged
  // (2026-07-09) — by hand, during that release. Nothing renames a stale key for
  // you, which is why the placeholder convention is retired (see the rule on
  // CONFIG_MIGRATIONS above). Order matters: conf runs entries in insertion order, and
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
  // Both authored under the RETIRED placeholder convention (see the rule on
  // CONFIG_MIGRATIONS above): a "next ascending release" key, on the belief that
  // /system:release would reconcile it at tag time. It does not — it scaffolds a
  // migration for the release version or confirms one already there, and never
  // renames an existing key. Shipped and frozen; recorded, not endorsed. One
  // composite body (an object literal can't repeat the key); order is insertion
  // order and both are idempotent + independent.
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
  // Additive + idempotent; seeds no active Shape. Keyed under the RETIRED
  // placeholder convention (see the rule on CONFIG_MIGRATIONS above), on the
  // belief that /system:release reconciles a stale key at tag time. It does not.
  // Shipped and frozen; recorded, not endorsed.
  '0.52.0': backfillShapesDefaults,
  // Composite: both DOR-339 and DOR-338 targeted "the next unreleased version"
  // while developed concurrently and landed on the same key (0.55.0) — a plain
  // object literal can't repeat a key, so their bodies compose here in insertion
  // order. That composition is a RECORD of the retired convention, not a pattern
  // to copy: composing into a key is only ever safe while it is unreleased, and
  // this one shipped. Concurrent work now opens separate keys above the newest
  // tag (see the rule on CONFIG_MIGRATIONS above). Each body is independent and
  // idempotent.
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
  // all landed before v0.57.0 was tagged, and an object literal cannot repeat a
  // key, so their bodies composed here in insertion order — the same convention
  // as the 0.45.0/0.46.0/0.48.0/0.55.0 composites above. All seven are
  // independent and idempotent.
  //
  // THIS KEY HAS SHIPPED. Do not append a body to it. v0.57.0 is tagged, so
  // every user who upgraded past it already ran what was here at tag time and
  // will never run anything added now — `conf` only runs a key in
  // `(storedVersion, projectVersion]`. Open a NEW key above the newest `v*` tag
  // instead; see the authoring rule on `CONFIG_MIGRATIONS` above.
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
    // `ui.sidebar.channelsCollapsed` / `dmsCollapsed` / `threadsCollapsed` (the
    // Channels, Direct messages and Threads sections; DOR-525 and the room
    // messaging design §3). Additive + idempotent; all seed expanded so an
    // upgrade shows the new sections rather than hiding them.
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
    // `runtimes.claudeCode` (which Claude account new sessions run and bill on;
    // spec claude-code-accounts). Supplies the nested section conf's shallow
    // defaults-merge will not add to a `runtimes` block already on disk.
    // Additive + idempotent; seeds "no account chosen, none registered", which
    // is exactly today's inherit-the-environment behavior.
    backfillClaudeCodeRuntimeDefaults(store);
    // The per-runtime execution defaults (`defaultModel` everywhere,
    // `defaultEffort` on claude-code and codex; spec execution-defaults E1).
    // Runs AFTER the claudeCode backfill above so the section it seeds into
    // exists on every config. Additive + idempotent; every leaf seeds `null`,
    // which is "let the runtime choose" — today's behavior exactly.
    backfillRuntimeExecutionDefaults(store);
    // `ui.autonomyAcknowledgedAt` (the standing Full-autonomy acknowledgement;
    // spec `trust-dial`, decision 5). Additive + idempotent; seeds `null`, so an
    // upgrade never hands out a consent nobody gave and everyone meets the
    // dialog once before their first Full-autonomy session.
    backfillAutonomyAcknowledgement(store);
    // The default trust stops (`runtimes.defaultTrustStop` and the per-runtime
    // override on each section; spec `trust-dial`, decision 6). Runs AFTER the
    // two `runtimes` backfills above so it seeds into the same sections they
    // guarantee exist. Additive + idempotent; every leaf seeds `null`, which
    // leaves each runtime starting new sessions exactly where it does today.
    backfillDefaultTrustStops(store);
  },
  // Opened above v0.58.0, the newest tag at the time, and now shipped in
  // v0.59.0. Several changes landed in the same release window and share it; all
  // are additive + idempotent.
  //
  // READ THE BODY BELOW AS A RECORD, NOT AS A PATTERN. It was amended in place
  // twice after merging — `welcomeBack.offersEnabled` OFF to ON, then the
  // composer prefs seed — each time on the reasoning that an untagged key has run
  // for nobody. That reasoning was false, and the sentences below still stating
  // it are wrong: the operator's own config was stamped `0.59.0` on 2026-08-12,
  // by whatever this key said that day, so every later amendment skipped him
  // (DOR-1222). They cannot be corrected where they stand, because a shipped
  // body is byte-frozen; the correction is here and in the docblock above the
  // table. A merged body is append-only, and `merged-migration-hashes.ts` now
  // holds every key to that.
  //
  // A SECOND stale sentence in the body below, same reason, same remedy. It
  // calls `backfillComposerPrefs` "a no-op anchor in the same sense
  // `backfillProfileDefaults` is", on the grounds that Ajv's `useDefaults`
  // writes the declared default into a stored `ui` block. It does not.
  // `profile` is a whole top-level section, which conf's pre-migration defaults
  // merge really does write to the file; `ui.composer` is a leaf inside a `ui`
  // object the file already has, which that shallow merge never touches, and
  // Ajv's fill lands only in the throwaway copy conf's `store` getter is about
  // to hand back. Suppress this body and `ui.composer` reaches nobody's
  // `config.json` — measured that way in DOR-1496. The body is the mechanism,
  // not an anchor. See "Which of these bodies is a real no-op, and which only
  // looks like one" in the docblock above the table.
  '0.59.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // The `welcomeBack` section (what agents may say when you come back after
    // being away; spec `team-room-home`, D5.2). Seeds the shipped defaults, so
    // an upgraded install gets the same caps a fresh one does — including
    // `offersEnabled` (DOR-1046), which is folded into this key rather than
    // given one of its own for the reason the sidebar body below states: it
    // ships in this same still-unreleased window (`v0.58.0` is the newest tag),
    // so a key above it would be one more version boundary for a leaf that has
    // never reached a single install.
    //
    // That leaf now seeds ON (DOR-1121), reversing the OFF this key carried for
    // a few hours. Amending an unreleased body is the whole reason the reversal
    // can be clean: nobody has run it, so nothing has a seeded `false` on disk,
    // and the fill-if-absent rule keeps an OFF somebody chose. A second key
    // re-seeding `true` could not tell those two apart and would spend money for
    // somebody who had said no — see the body's docs.
    backfillWelcomeBackDefaults(store);
    // `ui.composer` (whether the message box shows formatting as you type,
    // DOR-948). Added-with-defaults, so this is a no-op anchor in the same sense
    // `backfillProfileDefaults` is: conf builds Ajv with `useDefaults`, so the
    // declared default is written into a stored `ui` block during validation
    // whether or not this runs. It writes the section through on the upgrade
    // where it lands, which keeps the intent — seeded ON, the owner's
    // 2026-08-12 call — reviewable in the table rather than implicit in a schema
    // default. The body used to seed OFF and was edited in place rather than
    // superseded, which is only sound while this key is unreleased; see the
    // body's docs for the condition. Additive + idempotent.
    backfillComposerPrefs(store);
    // Move the sidebar's seven per-section flags into `ui.sidebar.sections`,
    // record a dismissed groups hint as a retired Getting-started suggestion,
    // and delete all eight retired keys (spec `sidebar-now-today-library` §D).
    // Composed into this still-unreleased key rather than a fresh one above it
    // BECAUSE the schema that removes those keys ships in this same release: a
    // key of its own would leave everyone upgrading into 0.59.0 with a config
    // the new schema no longer describes.
    //
    // THAT ARGUMENT HAS A CONDITION, so state it rather than leaving the next
    // person cutting a release to infer it: this must land BEFORE anything tags
    // `v0.59.0`. If 0.59.0 ships first, this body is inside a key that has
    // shipped, everyone who upgraded past it will never run it, and the schema
    // removal goes out with nothing moving the data — DOR-988 verbatim. Reopen
    // at `'0.60.0'` in that case; the body itself needs no change, because it
    // is idempotent and reads the retired keys rather than a version.
    //
    // Independent of the backfill above — disjoint sections,
    // order-immaterial — and idempotent.
    migrateSidebarSectionPrefs(store);
    // `runtimes.claudeCode.persistentSession` (whether a Claude Code chat keeps
    // its agent running between messages, DOR-1173). Composed into this key for
    // the reason the bodies above state: `v0.58.0` is still the newest tag, so
    // this key has run for nobody, and the leaf ships in the same release —
    // opening a key ABOVE 0.59.0 would mean the release that introduces the
    // field is the one release whose upgraders never run its backfill.
    // Independent of everything above (a different section) and idempotent.
    backfillClaudeCodePersistentSession(store);
  },
  // v0.59.0 is tagged, so the next key that can still run for everybody is
  // 0.60.0 — strictly above the newest `v*` tag (`conf` runs a key only in
  // `(storedVersion, projectVersion]`). Enforced by
  // `__tests__/migration-safety.ts`.
  //
  // Merged and therefore closed. It has run for nobody yet — VERSION still
  // reads 0.59.0, and `conf` runs a key only in
  // `(storedVersion, projectVersion]` — but it goes live the moment the release
  // bump lands, which happens before any tag exists and with no gate in
  // between. So it is frozen from merge, not from the bump: there is no point
  // after merging at which somebody checks whether this body is still the one
  // that should ship. Anything further opens `'0.61.0'`, and
  // `merged-migration-hashes.ts` fails the build if this one changes.
  '0.60.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `rooms.collectDebounceMs` / `rooms.collectMaxEntries` — how long a room
    // gathers a burst of messages before answering it as one, and the most
    // messages one answer covers (room-participation spec §10.4, DOR-1201).
    // Re-runs the whole `rooms` backfill because conf merges top-level defaults
    // SHALLOWLY: a `rooms` block already on disk never inherits a new nested
    // field on its own, so an upgraded install would gather nothing and answer
    // every message on its own. Additive + idempotent; the body fills only
    // absent keys.
    backfillRoomsDefaults(store);
  },
  // v0.61.0 is tagged, so 0.62.0 is the next key that can still run for
  // everybody — strictly above the newest `v*` tag. Frozen from merge, not from
  // the release bump, for the reason `'0.60.0'` above states; anything further
  // opens `'0.63.0'`.
  // Bodies at and below this key that seed `runtimes.claudeCode` write the
  // PRE-LADDER shape — `activeAccount`, and accounts with no `id`. That is
  // correct and must stay frozen: they are what the release they shipped in
  // wrote, and `'0.65.0'` runs strictly after them on any install that reaches
  // it, renaming the key and backfilling the ids. An install that never reaches
  // `'0.65.0'` is carried by the schema tolerances instead
  // (`tolerateLegacyClaudeAccountEncoding` + the Zod heal), not by editing these.
  '0.62.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `a2a.enabled` — whether agents on other systems may reach the agents here
    // (DOR-1304). Seeds the gate CLOSED, matching the behavior before the field
    // existed.
    seedA2aDisabled(store);
  },
  // v0.62.0 is the newest tag, so 0.63.0 is the next key that can still run for
  // everybody. Frozen from merge, not from the release bump, for the reason
  // `'0.60.0'` above states; anything further opens `'0.64.0'`.
  '0.63.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `ui.promos.dismissedIds` — which feature-promo cards this person has waved
    // away (spec `sidebar-simplification` D4). Seeds the list EMPTY: a dismissal
    // has only ever existed per browser, so there is nothing on the server to
    // carry over, and the cockpit imports the old browser key on first read.
    backfillPromoDismissals(store);
  },
  // v0.62.0 is the newest tag and 0.63.0 has merged, so 0.64.0 is the next key
  // that can still run for everybody. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.65.0'`.
  '0.64.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `notifications` — how DorkOS gets your attention (spec
    // `notification-system`, DOR-1385). Seeds the whole block, because conf
    // merges top-level defaults SHALLOWLY and there is no `notifications` block
    // on any existing install at all.
    backfillNotificationDefaults(store);
  },
  // v0.62.0 is the newest tag and 0.63.0/0.64.0 have merged, so 0.65.0 is the
  // next key that can still run for everybody. Frozen from merge, not from the
  // release bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.66.0'`.
  '0.65.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.claudeCode.activeAccount` -> `defaultAccount`, plus a stable
    // `id` on every registered account (spec `billing-account-ladder`,
    // DOR-1407). NOT additive in either half: without the rename the operator's
    // chosen billing account is silently dropped, and without the ids the
    // registry fails schema validation and nothing can reference an account.
    migrateClaudeAccountRegistry(store);
  },
  // v0.63.0 is the newest tag and 0.64.0/0.65.0 have merged, so 0.66.0 is the
  // next key that can still run for everybody. Frozen from merge, not from the
  // release bump, for the reason `'0.60.0'` above states; anything further
  // opens `'0.67.0'`.
  '0.66.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // The raised room bounds and the two leaves the new model adds
    // (DOR-1428). NOT additive in the first half — it rewrites three values
    // that already exist — which is why it only ever touches one that still
    // equals the default it was seeded with. See `raiseRoomTurnLimits`.
    raiseRoomTurnLimits(store);
  },
  // 0.66.0 has merged (DOR-1428, room-turn limits), so 0.67.0 is the next key.
  // Frozen from merge, not from the release bump, for the reason `'0.60.0'`
  // above states; anything further opens `'0.68.0'`.
  //
  // This key is INDEPENDENT of 0.66.0 above and order-immaterial with it: that
  // one rewrites `rooms.*`, this one touches `ui.*`, `scheduler.*` and
  // `runtimes.claudeCode.*` — disjoint sections, so sequencing them either way
  // lands the same config.
  //
  // ALL THREE BODIES ARE SAFETY-NEUTRAL BY DESIGN (spec `full-power-defaults`,
  // invariant A1). This key seeds a record and raises two throttles. It does not
  // write `runtimes.defaultTrustStop`, `ui.autonomyAcknowledgedAt`,
  // `approvals.standingGrants`, a mesh access rule or `canInitiate` — those are
  // consent-gated and are written by the power door's accept, with a person
  // looking at it. A migration that touched one of them would be a defect.
  '0.67.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `ui.fullPowerDecidedAt` / `ui.fullPowerChoice` — whether this person has
    // been asked how much power their agents run with, and what they said.
    // Seeded `null` ("not asked yet"), so the door goes up once.
    seedFullPowerDecision(store);
    // `scheduler.maxConcurrentRuns` 1 -> 4. Only the exact shipped value moves,
    // and the body's docs record the one thing this cannot know: a stored `1`
    // and a chosen `1` look the same on disk.
    raiseSchedulerConcurrencyFloor(store);
    // `runtimes.claudeCode.persistentSession` false -> true. Same shape and same
    // caveat as the bump above, and needed for a sharper reason: the `0.59.0`
    // backfill wrote `false` into every upgraded config, so Ajv's `useDefaults`
    // will never revisit the key.
    warmClaudeCodeSessionsByDefault(store);
  },
  // 0.67.0 has merged (the full-power door), so 0.68.0 is the next key. Frozen
  // from merge, not from the release bump, for the reason `'0.60.0'` above
  // states; anything further opens `'0.69.0'`.
  //
  // Purely subtractive, and safety-neutral: it removes a key that never had any
  // effect (DOR-1482). Disjoint from every other key here.
  '0.68.0': (store: { has: (key: string) => boolean; delete: (key: string) => void }) => {
    // `scheduler.timezone` — a documented setting that did nothing, because
    // every schedule already carries its own timezone.
    dropSchedulerTimezone(store);
  },
  // 0.68.0 has merged (the dead scheduler timezone), so 0.69.0 is the next key.
  // Frozen from merge, not from the release bump, for the reason `'0.60.0'`
  // above states; anything further opens `'0.70.0'`.
  //
  // Safety-neutral and disjoint from every other key here: it names one new
  // top-level section and writes nothing that exists.
  '0.69.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `memory.provider` — which backend holds what an agent remembers (spec
    // `agent-memory`, D7). Seeds `'builtin'`: the markdown file beside each
    // agent, on this machine, which is the only backend that exists and the one
    // that keeps memory local. An ANCHOR, not a mechanism — conf's top-level
    // defaults pre-write lands the section either way, and
    // `seedMemoryProviderDefault` says so at length rather than implying
    // otherwise.
    seedMemoryProviderDefault(store);
  },
  // 0.69.0 has merged (the memory provider), so 0.70.0 is the next key. Frozen
  // from merge, not from the release bump, for the reason `'0.60.0'` above
  // states; anything further opens `'0.71.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `rooms`, which only `'0.66.0'` else touches, and that one rewrites three
  // sibling numbers rather than this member. Sequencing them either way lands
  // the same config.
  '0.70.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `rooms.repo` — whether a room may have files of its own, and the bounds
    // on them (spec `project-rooms` §3.12). A nested leaf, so this body is the
    // only thing that writes it; see `seedRoomRepoDefaults`.
    seedRoomRepoDefaults(store);
  },
  // **`'0.71.0'` was REMOVED here (DOR-2099, spec `tool-only-room-replies`
  // §A1), and it is the only key ever removed from this table.** It seeded
  // `runtimes.dorkosTools: false` — the experiment that decided whether Codex
  // and OpenCode agents carry the DorkOS tools. That experiment graduated on
  // 2026-09-19: every agent-bound session on every runtime carries them, and the
  // leaf no longer exists in `UserConfigSchema`, in the Experiments registry, or
  // in any code path.
  //
  // Removing a shipped key is normally wrong, because an install still upgrading
  // through it silently skips the state change it was owed. Nothing is owed
  // here: there is no behaviour left for a stored value to select, so the state
  // change is empty by construction rather than by argument. Keeping it would be
  // actively WORSE — the next release is below `'0.80.0'`, so an upgrader would
  // run `'0.71.0'` and NOT `'0.80.0'`, and gain a dead key this build's schema
  // does not declare.
  //
  // **That judgement is recorded, not asserted.** Until DOR-2099 nothing in this
  // repository could see a deletion at all: `checkMigrationSafety` walks the
  // WORKING table, so a key present in the release and absent here was reached
  // by no loop, and the pins next door only report a pin left WITHOUT its key —
  // which the same commit removes. Deleting a shipped migration and its pin
  // together passed both guards in silence. The rule now compares the released
  // table against this one and refuses any key that has vanished, unless it is
  // listed in `REMOVED_SHIPPED_KEYS` (`__tests__/migration-safety.ts`) with its
  // reason. `'0.71.0'` is listed there; emptying that list turns this file red.
  //
  // What the removal costs, stated plainly: an install that has already run the
  // key carries `runtimes.dorkosTools` on disk. `'0.80.0'` below deletes it, and
  // on an install that key never reaches — a dev tree resolves SERVER_VERSION to
  // `0.0.0` and runs nothing — `tolerateRetiredRuntimeKeys` makes the first
  // write drop it. Both halves are tested.
  //
  // **`'0.72.0'` was REMOVED here (DOR-2099, spec `tool-only-room-replies`
  // §A2), for the same reason `'0.71.0'` above was and by the same recorded
  // judgement.** It seeded two leaves: `rooms.toolOnlyReplies: false` — the
  // experiment that decided whether an agent chooses when to speak — and
  // `rooms.maxPostsPerTurn: 3`.
  //
  // The experiment graduated on 2026-09-19: a room turn speaks by calling
  // `post_to_room`, by reacting, or not at all, and the leaf no longer exists in
  // `UserConfigSchema`, in the Experiments registry, or in any code path. So the
  // state change the key owed for THAT leaf is empty by construction. What
  // forced the removal rather than merely allowing it is the helper:
  // `seedToolOnlyReplyDefaults` read `USER_CONFIG_DEFAULTS.rooms.toolOnlyReplies`
  // and cannot survive the schema deletion, and a shipped body may not be
  // edited. Removing the key is the honest answer rather than the convenient
  // one, and keeping it would be worse — the next release is below `'0.81.0'`,
  // so an upgrader would run `'0.72.0'` and not `'0.81.0'`, and gain a dead key
  // this build's schema does not declare.
  //
  // **`maxPostsPerTurn` is the half that outlived it**, and it is not dropped:
  // it is a tunable rather than an experiment, nothing else writes it to disk,
  // and `'0.81.0'` below seeds it for any install that never ran `'0.72.0'`.
  // Both halves of its job are therefore still done, by one key instead of two.
  //
  // The judgement is recorded in `REMOVED_SHIPPED_KEYS`
  // (`__tests__/migration-safety.ts`) with its reason, exactly as `'0.71.0'`'s
  // is; the rule compares the released table against this one and refuses any
  // key that has vanished without a line there.
  //
  // 0.70.0 has merged (the room repo), and 0.71.0 and 0.72.0 are both spent, so
  // 0.73.0 is the next key. Frozen from merge, not from the release bump, for
  // the reason `'0.60.0'` above states; anything further opens `'0.74.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `profile`, a section no other key has ever touched since `'0.45.0'` created
  // it — and that one seeds the whole section when it is absent, so the two
  // cannot both act on the same install.
  '0.73.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `profile.displayNameSource` — who wrote the stored display name, so a
    // roster can say "Suggested by DorkBot" until the person saves one
    // themselves (DOR-1022). A nested leaf, so this body is the only thing that
    // writes it; see `seedDisplayNameSourceDefault`.
    seedDisplayNameSourceDefault(store);
  },
  // 0.73.0 has merged (the display-name source) and 0.74.0 is TAGGED, so 0.75.0
  // is the next key. Frozen from merge, not from the release bump, for the
  // reason `'0.60.0'` above states; anything further opens `'0.76.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `harness`. `'0.44.0'` and `'0.57.0'` also touch that section — the first
  // seeds the whole section when it is absent, the second adds `approvedHooks` —
  // and this body writes neither member, so sequencing them any way round lands
  // the same config.
  '0.75.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `harness.refusedHooks` — the packages a person turned down, kept beside
    // the ones they allowed so a refusal survives a restart and the CLI has
    // something to obey (DOR-1849). A nested leaf, so this body is the only
    // thing that writes it; see `seedHarnessRefusedHooks`.
    seedHarnessRefusedHooks(store);
  },
  // New nested defaults only; historical migration bodies stay immutable.
  '0.76.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    const current = store.get('runtimes') as Record<string, unknown> | undefined;
    // conf may have filled defaults only in its parsed read copy: persist it.
    store.set('runtimes', {
      ...current,
      environment: current?.environment ?? { inherit: { claudeCode: [], codex: [], opencode: [] } },
    });
  },
  // 0.76.0 has merged (DOR-1903, a `runtimes` leaf) and 0.74.0 is the newest
  // tag, so 0.77.0 is the next key. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.78.0'`.
  //
  // It was written as `'0.76.0'` and moved, because that key landed on `main`
  // while this branch was open — the ordinary way two slices in flight collide,
  // and the reason the rule is "strictly above the newest tag AND above every
  // key already here" rather than a fixed number.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `harness`. `'0.44.0'`, `'0.57.0'` and `'0.75.0'` also touch that section —
  // seeding the whole section, `approvedHooks`, and `refusedHooks` — and this
  // body writes none of those members, so sequencing them any way round lands
  // the same config. `'0.76.0'` touches `runtimes` and never `harness`.
  '0.77.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `harness.global` — which agent tools DorkOS shares your globally installed
    // packages with, and when it last asked (DOR-1924). A nested leaf, so this
    // body is the only thing that writes it; see `seedHarnessGlobal`.
    seedHarnessGlobal(store);
  },
  // 0.77.0 has merged (DOR-1924, a `harness` leaf) and 0.74.0 is the newest
  // tag, so 0.78.0 is the next key. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.79.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `harness`. `'0.44.0'`, `'0.57.0'`, `'0.75.0'` and `'0.77.0'` also touch that
  // section — seeding the whole section, `approvedHooks`, `refusedHooks` and
  // `global` — and this body writes none of those members, so sequencing them
  // any way round lands the same config.
  '0.78.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `harness.autoAdopt` — whether DorkOS may move a skill into `.agents/skills`
    // on its own inside the folders it owns (DOR-1853). A nested leaf, so this
    // body is the only thing that writes it; see `seedHarnessAutoAdopt`.
    seedHarnessAutoAdopt(store);
  },
  // 0.78.0 has merged (DOR-1853, a `harness` leaf) and 0.74.0 is the newest
  // tag, so 0.79.0 is the next key. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.80.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under
  // `rooms`. `'0.66.0'` and `'0.70.0'` also touch that section — rewriting three
  // sibling numbers and adding `repo` — and `'0.81.0'` below retires
  // `toolOnlyReplies` and seeds `maxPostsPerTurn`. This body writes none of
  // those members, so sequencing them any way round lands the same config.
  '0.79.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `rooms.maxCanvasOpsPerTurn` — how many times one agent may change a room's
    // shared canvas inside one turn (spec `room-canvas` §3.4). A nested leaf, so
    // this body is the only thing that writes it; see `seedRoomCanvasOps`.
    seedRoomCanvasOps(store);
  },
  // 0.79.0 has merged (the canvas op ceiling), so 0.80.0 is the next key. Frozen
  // from merge, not from the release bump, for the reason `'0.60.0'` above
  // states; anything further opens `'0.81.0'`.
  //
  // Disjoint from every other key here: it deletes one nested leaf under
  // `runtimes` that only the removed `'0.71.0'` ever named, so nothing left in
  // this table writes it and no ordering question arises. `'0.65.0'` and
  // `'0.67.0'` also touch that section, rewriting `claudeCode.defaultAccount`
  // and `claudeCode.persistentSession`, which this body preserves along with
  // every other member.
  '0.80.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.dorkosTools` — the graduated experiment (spec
    // `tool-only-room-replies` §A1). Retired rather than re-seeded; see
    // `dropRetiredDorkosTools`.
    dropRetiredDorkosTools(store);
  },
  // 0.80.0 has merged (the first graduated experiment), so 0.81.0 is the next
  // key. Frozen from merge, not from the release bump, for the reason
  // `'0.60.0'` above states; anything further opens `'0.82.0'`.
  //
  // Disjoint from every other key here: it deletes one nested leaf under `rooms`
  // that only the removed `'0.72.0'` ever named, and seeds one that only that
  // same removed key ever wrote — so nothing left in this table touches either
  // and no ordering question arises. `'0.66.0'`, `'0.70.0'` and `'0.79.0'` also
  // touch `rooms`, rewriting three sibling numbers, adding `repo` and adding
  // `maxCanvasOpsPerTurn`, all of which this body preserves.
  '0.81.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `rooms.toolOnlyReplies` — the graduated experiment — deleted, and
    // `rooms.maxPostsPerTurn` seeded for the installs the removed `'0.72.0'`
    // never reached (spec `tool-only-room-replies` §A2). Nested leaves, so this
    // body is the only thing that touches either; see `retireToolOnlyReplies`.
    retireToolOnlyReplies(store);
  },
  // 0.81.0 has merged (the second graduated experiment), so 0.82.0 is the next
  // key. This adds one nested preference block under `ui`; every older sibling
  // is preserved, and repeated execution leaves an existing owner history intact.
  '0.82.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    seedCommunityNavigationPrefs(store);
  },
  // 0.82.0 has merged, so 0.83.0 is the next key. Disjoint from every other key
  // here: it writes one leaf of the new top-level `permissions` section, which
  // nothing above touches, and only READS `ui.fullPowerChoice`, which `'0.67.0'`
  // seeded.
  '0.83.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    seedPermissionPresetFromDoor(store);
  },
  // 0.83.0 is the newest tag, so 0.84.0 is the next key. Frozen from merge, not
  // from the release bump, for the reason `'0.60.0'` above states; anything
  // further opens `'0.85.0'`.
  //
  // Disjoint from every other key here: it writes one nested leaf under `rooms`
  // that nothing above names. `'0.66.0'`, `'0.70.0'`, `'0.79.0'` and `'0.81.0'`
  // also touch `rooms`, and this body preserves every member they write.
  '0.84.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `rooms.maxConcurrentTurnsPerAgent` — how many conversations one agent may
    // work in at once. A nested leaf, so this body is the only thing that writes
    // it; see `seedMaxConcurrentTurnsPerAgent`.
    seedMaxConcurrentTurnsPerAgent(store);
  },
  // 0.84.0 has merged (the per-agent concurrency limit), so 0.85.0 is the next
  // key. Frozen from merge, not from the release bump, for the reason `'0.60.0'`
  // above states; anything further opens `'0.86.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under `profile`,
  // a section `'0.45.0'` seeds whole and `'0.73.0'` extends with a different
  // leaf; both are preserved.
  '0.85.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `profile.identityPromptDismissedAt` — whether the name-and-handle
    // question was put (DOR-677). See `seedIdentityPromptDismissedDefault`.
    seedIdentityPromptDismissedDefault(store);
  },
  // 0.85.0 has merged (the name-and-handle question), so 0.86.0 is the next key.
  // Frozen from merge, not from the release bump, for the reason `'0.60.0'` above
  // states; anything further opens `'0.87.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `extensions`, beside `disabled` and `approvedToRun`, which the keys that
  // backfilled those write and this body preserves.
  '0.86.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `extensions.approvedSources` — which copy each extension approval is for
    // (DOR-2383). See `seedExtensionsApprovedSources`.
    seedExtensionsApprovedSources(store);
  },
  // 0.86.0 has merged (DOR-2383, which extension copy an approval is for), so
  // 0.87.0 is the next key. Frozen from merge, not from the release bump, for
  // the reason `'0.60.0'` above states; anything further opens `'0.88.0'`.
  //
  // Disjoint from every other key here except `'0.65.0'`, which mints the ids
  // this renames and always runs first: it only rewrites the `id` of a
  // `runtimes.claudeCode.accounts[]` row that is exactly `default`, and keeps
  // every other field and row.
  '0.87.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `default` names the default account now (contract `flow-cli-core`
    // §1.1a, revision 6d), so a registered row may not keep it. See
    // `renameReservedClaudeAccountIds`.
    renameReservedClaudeAccountIds(store);
  },
  // 0.90.0 was the next free key when this merged (0.88.0 was the newest tag).
  // `'0.89.0'` is intentionally unused: the branch that had reserved it moved to
  // `'0.91.0'` once this merged first, because a key below one an install has
  // already run would never run there. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `runtimes.claudeCode` that nothing above names, and keeps every member
  // `'0.65.0'` and `'0.87.0'` write there.
  '0.90.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.claudeCode.defaultAccountColor` — the color the standalone
    // default account is drawn in (DOR-2492). See `seedDefaultAccountColor`.
    seedDefaultAccountColor(store);
  },
  // 0.90.0 has merged (the standalone default account's color, DOR-2492) and
  // v0.88.0 is the newest tag, so 0.91.0 is the next key: keys must rise in
  // merge order, because an install that already ran 0.90.0 would never run a
  // lower key added after it. Frozen from merge, not from the release bump, for
  // the reason `'0.60.0'` above states; anything further opens `'0.92.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `runtimes.claudeCode`, beside `accounts`, which `'0.65.0'` and `'0.87.0'`
  // write and this body preserves.
  '0.91.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.claudeCode.dismissedFolders` — the found account folders a
    // person dismissed in Settings. See `seedClaudeDismissedFolders`.
    seedClaudeDismissedFolders(store);
  },
  // 0.91.0 has merged (found account folders a person dismissed) and v0.89.0 is
  // the newest tag, so 0.92.0 is the next key. Frozen from merge, not from the
  // release bump, for the reason `'0.60.0'` above states; anything further
  // opens `'0.93.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `extensions`, beside `approvedSources`, which `'0.86.0'` writes and this
  // body preserves.
  '0.92.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `extensions.dismissedApprovals` — the extension copies a person said
    // "Not now" to in the Activity inbox (DOR-2517). See
    // `seedExtensionsDismissedApprovals`.
    seedExtensionsDismissedApprovals(store);
  },
  // 0.92.0 has merged (DOR-2517, extension approvals a person said "Not now"
  // to), so 0.93.0 is the next key. Frozen from merge, not from the release
  // bump, for the reason `'0.60.0'` above states; anything further opens
  // `'0.94.0'`.
  //
  // Disjoint from every other key here: it adds two nested leaves under
  // `runtimes.claudeCode` and one leaf on each `accounts[]` row, none of which
  // anything above names, and keeps every member `'0.65.0'`, `'0.87.0'`,
  // `'0.90.0'` and `'0.91.0'` write there.
  '0.93.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.claudeCode.projectAccounts`, `.defaultAccountOnlyProjects` and
    // `accounts[].onlyProjects` — which accounts may work in which projects
    // (spec `flow-multiproject` §8, DOR-2526). See `seedAccountProjectRules`.
    seedAccountProjectRules(store);
  },
  // 0.93.0 has merged (DOR-2526, account project rules) and v0.89.0 is the
  // newest tag, so 0.94.0 is the next key. Frozen from merge, not from the
  // release bump, for the reason `'0.60.0'` above states; anything further
  // opens `'0.95.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `extensions`, beside `dismissedApprovals`, which `'0.92.0'` writes and this
  // body preserves.
  '0.94.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `extensions.trustedSources` — the code sources a person trusts outright
    // (spec `flow-multiproject` §9.3). See `seedExtensionsTrustedSources`.
    seedExtensionsTrustedSources(store);
  },
  // v0.95.0 is tagged, so 0.96.0 is the next key. Frozen from merge.
  //
  // Disjoint from every other key here: it adds one nested leaf under `cloud`,
  // beside the link fields, which it preserves.
  '0.96.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `cloud.credits` — who chose DorkOS credits as a runtime's default, and the
    // one offer a computer linked before credits were a choice is owed (ADR
    // 261001-000811). See `seedCloudCreditsChoices`.
    seedCloudCreditsChoices(store);
  },
  // v0.97.0 is tagged, so 0.98.0 is the next key. Frozen from merge, for the
  // reason `'0.60.0'` above states; anything further opens `'0.99.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `extensions`, beside `approvedSources`, which `'0.86.0'` writes and this
  // body preserves.
  '0.98.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `extensions.approvedPermissions` — the permission set each extension
    // approval covers (DOR-2686). See `seedExtensionsApprovedPermissions`.
    seedExtensionsApprovedPermissions(store);
  },
  // New top-level defaults are persisted by conf before migration selection.
  // This anchor also heals a stored browser section missing its enabled leaf.
  '0.99.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    const browser = store.get('browser');
    if (browser !== null && typeof browser === 'object' && !Array.isArray(browser)) {
      // Ajv may fill the leaf in the getter's copy; persist that copy explicitly.
      store.set('browser', {
        ...browser,
        enabled: (browser as { enabled?: unknown }).enabled === true,
      });
    }
  },
  // 0.99.0 has merged (the browser leaf above), so 0.100.0 is the next key.
  // Frozen from merge, for the reason `'0.60.0'` above states; anything
  // further opens `'0.101.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `runtimes.codex`, beside the fields it preserves.
  '0.100.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `runtimes.codex.transport` — how DorkOS runs Codex (ADR 261005-113107).
    // See `seedCodexTransport`.
    seedCodexTransport(store);
  },
  '0.101.0': seedDoeRuntime,
  // v0.101.0 is tagged, so 0.102.0 is the next key.
  // Frozen from merge, for the reason `'0.60.0'` above states; anything
  // further opens `'0.103.0'`.
  //
  // Disjoint from every other key here: it deletes one leaf under `ui` and
  // touches nothing beside it.
  '0.102.0': (store: { has: (key: string) => boolean; delete: (key: string) => void }) => {
    // `ui.autonomyAcknowledgedAt` — the Full-autonomy acknowledgement, retired
    // with its ritual (ADR 261006-225605, DOR-2739). See
    // `dropAutonomyAcknowledgement`.
    dropAutonomyAcknowledgement(store);
  },
  // 0.102.0 has merged (the acknowledgement above), so 0.103.0 is the next
  // key. Frozen from merge; anything further opens `'0.104.0'`.
  //
  // Disjoint from every other key here: it rewrites two `rooms` leaves, and
  // only when each still holds the old shipped default.
  '0.103.0': raiseEngagedWindowDefaults,
  // v0.103.0 is the newest tag and 0.104.0 is claimed by work in flight, so
  // this opens 0.105.0. Frozen from merge, for the reason `'0.60.0'` above
  // states; anything further opens `'0.106.0'`.
  //
  // Disjoint from every other key here: it adds three nested leaves under
  // `profile`, beside the fields it preserves.
  '0.105.0': seedWorkingHoursDefaults,
  // v0.103.0 is the newest tag and 0.105.0 has merged (working hours above),
  // so this opens 0.106.0. Frozen from merge, for the reason `'0.60.0'` above
  // states; anything further opens `'0.107.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under `cloud`,
  // beside the link fields and `credits` (which `'0.96.0'` writes), all of
  // which it preserves. It reads `tunnel.enabled` and never writes `tunnel`.
  '0.106.0': seedCloudRemoteAccess,
  // v0.103.0 is the newest tag and 0.106.0 has merged (remote access above),
  // so this opens 0.107.0. Frozen from merge, for the reason `'0.60.0'` above
  // states; anything further opens `'0.108.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `spaces`, beside `enabled`, which it preserves.
  '0.107.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    // `spaces.official.url` — the official DorkOS space's link (spec
    // `official-community-space` D4). See `seedSpacesOfficial`.
    seedSpacesOfficial(store);
  },
  // v0.103.0 is the newest tag and 0.107.0 has merged (the official space
  // above), so this opens 0.108.0. Frozen from merge, for the reason `'0.60.0'`
  // above states; anything further opens `'0.109.0'`.
  //
  // Disjoint from every other key here: it adds three nested leaves under
  // `onboarding`, beside the fields it preserves.
  '0.108.0': seedFirstRunOnboardingLeaves,
  // v0.103.0 is the newest tag and 0.108.0 has merged (first-run onboarding
  // above), so this opens 0.109.0. Frozen from merge, for the reason `'0.60.0'`
  // above states; anything further opens `'0.110.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under
  // `runtimes.doe`, beside the fields it preserves.
  '0.109.0': seedDoeDefaultModel,
  // v0.111.0 is the newest tag, so this opens 0.112.0. Frozen from merge, for
  // the reason `'0.60.0'` above states; anything further opens `'0.113.0'`.
  //
  // Disjoint from every other key here: it adds one nested leaf under `ui`,
  // beside the fields it preserves. See `seedUiPanelTabs`.
  '0.112.0': seedUiPanelTabs,
  // v0.111.0 is the newest tag and 0.112.0 has merged (panel tabs above), so
  // this opens 0.113.0. Frozen from merge, for the reason `'0.60.0'` above
  // states; anything further opens `'0.114.0'`.
  //
  // Disjoint from every other key here: it deletes two leaves under `rooms`
  // and touches nothing beside them.
  //
  // `rooms.maxPostsPerTurn` and `rooms.maxCanvasOpsPerTurn` — the per-turn caps
  // on our own agents, retired (ADR 261006-225605, DOR-2739).
  '0.113.0': dropAgentTurnCaps,
  // 0.113.0 has merged; this new key preserves an explicit computer choice.
  '0.114.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    const computers = store.get('computers');
    if (computers !== null && typeof computers === 'object' && !Array.isArray(computers)) {
      store.set('computers', {
        ...computers,
        enabled: (computers as { enabled?: unknown }).enabled === true,
      });
    }
  },
  // v0.111.0 is the newest tag and 0.114.0 has merged (computers above), so
  // this opens 0.115.0. Frozen from merge, for the reason `'0.60.0'` above
  // states; anything further opens `'0.116.0'`.
  //
  // Writes `permissions.preset`, `runtimes.defaultTrustStop` and
  // `ui.trustNoticeSeenAt`, and deletes the two door fields `'0.67.0'` seeded
  // and `'0.83.0'` read. Both earlier keys run first, so this one sees their
  // output; nothing after it reads what it removes. Trusted by default (ADR
  // 261006-225605, DOR-2739): an install that chose to be asked keeps Careful,
  // every other install moves to Trusted once and is shown a notice.
  '0.115.0': applyTrustedPosture,
  // 0.115.0 has merged (the trusted posture above), so this opens 0.116.0.
  // Frozen from merge; anything further opens `'0.117.0'`.
  //
  // Writes `server.lanAccess: false` into a stored `server` section that lacks
  // it, and touches nothing else (DOR-2930). See `seedLanAccess`.
  '0.116.0': seedLanAccess,
  // v0.119.0 is the newest tag, so this opens 0.120.0. Frozen from merge;
  // anything further opens `'0.121.0'`.
  //
  // Disjoint from every other key here: `sessionRelay` is a new top-level
  // section, which conf persists before migration selection. This anchor also
  // heals a stored section missing its `enabled` leaf, as `'0.114.0'` does for
  // `computers` (spec `everything-is-a-space` step B3, DOR-2946).
  '0.120.0': (store: {
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  }) => {
    const sessionRelay = store.get('sessionRelay');
    if (sessionRelay !== null && typeof sessionRelay === 'object' && !Array.isArray(sessionRelay)) {
      store.set('sessionRelay', {
        ...sessionRelay,
        enabled: (sessionRelay as { enabled?: unknown }).enabled === true,
      });
    }
  },
  // v0.122.0 is the newest release, so this opens 0.123.0. Frozen from merge;
  // anything further opens `'0.124.0'`.
  //
  // Writes `runtimes.claudeCode.maxWarmProcesses: null` where the stored
  // section lacks it, and touches nothing else (DOR-3012). See
  // `seedMaxWarmProcesses`.
  '0.123.0': seedMaxWarmProcesses,
} as const;
