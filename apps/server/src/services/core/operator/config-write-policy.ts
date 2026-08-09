/**
 * The write allowlist behind the operator `config_patch` capability: an explicit,
 * per-field classification of which user-config settings an AGENT may change and
 * which only a person may.
 *
 * ## Why this exists
 *
 * `operator.config_patch` is tier `act`, so the tier gate lets it through with no
 * approval (ADR 260725-133220). The patch it carries used to be unbounded: any
 * value that survived `UserConfigSchema` was written. That included
 * `auth.enabled`, and that is not just one more setting.
 *
 * The approval gate that stops destructive work only means something in the
 * logged-in posture, because that is where deciding an approval requires an
 * authenticated person. With login off, the server cannot tell the person in the
 * cockpit from any process running as the same user, which the threat model
 * documents and accepts. So `config_patch({ auth: { enabled: false } })` was an
 * ungated path, from inside the capability surface, to removing the precondition
 * that makes every destructive approval enforceable. The safety feature could
 * switch off its own foundation.
 *
 * ## Refuse, not promote
 *
 * These fields are refused outright rather than promoted to tier `destructive`
 * and put behind an approval card, for three reasons:
 *
 * 1. There is no operator task that requires an agent to change the
 *    authentication posture, the exposure settings, or where credentials come
 *    from. The person is already sitting in Settings, where the real controls are.
 * 2. An approval card only helps if the person reliably says no. `auth.enabled`
 *    is precisely the setting where a confused or socially-engineered yes voids
 *    every other approval they will ever be asked, so it is the worst possible
 *    thing to route through the same click.
 * 3. Tiers are per-capability and come from the registry, never from the
 *    requester (`tier-enforcement.ts`). Promoting would mean an input-dependent
 *    tier, a new mechanism at all three choke points, to buy a weaker guarantee.
 *
 * ## Where the guard runs, and where it must not
 *
 * The guard runs at the CAPABILITY HANDLER (`createConfigPatchHandler`), which is
 * the layer that knows an agent asked. It deliberately does NOT run inside
 * {@link applyConfigPatch}: the cockpit's own enable-login and disable-login flows
 * (`OwnerSetupHost.tsx`, `SecurityPanel.tsx`) reach that shared function through
 * `PATCH /api/config`, and guarding it there would break the legitimate human
 * path this whole feature exists to protect.
 *
 * ## The line
 *
 * A field is `operator-only` when changing it, on its own, removes or widens a
 * security control:
 *
 * - **The login gate.** `auth.enabled`.
 * - **Public exposure.** All of `tunnel.*`: whether this instance is reachable
 *   from the internet, on what hostname, with which ngrok account, and whether a
 *   second factor sits at that edge. Planting an attacker's `authtoken` means the
 *   next time a person starts a tunnel, they expose their machine into somebody
 *   else's ngrok account.
 * - **The external tool endpoint's own gate.** All of `mcp.*`: whether `/mcp`
 *   answers at all, the bearer that gates it (writing a known `apiKey` displaces
 *   the per-instance local token, `routes/config.ts` `authSource`), and the rate
 *   limits that bound abuse of it.
 * - **Credentials, and the pairing of a key with a destination.** `providers` and
 *   `runtimes.codex.credentialRef` are credential references (ADR-0315); `cloud.*`
 *   is the token and identity of the account link. `runtimes.opencode.baseURL` and
 *   `runtimes.opencode.provider` are BOTH here, and it has to be both:
 *   `credential-env.ts` applies `baseURL` unconditionally, outside its
 *   `if (providerId)` block, so the two fields are not independent. The connect
 *   flow always writes them together, but a patch can decouple them. If an
 *   operator once connected a Direct provider at a custom base URL, an agent
 *   flipping `provider` alone makes DorkOS hand the sidecar that provider's key
 *   AND the leftover custom `OPENAI_BASE_URL` in the same env.
 * - **Code the server loads or runs.** `extensions.*` decides which extension code
 *   is compiled into the server process, and the two `binaryPath` fields name
 *   executables the server spawns.
 * - **How far DorkOS reaches on disk.** `server.boundary` is the containment line
 *   itself (the CLI reads it at next launch, `cli.ts`), and `workspace.rootPath`
 *   and `relay.dataDir` are roots DorkOS resolves and writes under with no
 *   boundary check of their own. `agents.defaultDirectory` and `mesh.scanRoots`
 *   join them for weaker but deliberate reasons, stated at each entry below
 *   rather than folded into this one: neither is an unchecked write today.
 * - **Consent about what leaves the machine.** All of `telemetry.*`, which is
 *   consent-gated by design.
 *
 * ### Considered and deliberately left writable
 *
 * Refusing more than the line justifies makes the capability useless and invites
 * the next person to loosen it wholesale, so these stay `agent-writable` on
 * purpose:
 *
 * - `server.cwd` — a starting directory, and a path field the CLI DOES validate
 *   against the boundary (it falls back to the boundary root when the configured
 *   value sits outside). It picks a spot on ground the agent already has.
 * - `server.port`, `server.open` — moving or not-opening the cockpit is disruptive,
 *   not an escalation.
 * - `version` — a `z.literal(1)`, so the only value that validates is the one
 *   already stored.
 *
 * @module services/core/operator/config-write-policy
 */

/**
 * Whether an agent may write one config leaf through `config_patch`.
 *
 * - `agent-writable` — a preference. An agent may change it on the user's word.
 * - `operator-only` — changing it removes or widens a security control, so the
 *   agent surface refuses it and the person changes it in Settings themselves.
 */
export type ConfigWriteAccess = 'agent-writable' | 'operator-only';

/**
 * Every leaf of `UserConfigSchema`, classified for the AGENT write surface. Keys
 * are dot-paths and must match the schema exactly in both directions: the drift
 * guard in `__tests__/config-write-policy.test.ts` asserts it, so adding,
 * renaming, or removing a config field fails the build until this table carries a
 * deliberate verdict for it.
 *
 * Ordered to mirror the schema (and `CONFIG_DISCLOSURE`) so a reviewer can read
 * the read side and the write side next to each other.
 */
export const CONFIG_WRITE_POLICY = {
  // A `z.literal(1)`: the only value that validates is the one already stored.
  version: 'agent-writable',

  'server.port': 'agent-writable',
  'server.cwd': 'agent-writable',
  // The containment line for every raw file surface. The CLI reads it at next
  // launch (`cli.ts`), so widening it here widens what DorkOS may touch.
  'server.boundary': 'operator-only',
  'server.open': 'agent-writable',

  // Public exposure, the hostname it happens on, whose ngrok account carries it,
  // and the second factor at that edge.
  'tunnel.enabled': 'operator-only',
  'tunnel.domain': 'operator-only',
  'tunnel.authtoken': 'operator-only',
  'tunnel.auth': 'operator-only',

  'ui.theme': 'agent-writable',
  'ui.dismissedUpgradeVersions': 'agent-writable',
  // A sidebar item reference is a discriminated union of objects, so the `[]`
  // descent enumerates each branch's fields (same convention as
  // `CONFIG_DISCLOSURE`).
  'ui.sidebar.pinned[].kind': 'agent-writable',
  'ui.sidebar.pinned[].path': 'agent-writable',
  'ui.sidebar.pinned[].roomId': 'agent-writable',
  // A sidebar group is an object inside an array, so each of its fields carries
  // its own verdict (the `[]` descent, same convention as `CONFIG_DISCLOSURE`).
  // A property added to a group is unclassified, so the guard fails until someone
  // decides. If one of these ever becomes `operator-only`, `patchPaths` must learn
  // to descend into arrays first — today it stops at `ui.sidebar.groups`, which is
  // harmless only because every verdict below is `agent-writable`.
  'ui.sidebar.groups[].id': 'agent-writable',
  'ui.sidebar.groups[].name': 'agent-writable',
  'ui.sidebar.groups[].items[].kind': 'agent-writable',
  'ui.sidebar.groups[].items[].path': 'agent-writable',
  'ui.sidebar.groups[].items[].roomId': 'agent-writable',
  'ui.sidebar.groups[].sortMode': 'agent-writable',
  'ui.sidebar.groups[].collapsed': 'agent-writable',
  'ui.sidebar.groups[].displayFilter': 'agent-writable',
  'ui.sidebar.groups[].muted': 'agent-writable',
  'ui.sidebar.groups[].kind': 'agent-writable',
  'ui.sidebar.groups[].rules.runtimes': 'agent-writable',
  'ui.sidebar.groups[].rules.namespaces': 'agent-writable',
  'ui.sidebar.groups[].rules.statuses': 'agent-writable',
  'ui.sidebar.groups[].rules.lastActiveWithinMs': 'agent-writable',
  'ui.sidebar.groups[].rules.pathPrefix': 'agent-writable',
  'ui.sidebar.ungroupedSortMode': 'agent-writable',
  'ui.sidebar.ungroupedCollapsed': 'agent-writable',
  'ui.sidebar.recentsCollapsed': 'agent-writable',
  'ui.sidebar.channelsCollapsed': 'agent-writable',
  'ui.sidebar.threadsCollapsed': 'agent-writable',
  'ui.sidebar.dmsCollapsed': 'agent-writable',
  'ui.sidebar.groupsHintDismissed': 'agent-writable',
  'ui.sidebar.muted[].kind': 'agent-writable',
  'ui.sidebar.muted[].path': 'agent-writable',
  'ui.sidebar.muted[].roomId': 'agent-writable',
  'ui.sidebar.ungroupedDisplayFilter': 'agent-writable',
  'ui.shapes.active': 'agent-writable',
  'ui.shapes.agentDefaults': 'agent-writable',
  'ui.shapes.autoFollowAgent': 'agent-writable',
  'ui.statusBar.pins': 'agent-writable',
  // A record of what a PERSON read and agreed to. Writing it stops DorkOS ever
  // explaining Full autonomy to them again, and an agent forging that record
  // would be signing a consent form on somebody else's behalf. It is the only
  // `ui.*` leaf that is not a preference.
  //
  // It buys the agent no new REACH — anything that can reach `PATCH
  // /api/sessions/:id` can put `acknowledgedAutonomy: true` on the request and
  // open the same door once. What this stops is the durable, silent version.
  'ui.autonomyAcknowledgedAt': 'operator-only',

  'logging.level': 'agent-writable',
  'logging.maxLogSizeKb': 'agent-writable',
  'logging.maxLogFiles': 'agent-writable',

  'relay.enabled': 'agent-writable',
  // A directory DorkOS writes message history into, resolved without a boundary check.
  'relay.dataDir': 'operator-only',

  'scheduler.enabled': 'agent-writable',
  'scheduler.maxConcurrentRuns': 'agent-writable',
  'scheduler.timezone': 'agent-writable',
  'scheduler.retentionCount': 'agent-writable',

  // Directories DorkOS would scan for agents. Nothing resolves this today (the
  // unified scanner does not read it), so it grants nothing right now. It is
  // operator-only pre-emptively: it is a directory-scope field, and classifying it
  // while it is inert is what stops it becoming load-bearing while agent-writable.
  'mesh.scanRoots': 'operator-only',

  // How far agents may reply to each other in a room before it stops them
  // (ADR 260726-170127). Operator-only for the same reason room rosters are: an
  // agent that can raise its own reply ceiling can spend the operator's model
  // budget on a conversation nobody asked for, and the whole point of the guard
  // is that it bounds a loop the participants cannot see themselves in.
  'rooms.maxAgentDepth': 'operator-only',
  // The per-room spend cap. Operator-only for a sharper reason than the ceiling
  // above: this bound exists precisely BECAUSE an agent can defeat the
  // identity-based one in the default posture (DOR-505), so leaving it
  // agent-writable would hand back the thing it was built to hold.
  'rooms.maxAutomaticTurnsPerRoomPerHour': 'operator-only',
  'rooms.maxAutomaticTurnsTotalPerHour': 'operator-only',
  // How long a room waits, and when it gives up. Neither removes a bound: a
  // longer wait costs patience, not turns, and the spend caps above are what
  // hold the bill whatever these say.
  'rooms.replyWaitMinutes': 'agent-writable',
  'rooms.lateReplyCeilingMinutes': 'agent-writable',
  // How long an agent stays addressable after somebody talks to it, and how many
  // other people's messages end that. Operator-only, on the far side of the line
  // the two waits above sit on: these decide when a turn RUNS, not how long the
  // room waits for one that was already going to. An agent that could lengthen
  // its own window would be voting itself back into every conversation it was
  // ever addressed in — the widening this whole mode exists to bound.
  'rooms.engagedWindowMinutes': 'operator-only',
  'rooms.engagedWindowPosts': 'operator-only',

  // Whether agents may speak when the person comes back, how long an absence
  // has to be to count, and how many may speak. All three sit on the far side
  // of the line the two room WAITS above sit on, for the reason the engaged
  // window does: they decide whether a turn RUNS and how many run, not how long
  // a room waits for one that was already going to. An agent that could lower
  // the threshold, raise the cap, or switch the feature on for itself would be
  // voting itself a greeting the person never asked for — and a greeting with a
  // next-step offer costs a model turn.
  'welcomeBack.enabled': 'operator-only',
  'welcomeBack.absenceThresholdMinutes': 'operator-only',
  'welcomeBack.maxPosts': 'operator-only',

  'onboarding.completedSteps': 'agent-writable',
  'onboarding.skippedSteps': 'agent-writable',
  'onboarding.startedAt': 'agent-writable',
  'onboarding.dismissedAt': 'agent-writable',
  'onboarding.completedAt': 'agent-writable',
  // A timestamp saying the first-run flow already picked a default runtime. It
  // grants nothing and guards nothing; an agent rewriting it can at most let
  // first-run setup ask the question again on a machine that is past it.
  'onboarding.runtimeDefaultSetAt': 'agent-writable',

  'tours.seen': 'agent-writable',
  'tours.declined': 'agent-writable',

  // The user profile (spec user-profile-onboarding). Agent-writability is
  // deliberate: DorkBot saves "call me Dorian" or "I also use Figma" via
  // config_patch mid-conversation — that is how tools and displayName get
  // populated after onboarding. Changing a profile field removes or widens no
  // security control; the profile never leaves the machine (tested invariant).
  'profile.roles': 'agent-writable',
  'profile.tools': 'agent-writable',
  'profile.displayName': 'agent-writable',
  'profile.rolePromptDismissedAt': 'agent-writable',

  'agentContext.relayTools': 'agent-writable',
  'agentContext.meshTools': 'agent-writable',
  'agentContext.adapterTools': 'agent-writable',
  'agentContext.tasksTools': 'agent-writable',

  'uploads.maxFileSize': 'agent-writable',
  'uploads.maxFiles': 'agent-writable',
  'uploads.allowedTypes': 'agent-writable',

  // Where agent manifests are created. `agent-creator.ts` DOES boundary-check the
  // resolved path (403 on a violation), so this is not an unchecked write. It is
  // operator-only for a narrower reason: it is the default home for every agent
  // identity on this install, including where `validateBoundaryOrDorkHome` grants
  // dork-home's wider reach, and moving it is a setup decision rather than a
  // preference.
  'agents.defaultDirectory': 'operator-only',
  'agents.defaultAgent': 'agent-writable',

  // Which extension code is compiled and loaded into the server process. The
  // cockpit toggles these through `/api/extensions`, not through a config patch.
  'extensions.enabled': 'operator-only',
  'extensions.disabled': 'operator-only',
  // The standing consent that lets one extension's code execute INSIDE the server
  // process, with the server's privileges and outside the tier gate (DOR-516).
  // This is the record of a human decision, so a caller that can write it can
  // manufacture that decision — the textbook case of "changing it removes a
  // security control", and the reason the whole gate hangs off a config field
  // instead of anything under the project tree an agent edits freely.
  'extensions.approvedToRun': 'operator-only',

  // Whether the external tool endpoint answers, the bearer that gates it, and the
  // rate limits that bound abuse of it.
  'mcp.enabled': 'operator-only',
  'mcp.apiKey': 'operator-only',
  'mcp.rateLimit.enabled': 'operator-only',
  'mcp.rateLimit.maxPerWindow': 'operator-only',
  'mcp.rateLimit.windowSecs': 'operator-only',

  // Consent about what leaves the machine. Consent-gated by design (DOR-170),
  // which means the person decides, not the agent running on their behalf.
  'telemetry.userHasDecided': 'operator-only',
  'telemetry.install': 'operator-only',
  'telemetry.heartbeat': 'operator-only',
  'telemetry.errorReporting': 'operator-only',
  'telemetry.lastPromptedVersion': 'operator-only',
  'telemetry.usage': 'operator-only',
  'telemetry.linkAnalyticsToAccount': 'operator-only',
  'telemetry.aiMetadata': 'operator-only',

  'workspace.enabled': 'agent-writable',
  // Where worktrees are created, resolved without a boundary check.
  'workspace.rootPath': 'operator-only',
  'workspace.portBase': 'agent-writable',
  'workspace.portBlockSize': 'agent-writable',
  'workspace.defaultProvider': 'agent-writable',
  'workspace.retentionCap': 'agent-writable',

  'harness.autoSync': 'agent-writable',
  // The record of a person allowing an installed package to write shell commands
  // into the files a coding agent runs on their behalf (DOR-522). An agent that
  // could append to this list could approve its own package's hooks.
  'harness.approvedHooks': 'operator-only',

  'workbench.defaultViewers': 'agent-writable',
  'workbench.terminalGraceTtlMinutes': 'agent-writable',
  'workbench.autoOpenDiff': 'agent-writable',

  'runtimes.default': 'agent-writable',
  // How much every FUTURE session may do without asking (spec `trust-dial`,
  // decision 6). Operator-only, and it is the one field in this block that is not
  // a preference — the neighbouring model and effort leaves say how work runs,
  // this one says whether anybody is asked before it happens.
  //
  // Written to `'autonomy'` it removes the approval gate from every interactive
  // session started from then on, which is the module's line exactly: a control
  // widened by one write. Two things make it worse than the per-session change an
  // agent can already ask for. It is DURABLE — nothing sweeps it, so it keeps
  // applying to sessions the person starts tomorrow — and it is SILENT, because a
  // new session simply opens already bypassed, with no dialog and nothing on
  // screen saying a setting changed. `ui.autonomyAcknowledgedAt` is operator-only
  // for the sibling reason (forging the consent record), and an agent that could
  // write both would hold the whole door.
  //
  // The stops below autonomy are the same leaf and get the same verdict: this
  // table classifies paths, not values, and a per-value rule would mean an agent
  // could write `'ask'` today and nothing would notice the day the enum grew.
  // The route enforces a second, value-shaped gate on top for `'autonomy'` (428
  // `AUTONOMY_ACK_REQUIRED`), which is about consent rather than about who asks.
  'runtimes.defaultTrustStop': 'operator-only',
  'runtimes.claudeCode.defaultTrustStop': 'operator-only',
  'runtimes.codex.defaultTrustStop': 'operator-only',
  'runtimes.opencode.defaultTrustStop': 'operator-only',
  // Which Claude account new work runs and BILLS on, and the roster it is chosen
  // from (spec claude-code-accounts D6). A Claude config directory carries its own
  // sign-in, so moving the active account moves the operator's spend onto a
  // different subscription — for the operator this feature was written for, a
  // different paying client. That is the credential axis this module holds, so an
  // agent must not be able to do it, and it never needs to: the person picks their
  // client in the cockpit. The roster is guarded with it, because an account is
  // only selectable once it is registered.
  'runtimes.claudeCode.activeAccount': 'operator-only',
  'runtimes.claudeCode.accounts[].path': 'operator-only',
  'runtimes.claudeCode.accounts[].label': 'operator-only',
  // The execution defaults for new sessions on each runtime. Writable, and the
  // operator was asked directly: a model and an effort level are a preference
  // about how work runs, on the same footing as `runtimes.default` right above,
  // not a security control. Neither can move spend onto a different sign-in —
  // that is `activeAccount`, which stays operator-only just above. The
  // interesting case ("set yourself to the cheapest model for this batch") is a
  // reasonable thing to ask an agent to do, and a person can always see and
  // reverse it: the chip on every row says where the value came from.
  'runtimes.claudeCode.defaultModel': 'agent-writable',
  'runtimes.claudeCode.defaultEffort': 'agent-writable',
  'runtimes.opencode.defaultModel': 'agent-writable',
  'runtimes.codex.defaultModel': 'agent-writable',
  'runtimes.codex.defaultEffort': 'agent-writable',
  'runtimes.opencode.enabled': 'agent-writable',
  // An executable the server spawns.
  'runtimes.opencode.binaryPath': 'operator-only',
  'runtimes.opencode.port': 'agent-writable',
  // Decides WHICH credential is injected. Not independent of `baseURL`, which
  // `credential-env.ts` applies unconditionally outside its `if (providerId)`
  // block: flipping `provider` alone can pair a different key with a base URL the
  // operator set for some other provider. Changing provider is a connect action
  // with its own route and UI, so refusing it here costs little.
  'runtimes.opencode.provider': 'operator-only',
  // The host every prompt and the injected key are sent to.
  'runtimes.opencode.baseURL': 'operator-only',
  'runtimes.codex.enabled': 'agent-writable',
  // An executable the server spawns.
  'runtimes.codex.binaryPath': 'operator-only',
  // A credential reference (ADR-0315).
  'runtimes.codex.credentialRef': 'operator-only',

  // The login gate, and with it the precondition that makes every destructive
  // approval enforceable. See the module doc.
  'auth.enabled': 'operator-only',

  // Whether standing permissions may exist, and how long one lasts. Switching
  // them on removes the card in front of an irreversible action for a whole
  // window, and lengthening the window widens the same hole, so both sit exactly
  // on the line this module states. `operator-only` is NECESSARY here but not
  // SUFFICIENT — see REQUIRES_LOGIN_CONFIG_PATHS.
  'approvals.standingGrants': 'operator-only',
  'approvals.trustWindowMinutes': 'operator-only',
  // Machine-managed: the moment the settings last stopped licensing standing
  // permissions (DOR-520). Nothing should write it by hand at all, and the reason
  // it is classified rather than merely undocumented is that moving it BACKWARDS
  // resurrects every permission a posture change voided — the exact failure the
  // marker exists to prevent, reachable in one patch.
  'approvals.standingGrantsVoidBefore': 'operator-only',

  // The credential and the identity of the account link.
  'cloud.instanceToken': 'operator-only',
  'cloud.instanceName': 'operator-only',
  'cloud.linkedAccountLabel': 'operator-only',

  // A configured raw-MCP server becomes a tool endpoint sessions can attach —
  // an agent writing one grants itself a capability, which is exactly the line
  // this module holds (same reasoning as `mesh.scanRoots` and the approved
  // lists). A person adds servers through config or the UI.
  'connectors.rawMcpServers[].slug': 'operator-only',
  'connectors.rawMcpServers[].displayName': 'operator-only',
  'connectors.rawMcpServers[].url': 'operator-only',
  'connectors.rawMcpServers[].transport': 'operator-only',

  // Per-provider credential references (ADR-0315).
  providers: 'operator-only',
} as const satisfies Record<string, ConfigWriteAccess>;

/** The `operator-only` dot-paths, derived from the table so the two cannot drift. */
export const OPERATOR_ONLY_CONFIG_PATHS: readonly string[] = Object.entries(CONFIG_WRITE_POLICY)
  .filter(([, access]) => access === 'operator-only')
  .map(([dotPath]) => dotPath);

/** The `error` field every operator-only refusal carries. */
export const OPERATOR_ONLY_CONFIG_ERROR = 'Only a person can change those settings';

/** The machine-readable code every operator-only refusal carries. */
export const OPERATOR_ONLY_CONFIG_CODE = 'operator_only_config';

/**
 * Config paths that may not be written at all while local login is OFF, on top of
 * the `operator-only` verdict above (spec `agent-approval-settings` §3.0-3.1,
 * narrowed by DOR-505).
 *
 * ## What DOR-505 took away from this list, and what it could not
 *
 * This started life as `REQUIRES_COOKIE_CONFIG_PATHS`: `approvals.*` needed a
 * session cookie, while every other `operator-only` path made do with the
 * `trustedCaller` escape on `PATCH /api/config`. DOR-505 gave the cookie
 * requirement to EVERY `operator-only` path under login-on, so the cookie half of
 * this list is now the general rule and has been deleted rather than kept as a
 * second check on the same writes.
 *
 * What survives is the half the general rule does not reach. That rule allows any
 * caller while login is off, because with no accounts there is no cookie to ask
 * for. For an ordinary setting that is the accepted residual. For these paths it
 * would be wrong, but be precise about WHY, because the imprecise version gets
 * this list deleted:
 *
 * **`approvals.standingGrants` decides real behavior.** The tier gate reads it on
 * every gated call, so an agent that could set it while login is off would be
 * arming the thing that makes DorkOS stop asking, not flipping an inert flag. The
 * write also PERSISTS and nothing sweeps it —
 * `revokeStandingGrantsIfPostureNarrowed` only fires on a narrowing, never on a
 * widening — so a switch set in the login-off posture is still set on the day the
 * person turns login on, reading as something they chose.
 *
 * This list was written before enforcement existed, as a forward-looking guard,
 * and the note it replaced said so at length because a reader who tested the
 * "attack" then found it inert. That is no longer the situation: the attack is live
 * and the guard is what stops it.
 *
 * So the two mechanisms no longer overlap: this one asks "is login on", the
 * general rule asks "with login on, is this a person". They compose.
 *
 * It does NOT cover the cookie requirement on creating a standing permission
 * itself. That one is a property of the approvals routes, not of the config write
 * path, and it stands on its own.
 */
export const REQUIRES_LOGIN_CONFIG_PATHS: readonly string[] = [
  'approvals.standingGrants',
  'approvals.trustWindowMinutes',
  // The posture floor decides real behavior for the same reason the master switch
  // does — the store consults it on every lookup — and moving it backwards is the
  // one write that can bring voided permissions back. With login off there is no
  // cookie to ask for, so this bar is the only thing standing in front of it.
  'approvals.standingGrantsVoidBefore',
];

/** The `error` field every login-required refusal on a config write carries. */
export const REQUIRES_LOGIN_CONFIG_ERROR = 'Standing permissions need Require login turned on';

/**
 * Every dot-path a patch object touches, including a path that ends at an empty
 * object.
 *
 * Deliberately not `flattenConfigKeys` (which drops `{ auth: {} }` entirely): a
 * guard should see every branch the caller reached for, not only the ones that
 * carry a value.
 *
 * @param value - The patch node being walked.
 * @param prefix - Internal accumulator for the current path; omit at call sites.
 * @returns Dot-paths for every leaf and every empty branch.
 */
function patchPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) => patchPaths(child, prefix ? `${prefix}.${key}` : key));
}

/**
 * Find which of a guarded set of dot-paths a patch tries to write.
 *
 * Matching runs in both directions along the dot-path, so neither a deeper nor a
 * shallower patch slips past: `{ auth: { enabled: false } }` hits `auth.enabled`
 * exactly, `{ auth: true }` hits it as an ancestor, and
 * `{ providers: { anthropic: '…' } }` hits the `providers` record as a descendant.
 *
 * @param patch - The raw patch a caller supplied.
 * @param guardedPaths - The policy paths to match against.
 * @returns The offending policy paths, sorted, each named once.
 */
function findGuardedPaths(patch: unknown, guardedPaths: readonly string[]): string[] {
  const touched = patchPaths(patch);
  const hits = new Set<string>();

  for (const path of touched) {
    for (const guarded of guardedPaths) {
      if (path === guarded || path.startsWith(`${guarded}.`) || guarded.startsWith(`${path}.`)) {
        hits.add(guarded);
      }
    }
  }

  return [...hits].sort();
}

/**
 * Find the operator-only settings a patch tries to write.
 *
 * @param patch - The raw patch a caller supplied (any shape; a non-object touches
 *   nothing).
 * @returns The offending policy paths, sorted, each named once. Empty when the
 *   patch is clean.
 */
export function findOperatorOnlyPaths(patch: unknown): string[] {
  return findGuardedPaths(patch, OPERATOR_ONLY_CONFIG_PATHS);
}

/**
 * Find the settings a patch tries to write that additionally need local login to
 * be on ({@link REQUIRES_LOGIN_CONFIG_PATHS}).
 *
 * Matches the same way {@link findOperatorOnlyPaths} does, so `{ approvals: {} }`
 * and `{ approvals: true }` are caught as ancestors rather than sliding past a
 * leaf-exact comparison.
 *
 * @param patch - The raw patch a caller supplied (any shape; a non-object touches
 *   nothing).
 * @returns The offending policy paths, sorted, each named once. Empty when the
 *   patch touches none of them.
 */
export function findLoginRequiredPaths(patch: unknown): string[] {
  return findGuardedPaths(patch, REQUIRES_LOGIN_CONFIG_PATHS);
}

/**
 * The refusal an agent reads. Names exactly what it may not change, says why in
 * one plain sentence, and tells it what to do instead, because this text lands in
 * a model's context and a model that is only told "no" will try again.
 *
 * @param paths - The offending policy paths, from {@link findOperatorOnlyPaths}.
 * @returns One paragraph written for the model.
 */
export function describeOperatorOnlyRefusal(paths: readonly string[]): string {
  return (
    `DorkOS changed nothing. These settings decide who can reach this instance, what it can ` +
    `reach, where its credentials go, and what leaves the machine, so they are the person's to ` +
    `choose, not yours: ${paths.join(', ')}. Ask the person to change it themselves in DorkOS ` +
    `Settings. ` +
    `If your patch also had ordinary settings in it, send those again on their own and they will ` +
    `go through.`
  );
}
