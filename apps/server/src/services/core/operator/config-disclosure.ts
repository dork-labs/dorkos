/**
 * The disclosure allowlist behind the operator `config_get` / `config_patch`
 * snapshot — an explicit, per-field classification of the whole user config.
 *
 * ## Why an allowlist
 *
 * `config_get` carries `readOnlyCarveOut: true`, so on the default login-off
 * posture it answers on the external `/mcp` endpoint with **no credential at
 * all**. The snapshot it returns therefore has to be a deliberate projection.
 * It used to be "the entire `configManager.getAll()` minus four dot-paths"
 * (`SENSITIVE_CONFIG_KEYS`), which fails in one direction only: a new
 * secret-bearing field is exposed the moment it is added and nothing complains.
 * That failure already shipped once (`mcp.apiKey` reached this surface before it
 * joined the denylist).
 *
 * So the model is inverted here. {@link CONFIG_DISCLOSURE} classifies **every
 * leaf** of {@link UserConfigSchema} as `expose` or `withhold`, and
 * {@link projectDisclosedConfig} builds its output by copying only the `expose`
 * paths. A field nobody classified is absent from the snapshot (fail-closed) and
 * the drift guard in `__tests__/config-disclosure.test.ts` fails the build until
 * its author classifies it. Anything the stored file carries that the schema does
 * not describe (for example `conf`'s internal migration bookkeeping) is dropped
 * for free.
 *
 * ## What counts as a leaf
 *
 * "Leaf" is asserted, not assumed. {@link classifySchemaLeaves} walks the
 * generated JSON Schema and descends through array `items` (`[]` in the path) and
 * through `anyOf` / `oneOf` branches, so an object nested inside an array or
 * behind a nullable branch is enumerated field by field rather than swallowed
 * whole. A node it cannot reduce to a scalar, an array of scalars, or an open
 * record of scalars is classified `unsupported`, which the guard rejects for any
 * `expose` verdict: a subtree has to be argued for, not assumed.
 *
 * The projection matches that model at runtime. It rebuilds arrays of objects
 * element by element from the classified paths and copies each leaf through
 * {@link sanitizeLeafValue}, which refuses to carry nested structure. So an
 * unclassified field one level down is absent by construction too, not merely
 * absent because a test was watching.
 *
 * ## What is withheld, and why only that
 *
 * Two classes, and nothing else:
 *
 * 1. **Secrets and the things that locate them.** The four
 *    `SENSITIVE_CONFIG_KEYS` values, plus every credential *reference*:
 *    `providers` and `runtimes.codex.credentialRef` hold `keychain:` / `env:` /
 *    `file:` references (ADR-0315). A reference is not a secret, but a
 *    `file:/Users/me/.dork/secrets/anthropic` tells an unauthenticated caller
 *    exactly which file to read, which is the same escalation as handing over the
 *    key. Each of these gets a boolean `…Configured` sibling instead of its
 *    value, so an agent can still see that a provider is wired up without
 *    learning where the material lives.
 * 2. **Linked-account identity.** `cloud.linkedAccountLabel` names the DorkOS
 *    account this install is linked to (often a person's email). No operator task
 *    needs it, and `cloud.instanceTokenConfigured` already answers "is this
 *    install linked".
 *
 * Absolute paths (`server.cwd`, `server.boundary`, `mesh.scanRoots`,
 * `workspace.rootPath`, `runtimes.*.binaryPath`, `relay.dataDir`,
 * `agents.defaultDirectory`, and the agent `projectPath`s inside the
 * `ui.sidebar` item references)
 * stay exposed **on purpose**. They are how the operator surface addresses work:
 * `update_agent` targets an agent by `cwd`, and an agent that cannot see its
 * boundary cannot tell what it is allowed to touch. Withholding them would also
 * buy no confidentiality, because the only posture where `config_get` answers
 * tokenlessly is login-off, and in that same posture the equally tokenless
 * `GET /api/config` already reports `workingDirectory`, `boundary`, `dorkHome`,
 * and `mesh.scanRoots`. The line this module holds is "nothing that is a
 * credential or points at one", not "no paths".
 *
 * @module services/core/operator/config-disclosure
 */
import { z } from 'zod';
import { UserConfigSchema } from '@dorkos/shared/config-schema';

/**
 * What an untrusted caller may learn about one config leaf.
 *
 * - `expose` — the stored value is returned verbatim.
 * - `withhold` — the value never leaves the server. Leaves listed in
 *   {@link PRESENCE_FLAG_PATHS} are replaced by a boolean `…Configured` sibling;
 *   the rest are simply absent.
 */
export type ConfigDisclosure = 'expose' | 'withhold';

/**
 * Every leaf of {@link UserConfigSchema}, classified. Keys are dot-paths and must
 * match the schema exactly in both directions — the drift guard asserts it, so
 * adding, renaming, or removing a config field fails the build until this table
 * is updated with a deliberate verdict. A `[]` segment marks a descent through
 * array elements, so `ui.sidebar.groups[].name` is "the `name` of each sidebar
 * group".
 *
 * Ordered to mirror the schema so a reviewer can read the two side by side.
 */
export const CONFIG_DISCLOSURE = {
  version: 'expose',

  'server.port': 'expose',
  // Working directory + boundary: the operator surface's own frame of reference.
  'server.cwd': 'expose',
  'server.boundary': 'expose',
  'server.open': 'expose',

  'tunnel.enabled': 'expose',
  // The public hostname this instance answers on; `GET /api/config` already
  // reports the live tunnel URL in the same posture.
  'tunnel.domain': 'expose',
  'tunnel.authtoken': 'withhold',
  'tunnel.auth': 'withhold',

  'ui.theme': 'expose',
  'ui.dismissedUpgradeVersions': 'expose',
  // A sidebar item reference is a discriminated union of objects, so the `[]`
  // descent enumerates each branch's fields: `kind` plus the agent branch's
  // `path` or the room branch's `roomId`. An element only ever carries one of
  // the two payload fields, and the projection drops whichever is absent.
  'ui.sidebar.pinned[].kind': 'expose',
  'ui.sidebar.pinned[].path': 'expose',
  'ui.sidebar.pinned[].roomId': 'expose',
  // A sidebar group is an object inside an array, so each of its fields carries
  // its own verdict. That is the point of the `[]` descent: a credential-shaped
  // property added to a group is unclassified, so the guard fails, and the
  // projection rebuilds each group from these paths alone, so it would be absent
  // even if the guard were not watching.
  'ui.sidebar.groups[].id': 'expose',
  'ui.sidebar.groups[].name': 'expose',
  'ui.sidebar.groups[].items[].kind': 'expose',
  'ui.sidebar.groups[].items[].path': 'expose',
  'ui.sidebar.groups[].items[].roomId': 'expose',
  'ui.sidebar.groups[].sortMode': 'expose',
  'ui.sidebar.groups[].collapsed': 'expose',
  'ui.sidebar.groups[].displayFilter': 'expose',
  'ui.sidebar.groups[].muted': 'expose',
  'ui.sidebar.groups[].kind': 'expose',
  'ui.sidebar.groups[].rules.runtimes': 'expose',
  'ui.sidebar.groups[].rules.namespaces': 'expose',
  'ui.sidebar.groups[].rules.statuses': 'expose',
  'ui.sidebar.groups[].rules.lastActiveWithinMs': 'expose',
  'ui.sidebar.groups[].rules.pathPrefix': 'expose',
  // Which sidebar sections are folded, and how the ones with options are sorted
  // and filtered. Withheld for a shape reason, not a safety one: an open record
  // classifies as `record` only when its VALUES are scalars, and these are
  // objects, so `classifySchemaLeaves` returns `unsupported` and the guard
  // rejects `expose` on anything unsupported. The same enum keying a record of
  // scalars would be exposable today — it is the value shape that stops here,
  // not the key. There is nothing sensitive in it; teaching the walker to
  // descend into a record's values would make exposing it correct, and until
  // then fail-closed is the rule this module holds.
  'ui.sidebar.sections': 'withhold',
  'ui.sidebar.muted[].kind': 'expose',
  'ui.sidebar.muted[].path': 'expose',
  'ui.sidebar.muted[].roomId': 'expose',
  // Which Getting-started suggestions this person has finished with, and the
  // local date the welcome-back digest last appeared. Two plain facts about the
  // person's own cockpit; an agent that reads them can tell whether there is
  // still a first-run card on screen.
  'ui.sidebar.gettingStarted.retired': 'expose',
  'ui.sidebar.digest.lastShownDate': 'expose',
  // Which feature-promo cards this person has waved away. A list of promo ids
  // and nothing else — the same class of fact as the retired Getting-started
  // suggestions above, and an agent that reads it can tell whether the sidebar's
  // bottom card is still on screen.
  'ui.promos.dismissedIds': 'expose',
  'ui.shapes.active': 'expose',
  // An open record (see EXPOSED_RECORD_PATHS): agent projectPath -> Shape name.
  'ui.shapes.agentDefaults': 'expose',
  'ui.shapes.autoFollowAgent': 'expose',
  'ui.statusBar.pins': 'expose',
  'ui.composer.richText': 'expose',
  // A timestamp saying the person read what Full autonomy means. Names nothing
  // and unlocks nothing on being read — an agent that learns the date is no
  // closer to anything than one that does not.
  'ui.autonomyAcknowledgedAt': 'expose',

  'logging.level': 'expose',
  'logging.maxLogSizeKb': 'expose',
  'logging.maxLogFiles': 'expose',

  'relay.enabled': 'expose',
  'relay.dataDir': 'expose',

  // Whether outside agents may reach the ones here over A2A. A plain boolean:
  // it names no credential and no host, and an agent that learns the gate is
  // shut is no closer to opening it — the write side is where that is decided.
  'a2a.enabled': 'expose',

  'scheduler.enabled': 'expose',
  'scheduler.maxConcurrentRuns': 'expose',
  'scheduler.timezone': 'expose',
  'scheduler.retentionCount': 'expose',

  'mesh.scanRoots': 'expose',

  'rooms.maxAgentDepth': 'expose',
  'rooms.maxAutomaticTurnsPerRoomPerHour': 'expose',
  'rooms.maxAutomaticTurnsTotalPerHour': 'expose',
  'rooms.replyWaitMinutes': 'expose',
  'rooms.lateReplyCeilingMinutes': 'expose',
  'rooms.engagedWindowMinutes': 'expose',
  'rooms.engagedWindowPosts': 'expose',
  'rooms.collectDebounceMs': 'expose',
  'rooms.collectMaxEntries': 'expose',

  // What agents may say when the person comes back after being away. Three
  // plain numbers about the person's own rooms: nothing here is a credential or
  // names where one lives, and an agent that can read them is an agent that can
  // tell whether it is allowed to greet at all.
  'welcomeBack.enabled': 'expose',
  'welcomeBack.absenceThresholdMinutes': 'expose',
  'welcomeBack.maxPosts': 'expose',
  'welcomeBack.offersEnabled': 'expose',

  'onboarding.completedSteps': 'expose',
  'onboarding.skippedSteps': 'expose',
  'onboarding.startedAt': 'expose',
  'onboarding.dismissedAt': 'expose',
  'onboarding.completedAt': 'expose',
  'onboarding.runtimeDefaultSetAt': 'expose',

  'tours.seen': 'expose',
  'tours.declined': 'expose',

  // The user profile (spec user-profile-onboarding). Exposing it to agents IS
  // the feature: agents know who they work for, and nothing here is a
  // credential or names where one lives. Local-only — structurally excluded
  // from every telemetry payload; disclosure to the user's OWN agents is a
  // different question from disclosure off the machine.
  'profile.roles': 'expose',
  'profile.tools': 'expose',
  'profile.displayName': 'expose',
  'profile.rolePromptDismissedAt': 'expose',

  'agentContext.relayTools': 'expose',
  'agentContext.meshTools': 'expose',
  'agentContext.adapterTools': 'expose',
  'agentContext.tasksTools': 'expose',

  'uploads.maxFileSize': 'expose',
  'uploads.maxFiles': 'expose',
  'uploads.allowedTypes': 'expose',

  'agents.defaultDirectory': 'expose',
  'agents.defaultAgent': 'expose',

  'extensions.enabled': 'expose',
  'extensions.disabled': 'expose',
  // Which extensions a person approved to run code in the server (DOR-516).
  // Exposed on purpose even though it is `operator-only` to WRITE: an agent that
  // can read the list can tell the person exactly which id to approve, instead of
  // retrying a load that will keep being refused. It names extension ids the
  // caller can already see in `list_extensions`, so it discloses nothing new.
  'extensions.approvedToRun': 'expose',

  'mcp.enabled': 'expose',
  'mcp.apiKey': 'withhold',
  'mcp.rateLimit.enabled': 'expose',
  'mcp.rateLimit.maxPerWindow': 'expose',
  'mcp.rateLimit.windowSecs': 'expose',

  'telemetry.userHasDecided': 'expose',
  'telemetry.install': 'expose',
  'telemetry.heartbeat': 'expose',
  'telemetry.errorReporting': 'expose',
  'telemetry.lastPromptedVersion': 'expose',
  'telemetry.usage': 'expose',
  'telemetry.linkAnalyticsToAccount': 'expose',
  'telemetry.aiMetadata': 'expose',

  'workspace.enabled': 'expose',
  'workspace.rootPath': 'expose',
  'workspace.portBase': 'expose',
  'workspace.portBlockSize': 'expose',
  'workspace.defaultProvider': 'expose',
  'workspace.retentionCap': 'expose',

  'harness.autoSync': 'expose',
  // Which packages a person let write shell commands into a coding agent's hook
  // files. Names packages and digests, no secrets, and an agent that can read it
  // can already read the hook files themselves.
  'harness.approvedHooks': 'expose',

  // An open record (see EXPOSED_RECORD_PATHS): file extension -> viewer id.
  'workbench.defaultViewers': 'expose',
  'workbench.terminalGraceTtlMinutes': 'expose',
  'workbench.autoOpenDiff': 'expose',

  'runtimes.default': 'expose',
  // How much a new session may do without asking, globally and per runtime (spec
  // `trust-dial`, decision 6). Exposed although it is operator-only to WRITE, and
  // the asymmetry is the point of having two tables: reading it lets an agent
  // explain why the session it is in started where it did, and say out loud that
  // new sessions here run without asking. Knowing the posture is not holding it.
  'runtimes.defaultTrustStop': 'expose',
  'runtimes.claudeCode.defaultTrustStop': 'expose',
  'runtimes.codex.defaultTrustStop': 'expose',
  'runtimes.opencode.defaultTrustStop': 'expose',
  // Which Claude account new work runs on, and the accounts registered here
  // (spec claude-code-accounts). Directories and a human label — the same class
  // as `runtimes.*.binaryPath`, exposed on purpose: an absolute path is how this
  // surface addresses directories, and naming one is not naming a secret. The
  // account's sign-in lives inside the directory and never passes through config,
  // so there is nothing here to withhold. An agent knowing which account it is
  // running on is the point.
  'runtimes.claudeCode.activeAccount': 'expose',
  'runtimes.claudeCode.accounts[].path': 'expose',
  'runtimes.claudeCode.accounts[].label': 'expose',
  // The execution defaults a new session on each runtime starts with. A model id
  // and an effort rung are the same class of thing as `runtimes.default`: they
  // describe HOW work runs here, name no credential and no person, and an agent
  // that can see them can explain why its session started on the model it did
  // instead of guessing. OpenCode has a model leaf and no effort leaf — its API
  // takes none, and the absent row is the honest way to say so.
  'runtimes.claudeCode.defaultModel': 'expose',
  'runtimes.claudeCode.defaultEffort': 'expose',
  // Whether a Claude Code chat keeps its agent running between messages
  // (spec `persistent-session-runtime` §P3). Same class again: it describes how
  // work runs on this machine, names no credential and no person, and an agent
  // that can see it can say why a session behaves the way it does.
  'runtimes.claudeCode.persistentSession': 'expose',
  'runtimes.opencode.defaultModel': 'expose',
  'runtimes.codex.defaultModel': 'expose',
  'runtimes.codex.defaultEffort': 'expose',
  'runtimes.opencode.enabled': 'expose',
  'runtimes.opencode.binaryPath': 'expose',
  'runtimes.opencode.port': 'expose',
  'runtimes.opencode.provider': 'expose',
  'runtimes.opencode.baseURL': 'expose',
  'runtimes.codex.enabled': 'expose',
  'runtimes.codex.binaryPath': 'expose',
  // A credential reference: `file:` names a plaintext key file, `env:` names the
  // variable, `keychain:` names the entry. Replaced by a presence flag.
  'runtimes.codex.credentialRef': 'withhold',

  'auth.enabled': 'expose',

  // A posture, not a roster. These two say whether standing permissions may
  // exist here and for how long one lasts; WHICH agents are trusted lives in
  // SQLite and never passes through config at all, so there is nothing here for
  // an agent to learn about anyone's trust but its own instance's settings.
  'approvals.standingGrants': 'expose',
  'approvals.trustWindowMinutes': 'expose',
  // Same reasoning one step further: a timestamp saying when this install last
  // switched standing permissions off names no agent and no person. Exposing it
  // also lets an agent understand why a permission it used to have stopped
  // working, which is better than silently finding out.
  'approvals.standingGrantsVoidBefore': 'expose',

  'cloud.instanceToken': 'withhold',
  'cloud.instanceName': 'expose',
  // Names the DorkOS account this install is linked to, often an email address.
  'cloud.linkedAccountLabel': 'withhold',

  // Configured raw-MCP servers (connector-completion spec): endpoint metadata,
  // not credentials — the remote server manages its own sign-in ('external'
  // custody), so nothing here names where a secret lives.
  'connectors.rawMcpServers[].slug': 'expose',
  'connectors.rawMcpServers[].displayName': 'expose',
  'connectors.rawMcpServers[].url': 'expose',
  'connectors.rawMcpServers[].transport': 'expose',

  // The per-provider credential-reference map. Replaced by `providersConfigured`,
  // the list of provider ids that have a reference.
  providers: 'withhold',
} as const satisfies Record<string, ConfigDisclosure>;

/**
 * Withheld leaves that are replaced by a boolean `<leafName>Configured` sibling,
 * so a caller can still tell whether the credential is set up without learning
 * anything about it. Every entry must be classified `withhold` above (asserted by
 * the drift guard).
 */
export const PRESENCE_FLAG_PATHS: readonly string[] = [
  'tunnel.authtoken',
  'tunnel.auth',
  'mcp.apiKey',
  'cloud.instanceToken',
  'runtimes.codex.credentialRef',
];

/**
 * The open records (`z.record(...)`) that may be disclosed whole.
 *
 * Every other `expose` verdict has to resolve to a scalar or an array of
 * scalars, because those are the only shapes whose contents the schema fully
 * names. A record's keys are user-supplied and its values are only as safe as
 * its value type, so exposing one is a standing promise that nothing sensitive
 * can ever be stored under it. That promise is written down here rather than
 * inferred: an author who widens a record's value type, or exposes a new one,
 * has to add it to this list and defend it. The drift guard checks the list in
 * both directions.
 *
 * **The guard checks value types and never keys.** A record's keys are whatever
 * a person or an agent wrote, so listing one here also promises its *key* space
 * is not sensitive, and no test can check that for you. Today: agent projectPath
 * to Shape name, and file extension to viewer id. Both value types are closed and
 * non-secret; the agent paths already leave through three exposed scalar arrays
 * and the equally tokenless `GET /api/config`, and a file extension discloses
 * nothing. A record keyed by something a caller should not learn does not belong
 * on this list even if its values are harmless.
 */
export const EXPOSED_RECORD_PATHS: readonly string[] = [
  'ui.shapes.agentDefaults',
  'workbench.defaultViewers',
];

/** Read the value at a dot-path, or `undefined` if any segment is missing. */
function readAtPath(root: Record<string, unknown>, parts: readonly string[]): unknown {
  let node: unknown = root;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Write a value at a dot-path, creating plain-object parents as needed. */
function writeAtPath(
  root: Record<string, unknown>,
  parts: readonly string[],
  value: unknown
): void {
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]!] = value;
}

/** A stored value with no nested structure: the only thing a leaf may carry out. */
type DisclosedScalar = string | number | boolean | null;

/** Whether a stored value is a scalar, and so carries nothing underneath it. */
function isScalarValue(value: unknown): value is DisclosedScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Copy one exposed leaf value, refusing to carry nested structure out with it.
 *
 * The schema guard already proves every `expose` path is scalar-shaped, so this
 * is the runtime half of the same promise, in code rather than in a test.
 * Scalars pass through, and so do arrays whose every element is a scalar. An
 * object is only ever accepted at an {@link EXPOSED_RECORD_PATHS} path, and even
 * there only its scalar-valued entries survive.
 *
 * It is **defense in depth, not a live code path**. `ConfigManager` builds `conf`
 * with `clearInvalidConfig: false`, and `conf` re-validates the whole store on
 * every read, so `getAll()` throws rather than handing a schema-violating value
 * to this function. What does reach here unvalidated is an unknown **top-level**
 * key, which `conf`'s root wrapper permits and the projection plan drops anyway.
 * The value of this function is that the guarantee survives a future change that
 * relaxes `conf`'s validation.
 *
 * @param value - The raw stored value at an exposed path.
 * @param isRecord - Whether this path is an allowlisted open record.
 * @returns A fresh scalar-shaped copy, or `undefined` to drop the path entirely.
 */
function sanitizeLeafValue(value: unknown, isRecord: boolean): unknown {
  if (value === undefined) return undefined;
  if (isRecord) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // Assigning `__proto__` onto an object literal hits the prototype setter
      // and no-ops, so the key is already dropped. Skip it explicitly so the
      // intent survives a refactor to `Object.fromEntries` or similar.
      if (key === '__proto__') continue;
      if (isScalarValue(entry)) out[key] = entry;
    }
    return out;
  }
  if (isScalarValue(value)) return value;
  if (Array.isArray(value)) return value.every(isScalarValue) ? [...value] : undefined;
  return undefined;
}

/**
 * One node of the projection plan: the {@link CONFIG_DISCLOSURE} `expose` paths
 * compiled into a tree, so the projection can walk the stored config once and
 * rebuild nested shapes (objects, and objects inside arrays) from classified
 * paths alone.
 */
interface ProjectionNode {
  /** This path is an exposed leaf: copy its sanitized value and stop. */
  terminal: boolean;
  /** This leaf is an allowlisted open record, so an object is a legal value here. */
  record: boolean;
  /** Descend through array elements, projecting each one against this node. */
  items?: ProjectionNode;
  /** Object keys to descend into, in classification order. */
  children: Map<string, ProjectionNode>;
}

/** A fresh, empty plan node. */
function newProjectionNode(): ProjectionNode {
  return { terminal: false, record: false, children: new Map() };
}

/**
 * Compile the `expose` verdicts into a {@link ProjectionNode} tree. A path
 * segment ending in `[]` (repeatable, for arrays of arrays) becomes an `items`
 * hop, everything else a `children` hop.
 */
function buildProjectionPlan(): ProjectionNode {
  const root = newProjectionNode();
  for (const [dotPath, verdict] of Object.entries(CONFIG_DISCLOSURE)) {
    if (verdict !== 'expose') continue;
    let node = root;
    for (const segment of dotPath.split('.')) {
      const [, key = '', brackets = ''] = /^(.*?)((?:\[\])*)$/.exec(segment) ?? [];
      let child = node.children.get(key);
      if (!child) {
        child = newProjectionNode();
        node.children.set(key, child);
      }
      node = child;
      for (let depth = 0; depth < brackets.length / 2; depth += 1) {
        node.items ??= newProjectionNode();
        node = node.items;
      }
    }
    node.terminal = true;
    node.record = EXPOSED_RECORD_PATHS.includes(dotPath);
  }
  return root;
}

/**
 * The compiled `expose` plan. {@link CONFIG_DISCLOSURE} is a module constant, so
 * this is built once at load rather than per request.
 */
const PROJECTION_PLAN: ProjectionNode = buildProjectionPlan();

/**
 * Rebuild `value` from a plan node, emitting only what the plan names.
 *
 * @returns The projected value, or `undefined` when nothing at or below this node
 *   was present (which keeps absent sections absent instead of materializing
 *   empty objects a caller would misread as "explicitly unset").
 */
function applyProjection(node: ProjectionNode, value: unknown): unknown {
  if (node.terminal) return sanitizeLeafValue(value, node.record);
  const items = node.items;
  if (items) {
    if (!Array.isArray(value)) return undefined;
    return value
      .map((element) => applyProjection(items, element))
      .filter((element) => element !== undefined);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  let emitted = false;
  for (const [key, child] of node.children) {
    const projected = applyProjection(child, (value as Record<string, unknown>)[key]);
    if (projected === undefined) continue;
    out[key] = projected;
    emitted = true;
  }
  return emitted ? out : undefined;
}

/**
 * Project a raw user-config object down to what an untrusted caller may read.
 *
 * Emits exactly the {@link CONFIG_DISCLOSURE} `expose` paths that are present in
 * the input (a missing path stays missing rather than materializing a `null`),
 * rebuilding nested objects and array elements field by field so nothing rides
 * along inside an exposed subtree. Then it adds the derived presence fields: a
 * boolean `…Configured` sibling for each {@link PRESENCE_FLAG_PATHS} entry, and
 * `providersConfigured` listing the provider ids that have a credential
 * reference.
 *
 * @param raw - The stored config object, straight from `ConfigManager.getAll()`.
 * @returns A fresh object safe to serialize to an unauthenticated caller and to
 *   land in a model's context or a session transcript.
 */
export function projectDisclosedConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out = (applyProjection(PROJECTION_PLAN, raw) as Record<string, unknown> | undefined) ?? {};

  for (const dotPath of PRESENCE_FLAG_PATHS) {
    const parts = dotPath.split('.');
    const leaf = parts[parts.length - 1]!;
    const flagParts = [...parts.slice(0, -1), `${leaf}Configured`];
    const value = readAtPath(raw, parts);
    writeAtPath(out, flagParts, typeof value === 'string' && value.trim().length > 0);
  }

  const providers = raw.providers;
  out.providersConfigured =
    providers !== null && typeof providers === 'object' && !Array.isArray(providers)
      ? Object.keys(providers as Record<string, unknown>).sort()
      : [];

  return out;
}

/**
 * What a JSON-Schema node reduces to once the walk stops guessing.
 *
 * - `scalar` — a primitive, or a union of primitives (`z.string().nullable()`).
 * - `scalar-array` — an array whose element schema is a primitive.
 * - `record` — an open map (`z.record`) whose value schema is a primitive. Safe
 *   to disclose whole only when listed in {@link EXPOSED_RECORD_PATHS}.
 * - `unsupported` — the walk could not prove any of the above: a record of
 *   objects, an untyped node, a `$ref`, an `allOf`, a tuple, or a union whose
 *   branches disagree. Never disclosable without teaching the walker first.
 */
export type SchemaLeafShape = 'scalar' | 'scalar-array' | 'record' | 'unsupported';

/** One classified leaf of a JSON Schema: where it lives, and what it is. */
export interface SchemaLeaf {
  /** Dot-path from the schema root; `[]` marks a descent into array elements. */
  path: string;
  /** What the node reduces to. */
  shape: SchemaLeafShape;
}

/** JSON-Schema primitive type names, the ones that end a walk. */
const SCALAR_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** A JSON-Schema node, read structurally rather than through a typed model. */
type JsonSchemaNode = Record<string, unknown>;

/** Narrow an unknown to a plain JSON-Schema object node. */
function asSchemaNode(node: unknown): JsonSchemaNode | undefined {
  return node !== null && typeof node === 'object' && !Array.isArray(node)
    ? (node as JsonSchemaNode)
    : undefined;
}

/** The `anyOf` / `oneOf` branches of a node, if it is a union. */
function unionBranches(node: JsonSchemaNode): JsonSchemaNode[] | undefined {
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches)) return undefined;
  return branches.map((branch) => asSchemaNode(branch) ?? {});
}

/** Whether a node is a primitive, or a union of primitives. */
function isScalarSchema(node: unknown): boolean {
  const schema = asSchemaNode(node);
  if (!schema) return false;
  if ('$ref' in schema || 'allOf' in schema || 'properties' in schema || 'items' in schema) {
    return false;
  }
  const branches = unionBranches(schema);
  if (branches) return branches.every(isScalarSchema);
  const type = schema.type;
  if (typeof type === 'string') return SCALAR_JSON_TYPES.has(type);
  if (Array.isArray(type)) {
    return type.every((entry) => typeof entry === 'string' && SCALAR_JSON_TYPES.has(entry));
  }
  return false;
}

/** Whether a union branch is the `null` half of a nullable. */
function isNullSchema(node: JsonSchemaNode): boolean {
  return node.type === 'null';
}

/**
 * Merge leaves from several union branches: same path twice is fine while the
 * shapes agree, and becomes `unsupported` when they do not, because a caller
 * cannot be told which one it will get.
 */
function mergeLeaves(leaves: SchemaLeaf[]): SchemaLeaf[] {
  const byPath = new Map<string, SchemaLeafShape>();
  for (const { path, shape } of leaves) {
    const seen = byPath.get(path);
    byPath.set(path, seen === undefined || seen === shape ? shape : 'unsupported');
  }
  return [...byPath].map(([path, shape]) => ({ path, shape }));
}

/**
 * Classify every leaf of a JSON Schema, asserting leaf-ness instead of inferring
 * it from a missing `properties` map.
 *
 * The walk descends into objects, into array `items` (appending `[]` to the
 * path), and into every non-null `anyOf` / `oneOf` branch, so a field nested
 * inside an array element or behind a nullable object branch is enumerated in its
 * own right. Anything it cannot reduce to a scalar, an array of scalars, or a
 * record of scalars is reported `unsupported` rather than waved through, which is
 * what stops a subtree from being disclosed on an ancestor's verdict.
 *
 * Exported separately from {@link configSchemaLeaves} so the guard can exercise
 * shapes the live config schema does not currently contain.
 *
 * @param root - A generated JSON Schema node (the walk never follows `$ref`).
 * @param path - Dot-path of `root`; defaults to the schema root.
 * @returns The classified leaves, in schema order.
 */
export function classifySchemaLeaves(root: unknown, path = ''): SchemaLeaf[] {
  const node = asSchemaNode(root);
  if (!node) return [{ path, shape: 'unsupported' }];

  // Indirection the walk deliberately does not follow: resolving it would mean
  // reimplementing a JSON-Schema resolver to decide a security question.
  if ('$ref' in node || 'allOf' in node) return [{ path, shape: 'unsupported' }];

  const branches = unionBranches(node);
  if (branches) {
    const meaningful = branches.filter((branch) => !isNullSchema(branch));
    if (meaningful.length === 0) return [{ path, shape: 'scalar' }];
    const perBranch = meaningful.map((branch) => classifySchemaLeaves(branch, path));
    // Every branch ends at this path (the nullable-scalar case, and unions of
    // primitives): one leaf, agreeing shape or `unsupported`.
    if (perBranch.every((leaves) => leaves.length === 1 && leaves[0]!.path === path)) {
      return mergeLeaves(perBranch.flat());
    }
    // Some branches end here and others open a subtree, so no single verdict can
    // describe what a caller receives. Refuse rather than classify half of it.
    if (perBranch.some((leaves) => leaves.some((leaf) => leaf.path === path))) {
      return [{ path, shape: 'unsupported' }];
    }
    return mergeLeaves(perBranch.flat());
  }

  const properties = asSchemaNode(node.properties);
  const additional = node.additionalProperties;
  const isOpen = additional !== undefined && additional !== false;

  if (properties) {
    // A named shape plus an open catchall: the catchall's contents have no path
    // to classify, so refuse rather than disclose the half we can see.
    if (isOpen) return [{ path, shape: 'unsupported' }];
    return Object.entries(properties).flatMap(([key, child]) =>
      classifySchemaLeaves(child, path ? `${path}.${key}` : key)
    );
  }

  if (isOpen) return [{ path, shape: isScalarSchema(additional) ? 'record' : 'unsupported' }];

  if (node.type === 'array' || 'items' in node || 'prefixItems' in node) {
    // Tuples carry a positional shape this path language cannot express.
    if ('prefixItems' in node || node.items === undefined) {
      return [{ path, shape: 'unsupported' }];
    }
    if (isScalarSchema(node.items)) return [{ path, shape: 'scalar-array' }];
    return classifySchemaLeaves(node.items, `${path}[]`);
  }

  // A closed object with no properties can hold nothing, so it contributes no
  // leaf at all rather than an unclassifiable one.
  if (node.type === 'object') return [];

  if (isScalarSchema(node)) return [{ path, shape: 'scalar' }];

  return [{ path, shape: 'unsupported' }];
}

/**
 * Every leaf of {@link UserConfigSchema}, classified, derived from the schema
 * itself rather than hand-listed.
 *
 * Reads the generated JSON Schema (the same `z.toJSONSchema` bridge
 * `ConfigManager` uses for its `conf` validation). Only the drift guard calls
 * this, so the cost is never paid at request time.
 *
 * @returns Classified leaves in schema order.
 */
export function configSchemaLeaves(): SchemaLeaf[] {
  return classifySchemaLeaves(z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' }));
}

/**
 * Every leaf dot-path of {@link UserConfigSchema}, in schema order.
 *
 * @returns The {@link configSchemaLeaves} paths, without their shapes.
 */
export function configSchemaLeafPaths(): string[] {
  return configSchemaLeaves().map((leaf) => leaf.path);
}
