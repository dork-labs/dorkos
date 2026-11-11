/** Config migration chain; retired keys are recorded in the guard removal list. */
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
  keepAccountOutOfAutoMoves,
  seedUiDmViewLeaves,
  markLegacyPathOnlyApprovals,
  seedMaxAgentChats,
  renameTodoPromiseActions,
} from './v0-90-onward.js';

/**
 * Append-only conf migrations, keyed by the app release that first runs them.
 * See contributing/configuration.md and the adding-config-fields skill.
 *
 * Open a new key above the newest release tag. Conf runs a key only when
 * storedVersion < key <= projectVersion, so adding an earlier key silently
 * skips every install already beyond it. A body is frozen when it merges,
 * including before its release is tagged: built apps already run that version.
 * Correct shipped behavior with a new idempotent key, never an edited body.
 *
 * The tag guard compares each surviving table slice and its local helper
 * closure against the newest release. Append-only hashes also follow selected
 * imports into the shared config schema, covering the merge-to-release window.
 * Both readers follow declarations called inside template interpolations.
 * Retired keys require an explicit REMOVED_SHIPPED_KEYS entry and pin removal;
 * keys through 0.89 are retired under the 0.115 config upgrade floor.
 *
 * Conf writes a shallow merge of top-level defaults before running migrations.
 * That supplies a whole absent section, but cannot supply a nested leaf inside
 * an existing section. Ajv fills nested defaults only into the copy its getter
 * returns. Verify nested migration writes against the file, then suppress the
 * body to prove that assertion fails. Manager getters alone cannot prove it.
 *
 * Conf stores its last-applied version at __internal__.migrations.version.
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
  // v0.124.0 is the newest tag, and this ships in the 0.124.1 patch, so it
  // opens 0.124.1. Frozen from merge; anything further opens `'0.125.0'`.
  //
  // Sets `noAutoMove: true` on one registered Claude account row that lacks
  // the field, and touches nothing else (Re-seat P0). See
  // `keepAccountOutOfAutoMoves`; the history line it owes is written at boot.
  '0.124.1': keepAccountOutOfAutoMoves,
  // 0.124.1 above is the patch's key, so this opens 0.125.0. Frozen from merge;
  // anything further opens `'0.126.0'`.
  //
  // Writes `ui.dmView: false` and `ui.showSessions: false` where the stored
  // `ui` section lacks them, and touches nothing else (DOR-3074). See
  // `seedUiDmViewLeaves`.
  '0.125.0': seedUiDmViewLeaves,
  // v0.126.0 is the newest tag, so this opens 0.126.1. Frozen from merge;
  // anything further opens `'0.127.0'`.
  //
  // Marks each extension approval that names no content with
  // `legacyPathOnly: true`, and touches nothing else (DOR-3068). Only a marked
  // approval is pinned to the files the next scan finds. See
  // `markLegacyPathOnlyApprovals`.
  '0.126.1': markLegacyPathOnlyApprovals,
  // v0.126.4 is the newest tag, so this opens 0.126.5. Frozen from merge;
  // anything further opens `'0.127.0'`.
  //
  // Writes `runtimes.maxAgentChats: 8` where the stored `runtimes` section
  // lacks it, and touches nothing else (DOR-3413). See `seedMaxAgentChats`.
  '0.126.5': seedMaxAgentChats,
  // v0.132.0 is the newest tag, so this opens 0.133.0. Frozen from merge;
  // anything further opens `'0.134.0'`.
  //
  // Moves each per-action default stored under `commitments.add|update|list`
  // to `todo_promises.add|update|list`, and touches nothing else (DOR-3933).
  // See `renameTodoPromiseActions`.
  '0.133.0': renameTodoPromiseActions,
} as const;
