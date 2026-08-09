/**
 * A stated verdict on every default in the user config: does it land on the side
 * that protects the person, and if not, why not.
 *
 * ## Why a registry rather than a principle
 *
 * "Default to the option that protects the user" is only worth stating if
 * someone can fail it. Written in a guide, it is advice the next schema author
 * may not read; written here, an unclassified default fails the build until they
 * say which it is. That is the shape {@link CONFIG_DISCLOSURE} already uses for
 * a neighbouring question ("may this field be disclosed?"), for the same reason:
 * a field nobody classified used to be exposed the moment it was added, and
 * nothing complained. Inverting that model caught a real leak.
 *
 * ## The three verdicts
 *
 * The axis is deliberately narrow, because a registry where every entry is a
 * security judgement is a registry that gets rubber-stamped:
 *
 * - `no-risk` — the default cannot send data off the machine, cannot grant an
 *   agent a capability, and enforces no bound. A preference. Most leaves.
 * - `safe` — the default IS the protective option on a real safety axis: a gate
 *   that starts closed, a bound that starts on, a list that starts empty, a
 *   credential slot that starts empty.
 * - `permissive` — the default is the permissive option on a real safety axis.
 *   Legal, and sometimes right, but it must be argued: every entry carries a
 *   reason, and the guard rejects an empty one.
 *
 * The point of `no-risk` is honesty. Claiming that `ui.theme` defaulting to
 * `'system'` is a safety verdict devalues the ten entries that are.
 *
 * ## What the guard enforces
 *
 * `__tests__/default-verdicts.test.ts` fails when a leaf of `UserConfigSchema`
 * appears in none of the three lists, when one appears in two, when a
 * `permissive` entry has no real reason, or when a listed path is not a leaf at
 * all (a rename left it behind). Adding a config field therefore means stating
 * what its default does — at the moment you add it, not at the next audit.
 *
 * ## Not the same question as carryover
 *
 * `protected-state.ts` asks what must SURVIVE a wipe; this asks what a default
 * IS. They overlap but do not coincide: `approvals.standingGrants` defaults
 * `safe` and needs no carryover rule, while `rooms.maxAgentDepth` defaults to a
 * real bound (`safe`) and still needs one, because a person may have tightened
 * it further. The guard checks the one relationship that must hold: a carryover
 * rule only makes sense for a leaf that can lose something.
 *
 * @module services/core/safe-defaults/default-verdicts
 */

/**
 * What a config default does on the safety axis. See the module docs for the
 * full definition of each.
 */
export type DefaultVerdict = 'no-risk' | 'safe' | 'permissive';

/** A permissive default: the value it actually ships with, and the case for it. */
export interface PermissiveDefault {
  /**
   * The value `USER_CONFIG_DEFAULTS` really carries at this path. Recorded, not
   * derived, so the drift guard can compare the two: a one-line `.default(...)`
   * flip in the schema is likelier drift than a new field, and comparing a
   * declared value against the real one is the only way this registry can
   * notice it.
   */
  value: unknown;
  /** Why the permissive side is the right default here. */
  reason: string;
}

/**
 * Leaves whose default cannot send data off the machine, grant a capability, or
 * relax a bound. Preferences, identifiers, window dressing, and machine-managed
 * bookkeeping.
 *
 * Being on this list is a claim, not a shrug: it says someone looked and found
 * no safety axis. If a field later grows one — a preference that starts
 * triggering network calls — move it.
 */
export const NO_RISK_DEFAULTS: readonly string[] = [
  'version',
  'server.port',
  'server.cwd',
  'server.boundary',
  'server.open',
  'ui.theme',
  'ui.dismissedUpgradeVersions',
  'ui.sidebar.pinned[].kind',
  'ui.sidebar.pinned[].path',
  'ui.sidebar.pinned[].roomId',
  'ui.sidebar.groups[].id',
  'ui.sidebar.groups[].name',
  'ui.sidebar.groups[].items[].kind',
  'ui.sidebar.groups[].items[].path',
  'ui.sidebar.groups[].items[].roomId',
  'ui.sidebar.groups[].sortMode',
  'ui.sidebar.groups[].collapsed',
  'ui.sidebar.groups[].displayFilter',
  'ui.sidebar.groups[].muted',
  'ui.sidebar.groups[].kind',
  'ui.sidebar.groups[].rules.runtimes',
  'ui.sidebar.groups[].rules.namespaces',
  'ui.sidebar.groups[].rules.statuses',
  'ui.sidebar.groups[].rules.lastActiveWithinMs',
  'ui.sidebar.groups[].rules.pathPrefix',
  'ui.sidebar.ungroupedSortMode',
  'ui.sidebar.ungroupedCollapsed',
  'ui.sidebar.recentsCollapsed',
  'ui.sidebar.channelsCollapsed',
  'ui.sidebar.threadsCollapsed',
  'ui.sidebar.dmsCollapsed',
  'ui.sidebar.groupsHintDismissed',
  'ui.sidebar.muted[].kind',
  'ui.sidebar.muted[].path',
  'ui.sidebar.muted[].roomId',
  'ui.sidebar.ungroupedDisplayFilter',
  'ui.shapes.active',
  'ui.shapes.agentDefaults',
  'ui.shapes.autoFollowAgent',
  'ui.statusBar.pins',
  'logging.level',
  'logging.maxLogSizeKb',
  'logging.maxLogFiles',
  'relay.enabled',
  'relay.dataDir',
  'scheduler.enabled',
  'scheduler.timezone',
  'scheduler.retentionCount',
  'onboarding.completedSteps',
  'onboarding.skippedSteps',
  'onboarding.startedAt',
  'onboarding.dismissedAt',
  'onboarding.completedAt',
  'onboarding.runtimeDefaultSetAt',
  'tours.seen',
  'tours.declined',
  // The user profile (spec user-profile-onboarding): empty/null defaults send
  // nothing, grant nothing, and relax no bound. No PROTECTIVE_CARRYOVERS rule:
  // no leaf has a "more protective" direction — losing a profile to a config
  // wipe loses a preference, not a protection, and `rolePromptDismissedAt`
  // resetting merely re-shows one dismissible card.
  'profile.roles',
  'profile.tools',
  'profile.displayName',
  'profile.rolePromptDismissedAt',
  'agents.defaultDirectory',
  'agents.defaultAgent',
  'workspace.enabled',
  'workspace.rootPath',
  'workspace.portBase',
  'workspace.portBlockSize',
  'workspace.defaultProvider',
  'workspace.retentionCap',
  'workbench.defaultViewers',
  'workbench.terminalGraceTtlMinutes',
  'workbench.autoOpenDiff',
  // Fields OF a configured raw-MCP server entry. The protective default is
  // structural: `connectors.rawMcpServers` ships EMPTY, so no tool endpoint
  // exists until a person writes one; these leaves carry no default of their
  // own (they exist only inside an entry someone added).
  'connectors.rawMcpServers[].slug',
  'connectors.rawMcpServers[].displayName',
  'connectors.rawMcpServers[].url',
  'connectors.rawMcpServers[].transport',
  'runtimes.default',
  // Fields OF a registered Claude account (spec claude-code-accounts). The
  // protection is structural, exactly as it is for the raw-MCP entries above:
  // `runtimes.claudeCode.accounts` ships EMPTY, so no account is known until a
  // person registers one, and these leaves carry no default of their own. A path
  // and a human label send nothing and grant nothing on their own — which
  // account WORK runs on is `activeAccount`, classified `safe` below.
  'runtimes.claudeCode.accounts[].path',
  'runtimes.claudeCode.accounts[].label',
  // The per-runtime execution defaults all ship `null`, which means "let the
  // runtime choose" — byte-for-byte the behavior before the fields existed. No
  // safety axis: a model id and an effort rung send nothing off the machine,
  // grant no capability, and enforce no bound. Spend is the nearest thing to an
  // axis and it does not qualify — the default picks no model at all, so an
  // upgrade cannot move anybody onto a more expensive one.
  'runtimes.claudeCode.defaultModel',
  'runtimes.claudeCode.defaultEffort',
  'runtimes.opencode.defaultModel',
  'runtimes.codex.defaultModel',
  'runtimes.codex.defaultEffort',
  'runtimes.opencode.enabled',
  'runtimes.opencode.binaryPath',
  'runtimes.opencode.port',
  'runtimes.codex.enabled',
  'runtimes.codex.binaryPath',
];

/**
 * Leaves whose default is the protective option: a gate that starts closed, a
 * bound that starts on, a list or credential slot that starts empty. Each maps
 * to the value `USER_CONFIG_DEFAULTS` really carries, so the drift guard fails
 * when a `.default(...)` flips underneath the verdict.
 *
 * Most need no carryover rule in `protected-state.ts` — a wipe lands on them for
 * free. **Five do have one anyway**, and the distinction matters: `rooms.*`,
 * `approvals.trustWindowMinutes` and `approvals.standingGrantsVoidBefore` all
 * ship at a real bound, and a person can tighten PAST it. Landing back on the
 * shipped default would still loosen what they set.
 */
export const SAFE_DEFAULTS: Readonly<Record<string, unknown>> = {
  // Public exposure starts off, with no hostname, token, or edge passcode.
  'tunnel.enabled': false,
  'tunnel.domain': null,
  'tunnel.authtoken': null,
  'tunnel.auth': null,
  // Nothing is scanned until a person names a root.
  'mesh.scanRoots': [],
  // Every room bound ships ON, so an upgraded install is bounded too.
  'rooms.maxAgentDepth': 3,
  'rooms.maxAutomaticTurnsPerRoomPerHour': 60,
  'rooms.maxAutomaticTurnsTotalPerHour': 240,
  // How long a room waits, and when it gives up. Neither is a spend bound, so
  // the safe value is simply the shipped one.
  'rooms.replyWaitMinutes': 10,
  'rooms.lateReplyCeilingMinutes': 60,
  // The engaged window's two ceilings. Both ARE bounds: they are what stops
  // `engaged` becoming `always` with extra steps, and a person can set either
  // lower.
  'rooms.engagedWindowMinutes': 10,
  'rooms.engagedWindowPosts': 5,
  // The two welcome-back bounds (spec `team-room-home`, D5.2). Both bound the
  // noise a return can produce: four hours before an absence counts at all, and
  // at most three posts when it does. Both carry across a wipe, in opposite
  // directions — `maxPosts` is a cap, so tightening it means lowering it, while
  // `absenceThresholdMinutes` is a threshold something has to cross, so
  // tightening it means RAISING it (`direction: 'higher'`).
  'welcomeBack.absenceThresholdMinutes': 240,
  'welcomeBack.maxPosts': 3,
  // Upload size and count caps are real limits at their defaults.
  'uploads.maxFileSize': 10485760,
  'uploads.maxFiles': 10,
  'scheduler.maxConcurrentRuns': 1,
  // No user extension runs its code until a person approves it (DOR-516).
  'extensions.enabled': [],
  'extensions.disabled': [],
  'extensions.approvedToRun': [],
  // No installed package writes a shell command into a coding agent's hook files
  // until a person approves those exact commands (DOR-522).
  'harness.approvedHooks': [],
  // No static shared secret; the per-instance local token gates /mcp instead.
  'mcp.apiKey': null,
  'mcp.rateLimit.enabled': true,
  'mcp.rateLimit.maxPerWindow': 60,
  'mcp.rateLimit.windowSecs': 60,
  // ALL telemetry is opt-in (ADR 260727-181825, superseding 260713-143958's
  // Tier 1 posture), and the notice gate starts un-shown on top of that.
  'telemetry.install': false,
  'telemetry.heartbeat': false,
  'telemetry.usage': false,
  'telemetry.userHasDecided': false,
  'telemetry.lastPromptedVersion': null,
  'telemetry.errorReporting': false,
  'telemetry.linkAnalyticsToAccount': false,
  'telemetry.aiMetadata': false,
  // No Claude account is chosen, so DorkOS points at whatever the environment
  // already pointed at and reaches for no other sign-in. The directory this names
  // is where that account's credential material lives, which puts it on the same
  // axis as the references below: the slot starts empty (spec claude-code-accounts).
  'runtimes.claudeCode.activeAccount': null,
  // Credential references start empty (ADR-0315).
  'runtimes.opencode.provider': null,
  'runtimes.opencode.baseURL': null,
  'runtimes.codex.credentialRef': null,
  providers: {},
  // Standing permissions cannot exist until asked for; the void floor is
  // vacuously null because no grant exists yet on a fresh install.
  'approvals.standingGrants': false,
  'approvals.trustWindowMinutes': 480,
  'approvals.standingGrantsVoidBefore': null,
  // No standing answer to "how much may a new session do without asking", so
  // every runtime keeps its own default — and no shipped runtime defaults to a
  // stop that stops asking (pinned across the whole set by
  // `services/runtimes/__tests__/permission-semantics.test.ts`). `null` is
  // therefore the protective value on a real axis: the permissive one is
  // reachable here, it is `'autonomy'`, and it takes a person and a consent
  // dialog to write (spec `trust-dial`, decision 6).
  'runtimes.defaultTrustStop': null,
  'runtimes.claudeCode.defaultTrustStop': null,
  'runtimes.codex.defaultTrustStop': null,
  'runtimes.opencode.defaultTrustStop': null,
  // Nobody has been told what Full autonomy means, so DorkOS still tells them:
  // `null` is the value that keeps the door asking. A wipe landing here is the
  // right outcome — losing a consent record only costs one dialog, while keeping
  // one through a reset would silence a question nobody re-answered.
  'ui.autonomyAcknowledgedAt': null,
  // No account link, so no identity leaves the machine.
  'cloud.instanceToken': null,
  'cloud.instanceName': null,
  'cloud.linkedAccountLabel': null,
};

/**
 * Leaves whose default is the permissive option, each with the argument for it.
 *
 * Every entry here is a deliberate, reviewable trade — not an oversight. Keep
 * the list short and the reasons concrete; "it is convenient" is not a reason,
 * and a reason that no longer holds means the default should move, not that the
 * text should be softened.
 */
export const PERMISSIVE_DEFAULTS: Readonly<Record<string, PermissiveDefault>> = {
  'auth.enabled': {
    value: false,
    reason:
      'Login off by default is progressive disclosure: a single-user local install shows no account concept at all. The relaxation is bounded by two other gates that read this value — `exposure-guard.ts` refuses every non-loopback bind and every tunnel start while login is off, and `host-guard.ts` runs the DNS-rebinding guard specifically in this posture — so the permissive default cannot be combined with exposure.',
  },
  'mcp.enabled': {
    value: true,
    reason:
      'The external tool endpoint answers by default because wiring an agent to DorkOS is the product. It is not ungated: `mcp-auth.ts` fails closed for everything but the handshake and read-only tools, and the per-instance local token gates the rest.',
  },
  'agentContext.relayTools': {
    value: true,
    reason:
      'Agent-to-agent messaging is the coordination layer DorkOS exists to provide; an agent that cannot reach the bus cannot do the job it was installed for. Scoped to this machine and subject to the same tier gate as every other capability.',
  },
  'agentContext.meshTools': {
    value: true,
    reason:
      'Agent discovery is the coordination layer DorkOS exists to provide. Local-only, and read-mostly.',
  },
  'agentContext.adapterTools': {
    value: true,
    reason:
      'Chat-adapter tools let an agent answer on the channel it was addressed from. The adapters themselves start disconnected and need credentials, so this flag alone reaches nothing.',
  },
  'agentContext.tasksTools': {
    value: true,
    reason:
      'Scheduled-work tools are core to unattended operation. Task creation through the API and MCP surfaces parks at `pending_approval` regardless of this flag.',
  },
  'uploads.allowedTypes': {
    value: ['*/*'],
    reason:
      'Accepts every MIME type, because an agent working on a real codebase receives arbitrary file types and a curated allowlist would reject legitimate work. The size and count caps stay on and are the real bound.',
  },
  'welcomeBack.enabled': {
    value: true,
    reason:
      'Agents may greet you on your return by default, because a coordination layer whose agents worked all night and said nothing about it has not coordinated anything. The permissive side is bounded rather than open: only agents with a real change to report qualify, at most `maxPosts` of them speak, an absence has to pass `absenceThresholdMinutes` to count, and the posts ride the ordinary room path, so the cascade guard and both automatic-turn spend caps hold them like any other turn.',
  },
  'harness.autoSync': {
    value: true,
    reason:
      "Projecting `.agents/` and installed plugins into a project's harness directories is what makes an installed skill actually reach the agent; without it, every install would silently do nothing. Writes are confined to harness directories inside projects the person has already opened.",
  },
};

/**
 * The verdict for one config leaf.
 *
 * @param path - A dot-path as `configSchemaLeafPaths()` reports it.
 * @returns The verdict, or `undefined` when nobody has classified the leaf.
 */
export function verdictFor(path: string): DefaultVerdict | undefined {
  if (Object.hasOwn(PERMISSIVE_DEFAULTS, path)) return 'permissive';
  if (Object.hasOwn(SAFE_DEFAULTS, path)) return 'safe';
  if (NO_RISK_DEFAULTS.includes(path)) return 'no-risk';
  return undefined;
}

/**
 * The default value a verdict claims this leaf ships with, for the drift guard
 * to compare against `USER_CONFIG_DEFAULTS`.
 *
 * `no-risk` leaves carry no recorded value: their whole point is that the value
 * has no safety consequence, so pinning it would be churn on every preference
 * tweak.
 *
 * @param path - A dot-path as `configSchemaLeafPaths()` reports it.
 * @returns The recorded value, or `undefined` when none is recorded.
 */
export function recordedDefaultFor(path: string): { value: unknown } | undefined {
  if (Object.hasOwn(PERMISSIVE_DEFAULTS, path)) {
    return { value: PERMISSIVE_DEFAULTS[path]!.value };
  }
  if (Object.hasOwn(SAFE_DEFAULTS, path)) return { value: SAFE_DEFAULTS[path] };
  return undefined;
}
