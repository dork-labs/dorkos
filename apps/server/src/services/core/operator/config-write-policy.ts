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
 * - **Credentials and where they are sent.** `providers` and
 *   `runtimes.codex.credentialRef` are credential references (ADR-0315);
 *   `runtimes.opencode.baseURL` is the host every prompt and the injected key are
 *   sent to; `cloud.*` is the token and identity of the account link.
 * - **Code the server loads or runs.** `extensions.*` decides which extension code
 *   is compiled into the server process, and the two `binaryPath` fields name
 *   executables the server spawns.
 * - **How far DorkOS reaches on disk.** Every path field DorkOS resolves WITHOUT a
 *   boundary check: `server.boundary` (the containment line itself, read by the
 *   CLI at next launch), `workspace.rootPath`, `relay.dataDir`,
 *   `agents.defaultDirectory`, and `mesh.scanRoots`.
 * - **Consent about what leaves the machine.** All of `telemetry.*`, which is
 *   consent-gated by design.
 *
 * ### Considered and deliberately left writable
 *
 * Refusing more than the line justifies makes the capability useless and invites
 * the next person to loosen it wholesale, so these stay `agent-writable` on
 * purpose:
 *
 * - `server.cwd` — a starting directory, and the one path field that IS validated
 *   against the boundary (the CLI falls back to the boundary root when it sits
 *   outside). It picks a spot on ground the agent already has.
 * - `server.port`, `server.open` — moving or not-opening the cockpit is disruptive,
 *   not an escalation.
 * - `runtimes.opencode.provider` — selects among credentials the operator already
 *   configured. With `baseURL` operator-only, the key can only go to that
 *   provider's own endpoint, so "switch me to OpenRouter" stays a thing an agent
 *   can do.
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
  'ui.sidebar.pinned': 'agent-writable',
  // A sidebar group is an object inside an array, so each of its fields carries
  // its own verdict (the `[]` descent, same convention as `CONFIG_DISCLOSURE`).
  // A property added to a group is unclassified, so the guard fails until someone
  // decides. If one of these ever becomes `operator-only`, `patchPaths` must learn
  // to descend into arrays first — today it stops at `ui.sidebar.groups`, which is
  // harmless only because every verdict below is `agent-writable`.
  'ui.sidebar.groups[].id': 'agent-writable',
  'ui.sidebar.groups[].name': 'agent-writable',
  'ui.sidebar.groups[].agentPaths': 'agent-writable',
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
  'ui.sidebar.groupsHintDismissed': 'agent-writable',
  'ui.sidebar.muted': 'agent-writable',
  'ui.sidebar.ungroupedDisplayFilter': 'agent-writable',
  'ui.shapes.active': 'agent-writable',
  'ui.shapes.agentDefaults': 'agent-writable',
  'ui.shapes.autoFollowAgent': 'agent-writable',
  'ui.statusBar.pins': 'agent-writable',

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

  // Directories DorkOS would scan for agents. Nothing reads this today, and
  // classifying it now is what stops it becoming load-bearing while writable.
  'mesh.scanRoots': 'operator-only',

  'onboarding.completedSteps': 'agent-writable',
  'onboarding.skippedSteps': 'agent-writable',
  'onboarding.startedAt': 'agent-writable',
  'onboarding.dismissedAt': 'agent-writable',
  'onboarding.completedAt': 'agent-writable',

  'tours.seen': 'agent-writable',
  'tours.declined': 'agent-writable',

  'agentContext.relayTools': 'agent-writable',
  'agentContext.meshTools': 'agent-writable',
  'agentContext.adapterTools': 'agent-writable',
  'agentContext.tasksTools': 'agent-writable',

  'uploads.maxFileSize': 'agent-writable',
  'uploads.maxFiles': 'agent-writable',
  'uploads.allowedTypes': 'agent-writable',

  // Where agent manifests are created, resolved without a boundary check.
  'agents.defaultDirectory': 'operator-only',
  'agents.defaultAgent': 'agent-writable',

  // Which extension code is compiled and loaded into the server process. The
  // cockpit toggles these through `/api/extensions`, not through a config patch.
  'extensions.enabled': 'operator-only',
  'extensions.disabled': 'operator-only',

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

  'workbench.defaultViewers': 'agent-writable',
  'workbench.terminalGraceTtlMinutes': 'agent-writable',
  'workbench.autoOpenDiff': 'agent-writable',

  'runtimes.default': 'agent-writable',
  'runtimes.opencode.enabled': 'agent-writable',
  // An executable the server spawns.
  'runtimes.opencode.binaryPath': 'operator-only',
  'runtimes.opencode.port': 'agent-writable',
  // Selects among credentials the operator already configured; with `baseURL`
  // locked down, the key can only reach that provider's own endpoint.
  'runtimes.opencode.provider': 'agent-writable',
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

  // The credential and the identity of the account link.
  'cloud.instanceToken': 'operator-only',
  'cloud.instanceName': 'operator-only',
  'cloud.linkedAccountLabel': 'operator-only',

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
 * Find the operator-only settings a patch tries to write.
 *
 * Matching runs in both directions along the dot-path, so neither a deeper nor a
 * shallower patch slips past: `{ auth: { enabled: false } }` hits `auth.enabled`
 * exactly, `{ auth: true }` hits it as an ancestor, and
 * `{ providers: { anthropic: '…' } }` hits the `providers` record as a descendant.
 *
 * @param patch - The raw patch a caller supplied (any shape; a non-object touches
 *   nothing).
 * @returns The offending policy paths, sorted, each named once. Empty when the
 *   patch is clean.
 */
export function findOperatorOnlyPaths(patch: unknown): string[] {
  const touched = patchPaths(patch);
  const hits = new Set<string>();

  for (const path of touched) {
    for (const guarded of OPERATOR_ONLY_CONFIG_PATHS) {
      if (path === guarded || path.startsWith(`${guarded}.`) || guarded.startsWith(`${path}.`)) {
        hits.add(guarded);
      }
    }
  }

  return [...hits].sort();
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
    `reach, and where its credentials go, so only a person can change them: ${paths.join(', ')}. ` +
    `Ask the person to change it themselves in DorkOS Settings. If your patch also had ordinary ` +
    `settings in it, send those again on their own and they will go through.`
  );
}
