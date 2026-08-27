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
 * `safe` and needs no carryover rule, while `rooms.maxTurnsPerAgentPerCascade`
 * defaults to a real bound (`safe`) and still needs one, because a person may
 * have tightened it further. The guard checks the one relationship that must hold: a carryover
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
  'ui.sidebar.sections',
  'ui.sidebar.muted[].kind',
  'ui.sidebar.muted[].path',
  'ui.sidebar.muted[].roomId',
  'ui.sidebar.gettingStarted.retired',
  'ui.sidebar.digest.lastShownDate',
  'ui.promos.dismissedIds',
  'ui.shapes.active',
  'ui.shapes.agentDefaults',
  'ui.shapes.autoFollowAgent',
  'ui.statusBar.pins',
  'ui.composer.richText',
  // The power-door answer, both halves (spec `full-power-defaults`, D1). Records
  // of an ANSWER and nothing more: they send nothing off the machine, grant no
  // capability, and no gate reads them. That is what separates them from
  // `ui.autonomyAcknowledgedAt` next door, which is classified `safe` because the
  // server's autonomy gate really does read it — a value there decides whether a
  // 428 is raised, and a value here decides whether a modal is shown. A wipe that
  // lands both back on `null` simply puts the question again, which is the right
  // outcome and costs one dialog.
  'ui.fullPowerDecidedAt',
  'ui.fullPowerChoice',
  // How loud DorkOS is, and how long before it tries a louder channel. No data
  // moves on any of these: the sounds and the browser notification are this
  // machine talking to the person at it, and `phoneAfterMinutes` cannot deliver
  // anywhere until a device is separately subscribed — an explicit opt-in that
  // does not exist yet (spec `notification-system`, W3 T10). **When it does,
  // move `escalation.phoneAfterMinutes` out of this list**: a number that starts
  // an outbound send is a safety verdict, not a preference.
  'notifications.escalation.phoneAfterMinutes',
  'notifications.sounds.knock',
  'notifications.sounds.allClear',
  'notifications.sounds.turnEnd',
  'notifications.notifyOnTurnCompleteWhileAway',
  'notifications.browserPermissionPrimerDismissed',
  'logging.level',
  'logging.maxLogSizeKb',
  'logging.maxLogFiles',
  'relay.enabled',
  'relay.dataDir',
  'scheduler.enabled',
  'scheduler.retentionCount',
  // When an idle agent working copy is tidied away, and how long a queued merge
  // waits its turn. Neither enforces a safety bound: the reap sweep spares
  // anything dirty or unmerged BY CONSTRUCTION, so no value of the first can
  // lose work, and the second buys patience rather than any file, byte or turn.
  // Both are operator-only to WRITE — one governs a deletion on disk — which is
  // a different question from what their defaults do, and the module docs above
  // say so.
  'rooms.repo.worktreeReapDays',
  'rooms.repo.mergeQueueWaitMs',
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
  // an id and a human label send nothing and grant nothing on their own — which
  // account WORK runs on is `defaultAccount`, classified `safe` below.
  'runtimes.claudeCode.accounts[].id',
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
 * free. **Several do have one anyway**, and the distinction matters: the
 * `rooms.*` bounds, `approvals.trustWindowMinutes` and
 * `approvals.standingGrantsVoidBefore` all ship at a real bound, and a person
 * can tighten PAST it. Landing back on the shipped default would still loosen
 * what they set.
 */
export const SAFE_DEFAULTS: Readonly<Record<string, unknown>> = {
  // Public exposure starts off, with no hostname, token, or edge passcode.
  'tunnel.enabled': false,
  // The external A2A surface starts unmounted, so no agent outside DorkOS can
  // reach the ones inside it until a person opens that door (DOR-1304).
  'a2a.enabled': false,
  'tunnel.domain': null,
  'tunnel.authtoken': null,
  'tunnel.auth': null,
  // Nothing is scanned until a person names a root.
  'mesh.scanRoots': [],
  // Which backend holds what an agent remembers (spec `agent-memory`, D7). A
  // real axis rather than a preference: `'builtin'` is one markdown file beside
  // the agent, on this machine, and every other value this key could name is a
  // backend that holds the same notes somewhere else. The default lands on the
  // one that keeps them here. No PROTECTIVE_CARRYOVERS rule: a wipe lands back
  // on `'builtin'`, which IS the protective value, so there is nothing a
  // carryover could restore that recovery does not already give.
  'memory.provider': 'builtin',
  // Automatic replies are limited by default (DOR-1428). The three numbers
  // beneath this switch are permissive at the values they now ship — see
  // PERMISSIVE_DEFAULTS — but the switch itself is the protective side of a
  // real axis: off means no bound of any kind runs.
  'rooms.turnLimitsEnabled': true,
  // How many turns one agent may take inside one exchange. A real bound at its
  // default, and the tightest a person might want is lower, so it carries.
  'rooms.maxTurnsPerAgentPerCascade': 10,
  // How long a room waits, and when it gives up. Neither is a spend bound, so
  // the safe value is simply the shipped one.
  'rooms.replyWaitMinutes': 10,
  'rooms.lateReplyCeilingMinutes': 60,
  // The engaged window's two ceilings. Both ARE bounds: they are what stops
  // `engaged` becoming `always` with extra steps, and a person can set either
  // lower.
  'rooms.engagedWindowMinutes': 10,
  'rooms.engagedWindowPosts': 5,
  // The collect window's two ceilings (room-participation spec §10.4). Both are
  // bounds on how many turns a burst of messages costs — a pause of zero and a
  // cap of one would be one turn per message — so the shipped values are the
  // bounded side, and the protective direction for both is HIGHER.
  'rooms.collectDebounceMs': 500,
  'rooms.collectMaxEntries': 20,
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
  // The three ceilings a merge into a room's own files is refused against (spec
  // `project-rooms` §3.6). Real bounds at their defaults, on the same footing as
  // the upload caps above: what they hold back is content member agents wrote,
  // arriving in a tree the server owns. A person can tighten any of them, so all
  // three carry across a wipe.
  'rooms.repo.maxFileBytes': 5242880,
  'rooms.repo.maxRepoBytes': 524288000,
  'rooms.repo.maxRoomMdBytes': 24576,
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
  'runtimes.claudeCode.defaultAccount': null,
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
  'rooms.repo.enabled': {
    value: true,
    reason:
      "A room may have files of its own by default: a git checkout under the DorkOS data directory that member agents run tools in. The narrow reading is that shipping ON grants nothing on the day it lands — no room has files until a person gives them to it, and enabling a room's repo is operator-only and never an agent capability — but the switch is what decides whether that surface can exist at all, and calling it a preference would make the carryover rule beside it read as ceremony. So it is argued here instead. The relaxation is bounded rather than open: every merge is server-mediated and serialized, refused for an escaping symlink or an over-cap file, and nothing in a room's files executes at sync or merge time (git does not clone hooks). Nothing in a room can widen what an agent is permitted to do — permission mode, capability tiers and standing grants stay member-owned and unreachable from room content. Turning it off is one setting that puts every room back to behaving exactly as it does today, nothing on disk is deleted, and PROTECTIVE_CARRYOVERS keeps that off through a wipe.",
  },
  'welcomeBack.enabled': {
    value: true,
    reason:
      'Agents may greet you on your return by default, because a coordination layer whose agents worked all night and said nothing about it has not coordinated anything. The permissive side is bounded rather than open: only agents with a real change to report qualify, at most `maxPosts` of them speak, an absence has to pass `absenceThresholdMinutes` to count, and the posts ride the ordinary room path, so the cascade guard and both automatic-turn spend caps hold them like any other turn.',
  },
  'welcomeBack.offersEnabled': {
    value: true,
    reason:
      'The only default in this table that spends money on its own, and it is listed here rather than argued away: an offer runs an agent for a turn, and shipping ON says yes to that before the person does. The case for it is that the offer is the part of a return worth reading — a note saying what happened is history, a note ending in "want me to open the PR?" is the next thing you would have had to go and ask for — and a spend switch nobody ever finds is a feature nobody has. The relaxation is bounded rather than open: only agents that already earned a note are asked, at most `maxPosts` of them, at most one turn each per return, and every offer rides the ordinary room path, so both automatic-turn caps hold it like any other turn. It is also the most visible one here — the switch states the cost in the sentence beside it, turning it off is one click, and PROTECTIVE_CARRYOVERS keeps that off through a wipe.',
  },
  // The three raised room bounds (DOR-1428, plan `room-turn-limits-overhaul`).
  // Grouped rather than argued three times: they are one decision, and the
  // reason is the same sentence in each.
  'rooms.maxAgentDepth': {
    value: 30,
    reason:
      "Agents get thirty replies in a row rather than three, because three is not a conversation: two agents working something out spend the first two hops agreeing what the question is. The old default was chosen to be obviously safe and turned out to be obviously too small — it stopped exchanges the person had asked for, and the room said so in a notice that read as a fault. It is still a bound in code, still resets on the person's own message, and the hourly caps below are what actually holds the bill.",
  },
  'rooms.maxAutomaticTurnsPerRoomPerHour': {
    value: 1000,
    reason:
      'The per-room hourly cap is raised in proportion to the reply limit above: at sixty an hour a single busy room hit it during ordinary work, and a cap that fires during ordinary work teaches people to turn caps off. It still keeps one runaway room from eating the whole install allowance, which is the job it exists for.',
  },
  'rooms.maxAutomaticTurnsTotalPerHour': {
    value: 5000,
    reason:
      'The install-wide cap, and the one that names the real exposure: a fresh install can now spend about five thousand automatic model turns in an hour if two agents talk in circles all night. That is deliberate — this cap is the backstop, not the everyday limit, and it is set where it stops a runaway rather than where it stops work. ADR 260823-000218 owns the trade in full, including the fact that the numbers are editable and the room says which cap stopped it.',
  },
  'harness.autoSync': {
    value: true,
    reason:
      "Projecting `.agents/` and installed plugins into a project's harness directories is what makes an installed skill actually reach the agent; without it, every install would silently do nothing. Writes are confined to harness directories inside projects the person has already opened.",
  },
  'runtimes.claudeCode.persistentSession': {
    value: true,
    reason:
      'A warm agent holds a process open between messages — the same executable, the same permissions, the same per-dispatch boundary check — so nothing about what it may DO changes and no gate is relaxed. It is listed here rather than as `no-risk` because it does spend something on its own: memory, up to about 1 GB per warm agent. That is bounded in code rather than by this leaf (at most twelve stay warm, and the idle reaper closes the rest), and turning it back off is one switch away: the `Warm agents` row in the Control Center (#1209), which is where the control that left Settings → Experiments now lives.',
  },
  'scheduler.maxConcurrentRuns': {
    value: 4,
    reason:
      'Four scheduled runs at once instead of one moves a resource throttle off the FLOOR of its own declared range (1–10) — it is not a capability grant, because nothing about what a run may do changes, and every run still passes the same approval gates and the same file clamp. What it relaxes is queueing: one slow run no longer holds up every schedule behind it. The bound the schema already enforces is unchanged, and a person who wants the old behavior sets it back to 1.',
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
