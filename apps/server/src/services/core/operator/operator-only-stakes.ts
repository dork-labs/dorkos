/**
 * What is at stake in each operator-only setting, and the floor area a change
 * to it asks in: the stakes table behind `OPERATOR_ONLY_CONFIG_PATHS`'s
 * refusals, split out of `config-write-policy.ts` to keep that file under the
 * line limit.
 *
 * @module services/core/operator/operator-only-stakes
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import {
  CLOUD_REMOTE_CREDENTIAL_PATHS,
  CLOUD_REMOTE_REACH_PATHS,
} from '../remote/remote-config-policy.js';
import { ONBOARDING_CREDENTIAL_PATHS } from './onboarding-write-policy.js';

/**
 * What is actually at stake in an operator-only setting.
 *
 * Not every setting on this list is security-shaped. Most are, but a room's
 * reply ceiling and the welcome-back cap are not: they bound how much your
 * agents speak and spend on their own, which is a different promise entirely.
 * Telling a model that a greeting cap "decides who can reach this instance"
 * teaches it something false about the product, so the stake is carried per
 * path and the refusal quotes the right one (DOR-1044).
 *
 * - `reach` — who can reach this instance, and how far it reaches on this machine.
 * - `credentials` — which sign-in and which keys the work runs on.
 * - `code` — which code this server runs, and which outside tools it attaches to.
 * - `disclosure` — what leaves this machine.
 * - `approvals` — whether a person is asked before something happens.
 * - `initiative` — when agents speak on their own, and what that spends.
 * - `resources` — how much of this machine the work may take up.
 * - `attention` — whether the person finds out that something needs them.
 * - `authorship` — whether a stored value is shown as the person's own or as an
 *   agent's suggestion.
 * - `navigation` — where the app takes the person when they switch back to
 *   this DorkOS, and whose saved places those are.
 * - `view` — how a chat is drawn, and what it shows the person about the work
 *   behind it (DOR-3074).
 *
 * `authorship` is the newest and the narrowest (DOR-1022): it covers the record
 * of WHO wrote the display name, and nothing else on this list guards a record
 * of authorship. It is not `disclosure` — nothing leaves the machine — and not
 * `attention` — nothing is waiting on anybody. It is the same principle as
 * `resources` below: a near-neighbour would have been a refusal that says
 * something false about the setting.
 *
 * `resources` arrived with the wipe floor (DOR-1497) rather than being carved out
 * of the others, because its claim was not already on the list: "this bound is
 * about memory and disk" is not `initiative` (nothing speaks on its own). Filing
 * it under a near-neighbour would have been the DOR-1044 failure again — a
 * refusal that overstates what a setting does is a lie the model then carries.
 */
export type OperatorOnlyStake =
  | 'reach'
  | 'credentials'
  | 'code'
  | 'disclosure'
  | 'approvals'
  | 'initiative'
  | 'resources'
  | 'attention'
  | 'authorship'
  | 'navigation'
  | 'view';

/**
 * The floor permission area an operator-only setting is asked about in (spec
 * `agent-permissions` D6). An agent's `config_patch` that touches one of these
 * no longer bounces off a flat refusal: it asks the person in this area, which
 * is never Allowed, so every such change is a person's yes.
 */
export type OperatorOnlyArea = Extract<PermissionAreaId, 'safety' | 'reach' | 'permissions'>;

/** One stake, the sentence an agent reads for it, and the paths it covers. */
interface OperatorOnlyStakeGroup {
  /** The stake these paths share. */
  readonly stake: OperatorOnlyStake;
  /**
   * The floor area a change to one of these paths asks in. Carried per stake
   * because the stake already says what the setting guards, and the area is the
   * person-facing name for that same thing.
   */
  readonly area: OperatorOnlyArea;
  /**
   * The clause the refusal quotes, written for a model and true of every path
   * below it. No trailing punctuation: the refusal appends `: <paths>.`
   */
  readonly description: string;
  /** The operator-only dot-paths this stake is true of. */
  readonly paths: readonly string[];
}

/**
 * Every operator-only path, filed under the stake that is TRUE of it.
 *
 * The drift guard in `__tests__/config-write-policy.test.ts` asserts this covers
 * `OPERATOR_ONLY_CONFIG_PATHS` exactly and names nothing twice, so a newly
 * refused setting cannot inherit a description that does not fit it. Order here
 * is the order the refusal lists stakes in.
 */
export const OPERATOR_ONLY_STAKES: readonly OperatorOnlyStakeGroup[] = [
  {
    stake: 'reach',
    area: 'reach',
    description: 'Who can reach this instance, and how far it reaches on this machine',
    paths: [
      'auth.enabled',
      'tunnel.enabled',
      'tunnel.domain',
      'tunnel.authtoken',
      'tunnel.auth',
      'server.lanAccess',
      ...CLOUD_REMOTE_REACH_PATHS,
      'mcp.enabled',
      'browser.enabled',
      'computers.enabled',
      'sessionRelay.enabled',
      'spaces.enabled',
      'spaces.official.url',
      'a2a.enabled',
      'mcp.apiKey',
      'mcp.rateLimit.enabled',
      'mcp.rateLimit.maxPerWindow',
      'mcp.rateLimit.windowSecs',
      'server.boundary',
      'workspace.rootPath',
      'relay.dataDir',
      'agents.defaultDirectory',
      'mesh.scanRoots',
      // Whether DorkOS writes into the harness directories of projects on disk on
      // its own. The second clause of this stake — how far it reaches on this
      // machine — read as a write rather than as a scope.
      'harness.autoSync',
      // Whether DorkOS moves a person's own skill folders, unattended, inside
      // the agent folders DorkOS owns (DOR-1853). The same
      // clause read one notch harder: `autoSync` writes links DorkOS made, this
      // one moves a file the person wrote.
      'harness.autoAdopt',
      // Whether DorkOS writes links into two folders in the person's HOME
      // directory, which is the furthest this server ever reaches on disk. An
      // empty list is off, so this one leaf is the whole switch (DOR-1924).
      'harness.global.harnesses',
      // The stamp beside it. Same stake, because clearing it makes DorkOS ask
      // again about that reach and setting it silences the question.
      'harness.global.askedAt',
      // Whether a room may have a git repo of its own — a checkout under the
      // DorkOS data directory that member agents run tools in. Same clause as
      // `harness.autoSync`, one step further: this decides whether the writable
      // space exists at all.
      'rooms.repo.enabled',
    ],
  },
  {
    stake: 'credentials',
    area: 'reach',
    description: 'Which account and keys the work runs on, and who pays for it',
    paths: [
      'providers',
      'cloud.instanceToken',
      'cloud.instanceName',
      'cloud.linkedAccountLabel',
      'cloud.previousLinkProof',
      'cloud.credits.defaults',
      'cloud.credits.offer',
      'cloud.credits.agents',
      'cloud.credits.linkedTo',
      ...CLOUD_REMOTE_CREDENTIAL_PATHS,
      ...ONBOARDING_CREDENTIAL_PATHS,
      'heartbeats.triageOnCredits',
      'runtimes.codex.credentialRef',
      'runtimes.environment.inherit.claudeCode',
      'runtimes.environment.inherit.codex',
      'runtimes.environment.inherit.opencode',
      'runtimes.environment.inherit.doe',
      'runtimes.doe.inference.source',
      'runtimes.doe.inference.provider',
      'runtimes.doe.inference.protocol',
      'runtimes.doe.inference.endpoint',
      'runtimes.doe.inference.credentialRef',
      'runtimes.doe.inference.credentialEndpoint',

      'runtimes.opencode.provider',
      'runtimes.opencode.baseURL',
      'runtimes.claudeCode.defaultAccount',
      'runtimes.claudeCode.accounts[].id',
      'runtimes.claudeCode.accounts[].path',
      'runtimes.claudeCode.accounts[].label',
      'runtimes.claudeCode.accounts[].color',
      'runtimes.claudeCode.defaultAccountColor',
      'runtimes.claudeCode.dismissedFolders',
      'runtimes.claudeCode.accounts[].onlyProjects',
      // Whether a room agent whose account ran out may be moved to this one on
      // its own (re-seat). Which account the work runs on: an agent clearing it
      // would move itself onto an account a person kept it off.
      'runtimes.claudeCode.accounts[].noAutoMove',
      'runtimes.claudeCode.defaultAccountOnlyProjects',
      'runtimes.claudeCode.projectAccounts',
    ],
  },
  {
    stake: 'code',
    area: 'reach',
    // Covers both halves honestly: extension code and spawned binaries run
    // INSIDE this machine, while a raw-MCP server is an endpoint DorkOS reaches
    // out to and hands a session as a tool. Neither lets anybody IN, which is
    // why none of them belong under `reach`.
    description: 'Which code this server runs, and which outside tools it attaches to',
    paths: [
      'extensions.enabled',
      'extensions.disabled',
      'extensions.approvedToRun',
      'extensions.approvedSources',
      'extensions.legacyUnsourced',
      'extensions.approvedPermissions',
      'extensions.dismissedApprovals',
      'extensions.trustedSources[].source',
      'extensions.trustedSources[].trustedAt',
      'extensions.roomAccess',
      'extensions.forwardAgents',
      'harness.approvedHooks',
      'harness.refusedHooks',
      'harness.approvedFolderConfig',
      'harness.approvedFolderConfigParts',
      'harness.refusedFolderConfig',
      'harness.folderConfigPinned',
      'runtimes.opencode.binaryPath',
      'runtimes.codex.binaryPath',
      'runtimes.codex.transport',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].url',
      'connectors.rawMcpServers[].transport',
    ],
  },
  {
    stake: 'disclosure',
    area: 'reach',
    description: 'What leaves this machine',
    paths: [
      'telemetry.userHasDecided',
      'telemetry.install',
      'telemetry.heartbeat',
      'telemetry.errorReporting',
      'telemetry.lastPromptedVersion',
      'telemetry.usage',
      'telemetry.linkAnalyticsToAccount',
      'telemetry.aiMetadata',
      // Which backend holds what every agent remembers. Filed here rather than
      // under `code` because the stake is where the NOTES end up, not what runs:
      // `'builtin'` keeps them in a file on this machine, and any other id keeps
      // the same notes somewhere the operator did not choose.
      'memory.provider',
    ],
  },
  {
    stake: 'approvals',
    area: 'permissions',
    description: 'Whether the person is asked before work happens on their behalf',
    paths: [
      'runtimes.defaultTrustStop',
      'runtimes.claudeCode.defaultTrustStop',
      'runtimes.codex.defaultTrustStop',
      'runtimes.opencode.defaultTrustStop',
      'runtimes.doe.defaultTrustStop',
      // The notice that says agents work without asking. Filed here because
      // that is what it tells the person about: whether they are asked first.
      'ui.trustNoticeSeenAt',
      // What agents may do without asking. Refused on this route before this
      // table is read (see `USE_PERMISSIONS_API`); listed so the stake sentence
      // is right if that refusal is ever reached around.
      'permissions.preset',
      'permissions.defaults.areas',
      'permissions.defaults.actions',
      'permissions.upgradeSweptVersion',
      'permissions.trustedStoresAppliedAt',
      'permissions.sharedAtUpgrade',
      'permissions.sharedAppsAppliedAt',
      'permissions.approvedFolderAllows',
      'permissions.refusedFolderAllows',
      'permissions.approvedFolderAllowRules',
    ],
  },
  {
    stake: 'initiative',
    area: 'safety',
    description: 'When your agents speak on their own, and how much that spends',
    paths: [
      'rooms.turnLimitsEnabled',
      'rooms.maxAgentDepth',
      'rooms.maxTurnsPerAgentPerCascade',
      'rooms.maxAutomaticTurnsPerRoomPerHour',
      'rooms.maxAutomaticTurnsTotalPerHour',
      // The same stake on the message bus rather than in a room: the two
      // ceilings on turns agent messaging may start (DOR-791).
      'relay.maxAgentTurnsPerAgentPerHour',
      'relay.maxAgentTurnsTotalPerHour',
      'rooms.engagedWindowMinutes',
      'rooms.engagedWindowPosts',
      'rooms.collectDebounceMs',
      'rooms.collectMaxEntries',
      'rooms.responseGate',
      // How many conversations one agent may work in at once: how much your
      // agents do on their own at the same time, and how much that spends.
      'rooms.maxConcurrentTurnsPerAgent',
      'welcomeBack.enabled',
      'welcomeBack.absenceThresholdMinutes',
      'welcomeBack.maxPosts',
      // The most literal member of this group: it is the one welcome-back
      // setting that decides whether a model turn runs at all (DOR-1046).
      'welcomeBack.offersEnabled',
      // Whether agents wake on their own at all (spec `heartbeats` §3.6).
      'heartbeats.enabled',
      // Docs: a mention in a doc comment wakes the agent it names (DOR-2983).
      'docs.enabled',
    ],
  },
  {
    stake: 'resources',
    area: 'safety',
    // Memory, disk and how many things run at once. None of these is a security
    // control and none of them decides whether an agent acts unbidden, so neither
    // `reach` nor `initiative` would be a true sentence about them. They are here
    // because a person tightened a bound on their own machine and the wipe floor
    // says an agent may not slacken it back (DOR-1497).
    description: 'How much of this machine the work may take up',
    paths: [
      'uploads.maxFileSize',
      'uploads.maxFiles',
      // Not a size or a count, but the same shape of leaf: a bound on what an
      // upload may bring onto this machine that a person narrowed on their own,
      // and the wipe floor says an agent may not widen it back (DOR-1505).
      'uploads.allowedTypes',
      'runtimes.claudeCode.persistentSession',
      // How many agents may run at once: a person who lowered it to save memory
      // must not have an agent raise it back (DOR-3012).
      'runtimes.claudeCode.maxWarmProcesses',
      'scheduler.maxConcurrentRuns',
      // Whether the computer stays awake for the work, and whether it is woken
      // for it: battery, and whether the machine is on while nobody is there.
      'keepAwake.whileAgentsWork',
      'keepAwake.wakeForScheduledTasks',
      // How much Activity history this machine keeps on disk, and how much a
      // person can still look back over.
      'activity.retentionDays',
      // How large a room's files may get, how much of its conventions file
      // rides every turn, and when an idle working copy is tidied away. Disk
      // and the bill, bounded by the person rather than by the agents filling
      // it.
      'rooms.repo.maxFileBytes',
      'rooms.repo.maxRepoBytes',
      'rooms.repo.maxRoomMdBytes',
      'rooms.repo.worktreeReapDays',
    ],
  },
  {
    stake: 'authorship',
    area: 'safety',
    // The narrowest stake here, and the only one that guards a RECORD rather
    // than a behaviour: these two leaves say whether the stored display name was
    // the person's own or an agent's suggestion (DOR-1022). Writing them changes
    // nothing about what runs — it changes what the person is told about a name
    // already on their roster, which is why neither `disclosure` (what leaves
    // the machine) nor `attention` (whether you are told something is waiting)
    // is a true sentence about it.
    description: 'Whether a name on your roster is shown as your own or as an agent’s suggestion',
    paths: ['profile.displayNameSource.kind', 'profile.displayNameSource.agentName'],
  },
  {
    stake: 'navigation',
    area: 'reach',
    // Not `reach` (nobody gets in) and not `authorship` (no name is shown as
    // anyone's). An agent able to write the owner key could file its own state
    // under the person's namespace, and one able to write the saved route could
    // choose where the person lands on their next "switch back" click.
    description:
      'Where the app takes you when you switch back to this DorkOS, and whose saved places those are',
    paths: [
      'ui.communityNavigation.owners[].ownerKey',
      'ui.communityNavigation.owners[].installationDestination.path',
      'ui.communityNavigation.owners[].installationDestination.search',
      // Which #team entry the app shows as DorkBot's first-run welcome.
      'onboarding.welcomeEntryId',
    ],
  },
  {
    stake: 'view',
    area: 'safety',
    // Not `attention` (nothing here says something is waiting on you) and not
    // `navigation` (no saved place). What the chat on screen shows you about
    // the work behind it, and how a chat with one agent is drawn (DOR-3074).
    description: 'How your chats are drawn, and what they show you about the work behind them',
    paths: ['ui.dmView', 'ui.showSessions'],
  },
  {
    stake: 'attention',
    area: 'safety',
    description: 'Whether you are told that something is waiting on you',
    paths: [
      'notifications.escalation.phoneAfterMinutes',
      'notifications.sounds.knock',
      'notifications.sounds.allClear',
      'notifications.sounds.turnEnd',
      'notifications.notifyOnTurnCompleteWhileAway',
      'notifications.browserPermissionPrimerDismissed',
    ],
  },
];
