/**
 * The write allowlist behind the agent-reachable manifest seam: an explicit,
 * per-field classification of which of its OWN settings an agent may change and
 * which only a person may.
 *
 * ## Why this exists
 *
 * {@link updateAgentManifest} is the agent-reachable write path — `PATCH
 * /api/agents/current` and the `operator.update_agent` MCP tool (tier `act`, so
 * nothing asks a person) both land there. What it accepted used to be "whatever
 * `UpdateAgentRequestSchema` picks", minus three hand-written guards bolted on as
 * each field earned one: `account`, `enabledToolGroups.roomsManage`, and the
 * direction check on `tierCeiling`.
 *
 * Three guards is not a policy, and the shape of the defect they leave is
 * mechanical: a field added to that schema's `.pick(...)` list becomes
 * agent-writable the moment it exists, silently, with no decision anywhere. That
 * is exactly how the four `enabledToolGroups` documentation keys ended up
 * agent-writable while the four GLOBAL switches they override
 * (`agentContext.*` in `config-write-policy.ts`) were operator-only: a person
 * could turn an agent's tool-context blocks off in Settings and the agent could
 * turn its own back on, because per-agent values beat the global ones
 * (`resolveToolConfig`, `claude-code/tooling/tool-filter.ts`). DOR-1497 closed
 * that at the config seam and said in its own module doc that the per-agent seam
 * stayed open. This table is that seam (DOR-1506).
 *
 * ## The line
 *
 * The same line `config-write-policy.ts` draws, applied to an agent's own
 * manifest: a field is `operator-only` when changing it, on its own, undoes a
 * narrowing a person made, widens what the agent can reach, or moves what its
 * work costs onto somebody else's bill. Everything else is a preference an agent
 * may set for itself, and refusing more than the line justifies would make
 * self-edit useless — an agent that cannot write its own display name, notes or
 * personality is not being governed, it is being broken.
 *
 * ## Refuse the whole patch, never strip the field
 *
 * Same rule as the three guards this replaces: a caller told nothing would report
 * the change as done (the DOR-1253 shape). Naming an operator-only field at all —
 * `true`, `false`, `null`, any object above it — refuses the whole patch,
 * because a patch that names the field is a patch about the field.
 *
 * "Any object above it" is the part that took a bypass to find: an object holding
 * only keys this table does not classify names no guarded leaf, and it used to
 * overwrite every leaf under it anyway. See {@link touchedAgentPaths}, which is
 * where that is enforced, and which explains why the refusal stays now that
 * {@link updateAgentManifest} merges these objects instead of replacing them
 * (DOR-1719).
 *
 * ## Where the check runs, and what that costs
 *
 * FIRST, before the schema parse and before the manifest is read, unlike the
 * value-shaped `tighten-only` check below it. The answer is about WHO may write
 * a field, and it must not be contingent on the rest of the patch being
 * well-formed (`{"roomsManage": null}` fails a boolean schema, and reporting that
 * as a validation error tells a model to fix its types and try the same door
 * again) or on which agent is at the path.
 *
 * ## What this does NOT close
 *
 * Say it plainly, because the flattering version invites somebody to rely on a
 * guarantee that is not on offer.
 *
 * - **The operator's own route is untouched.** `PATCH /api/mesh/agents/:id`
 *   (`routes/mesh.ts`) writes every field here and does not come through this
 *   module. A cockpit surface that edits an operator-only field must use it —
 *   the Tools tab's tool-group switches and its rooms-management grant both do.
 * - **A shell-capable agent bypasses any route guard.** With local login off the
 *   server cannot tell the person in the cockpit from a process running as the
 *   same user, and an agent with Bash can edit `.dork/agent.json` directly. This
 *   table closes the SANCTIONED surfaces — the HTTP self-edit route and the MCP
 *   tool — so a refusal is a refusal wherever DorkOS is the one writing. The
 *   remedy for the rest is turning login on
 *   (`contributing/agent-operator-surface.md`).
 *
 * @module services/core/operator/agent-write-policy
 */
import {
  matchGuardedPaths,
  patchPaths,
  prepareGuardedPaths,
  withoutArrayMarkers,
} from './guarded-paths.js';

/**
 * Whether an agent may write one leaf of its own manifest through the
 * agent-reachable seam.
 *
 * - `agent-writable` — a preference. An agent may change it on the user's word.
 * - `operator-only` — changing it undoes a person's narrowing, widens what the
 *   agent reaches, or repoints what its work costs, so the agent surface refuses
 *   it and the person changes it on their own route.
 * - `tighten-only` — the direction is what matters, not the field: the agent may
 *   move it toward LESS capability and never toward more. The comparison needs
 *   the value already on disk, so {@link updateAgentManifest} enforces these
 *   after the manifest read rather than here.
 */
export type AgentWriteAccess = 'agent-writable' | 'operator-only' | 'tighten-only';

/**
 * Every leaf an agent can reach on its own manifest, classified.
 *
 * The keys are the leaves of `UpdateAgentRequestSchema` (the manifest half) and
 * of `UpdateAgentConventionsSchema` (the three convention FILES, which travel in
 * the same PATCH body and are written to disk beside `agent.json`). They must
 * match those schemas exactly in both directions: the drift guard in
 * `__tests__/agent-write-policy.test.ts` asserts it, so widening either schema
 * fails the build until this table carries a deliberate verdict for the new
 * field.
 *
 * Ordered to mirror the schemas, so a reviewer can read the wire and the verdicts
 * side by side.
 */
export const AGENT_WRITE_POLICY = {
  // The slug: how every other agent addresses this one, how its transcripts are
  // filed, and what a `@mention` resolves against. Renaming is a real thing to
  // want and a person does it on the operator route; an agent renaming ITSELF
  // changes who the mesh thinks it is. `displayName` is the agent-writable half
  // of the same question and the refusal points at it.
  name: 'operator-only',
  displayName: 'agent-writable',
  description: 'agent-writable',
  // Which program runs this agent's turns. Considered for operator-only and
  // deliberately left writable: it grants no capability, removes no approval,
  // and it is the one field on this seam the person's own Runs-on popover
  // writes here (`RunsOnPopover.tsx` → `PATCH /api/agents/current`), so refusing
  // it would break the operator's control to bar a change that is visible on
  // the roster the moment it happens. The money question next to it —
  // whose subscription pays — is `account`, and that one is refused.
  runtime: 'agent-writable',
  // Free-text labels the roster filters on. Documentation, not a grant: nothing
  // reads this list to decide what the agent may do.
  capabilities: 'agent-writable',
  // Whether this agent speaks in a room without being asked, and how ready it is
  // to escalate. The same stake `rooms.responseGate` and the `welcomeBack.*`
  // switches carry at the config seam: they decide whether a turn RUNS, so an
  // agent that could set its own to `always` would be voting itself the floor in
  // every room it is in, on the operator's model budget. No cockpit surface
  // writes it through this seam.
  'behavior.responseMode': 'operator-only',
  'behavior.escalationThreshold': 'operator-only',
  // Which other agents this one can reach. Cross-namespace traffic is allowed by
  // rules a person writes (`PUT /api/mesh/topology/access`), and an agent that
  // could move itself into another namespace would be choosing its own side of
  // those rules — granting itself reach rather than asking for it.
  namespace: 'operator-only',
  // Legacy persona prose and its injection switch, on the same footing as
  // SOUL.md below: an agent editing how it introduces itself is self-edit
  // working as intended.
  persona: 'agent-writable',
  personaEnabled: 'agent-writable',

  // Personality. Six dials that change tone and nothing else.
  'traits.verbosity': 'agent-writable',
  'traits.autonomy': 'agent-writable',
  'traits.chaos': 'agent-writable',
  'traits.creativity': 'agent-writable',
  'traits.humor': 'agent-writable',
  'traits.spice': 'agent-writable',

  // The convention-file injection switches. Three of them mute documentation the
  // agent wrote or was given, which is a preference.
  'conventions.soul': 'agent-writable',
  // The exception, and it is NOT agent-writable because it is harmless — it is
  // the mute on the agent's own safety boundaries, and it is gated one layer up
  // instead of here. `operator.update_agent` refuses it outright and points at
  // `operator.update_agent_boundaries`, a `destructive` capability that puts an
  // approval card in front of a person (DOR-1698); the cockpit's own Boundaries
  // page writes it through this route, which is the person editing. So the bar
  // on this field is APPROVAL, not caller identity, and moving it to
  // `operator-only` here would refuse the person's editor to re-refuse a tool
  // that already says no.
  'conventions.nope': 'agent-writable',
  'conventions.memory': 'agent-writable',
  'conventions.dorkosKnowledge': 'agent-writable',

  color: 'agent-writable',
  icon: 'agent-writable',
  // Which model and how hard it thinks. A preference inside a lane the person
  // already chose: the account that pays is `account`, the ceiling on what the
  // agent may DO is `tierCeiling`, and neither moves because a model did. An
  // agent that has been told to stop using the expensive model needs to be able
  // to write the cheap one.
  model: 'agent-writable',
  effort: 'agent-writable',
  // Whose subscription this agent's work bills to (spec `billing-account-ladder`
  // invariant 4). The credential axis `config-write-policy.ts` already holds
  // `runtimes.claudeCode.defaultAccount` on.
  account: 'operator-only',

  // The five per-agent tool groups, all operator-only — the DOR-1506 closure.
  //
  // The four documentation keys were writable here while their global twins
  // (`agentContext.*`) were refused at the config seam, and per-agent values
  // BEAT the global ones, so the config-seam refusal was undone by a curl at
  // this one. That is the whole defect: a person turns an agent's tool context
  // off in Settings → Tools, and the agent turns its own back on, on the surface
  // the person would least look at.
  //
  // State what they actually do, because the flattering version is wrong and a
  // refusal built on it would teach a model something false (DOR-1044).
  // `resolveToolConfig` feeds the CONTEXT BLOCKS: off means the agent is not told
  // about the group, not that the tools are unregistered or blocked. So these
  // four protect a person's deliberate narrowing rather than a capability gate,
  // and the refusal is worded to match.
  'enabledToolGroups.tasks': 'operator-only',
  'enabledToolGroups.relay': 'operator-only',
  'enabledToolGroups.mesh': 'operator-only',
  'enabledToolGroups.adapter': 'operator-only',
  // The fifth is a real grant rather than a documentation key: the capability
  // gate enforces it, so an agent that could write it could turn its own hard
  // filter off and the filter would be theatre (spec `rooms-management-tools`
  // §D6, DOR-1611).
  'enabledToolGroups.roomsManage': 'operator-only',

  // The most this agent is ever allowed to do. The one field whose verdict is a
  // DIRECTION: lowering it is an agent giving something up — the honest way to
  // say "I only ever read" — and raising it (or clearing it, since absent means
  // `destructive`) hands privilege back, which is a person's decision (DOR-486).
  tierCeiling: 'tighten-only',

  // The three convention FILES, which ride the same PATCH body. SOUL.md and
  // MEMORY.md are the agent's own prose about itself and its own saved notes.
  soulContent: 'agent-writable',
  // NOPE.md, on the same footing as `conventions.nope` above and for the same
  // reason: gated by an approval card at `operator.update_agent_boundaries`,
  // not by caller identity here.
  nopeContent: 'agent-writable',
  memoryContent: 'agent-writable',
} as const satisfies Record<string, AgentWriteAccess>;

/** Paths from {@link AGENT_WRITE_POLICY} carrying one verdict. */
function pathsWithAccess(access: AgentWriteAccess): readonly string[] {
  return Object.entries(AGENT_WRITE_POLICY)
    .filter(([, verdict]) => verdict === access)
    .map(([path]) => path);
}

/**
 * The manifest leaves the agent-reachable seam refuses outright, derived from
 * {@link AGENT_WRITE_POLICY} rather than listed twice.
 */
export const OPERATOR_ONLY_AGENT_PATHS: readonly string[] = pathsWithAccess('operator-only');

/**
 * The manifest leaves an agent may move only toward LESS capability.
 *
 * Derived so {@link updateAgentManifest} cannot enforce a direction on a field
 * the table no longer classifies that way, and so a SECOND `tighten-only` field
 * fails the guard in `__tests__/agent-write-policy.test.ts` until somebody
 * teaches the updater what "tighter" means for it.
 */
export const TIGHTEN_ONLY_AGENT_PATHS: readonly string[] = pathsWithAccess('tighten-only');

/**
 * The manifest fields whose value is an OBJECT of independently classified
 * leaves, derived from the dotted keys of {@link AGENT_WRITE_POLICY} rather than
 * written down a second time.
 *
 * {@link updateAgentManifest} merges a patch into the object already on disk for
 * these, instead of replacing it, so naming one flag leaves its siblings exactly
 * as they were stored (DOR-1719). Without that, every one of these objects is a
 * schema with `.default()`s on its leaves — `ConventionsSchema` defaults all four
 * to `true` — so a partial patch silently rewrote the ones it never mentioned.
 *
 * Derived rather than listed, so a nested field added to the wire gets the merge
 * the moment the table classifies it, and a field that stops being nested loses
 * it.
 */
export const NESTED_AGENT_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(AGENT_WRITE_POLICY)
    .filter((path) => path.includes('.'))
    .map((path) => path.slice(0, path.indexOf('.')))
);

/** {@link OPERATOR_ONLY_AGENT_PATHS}, prepared for matching. */
const OPERATOR_ONLY_AGENT_GUARDED = prepareGuardedPaths(OPERATOR_ONLY_AGENT_PATHS);

/** Every path {@link AGENT_WRITE_POLICY} carries a verdict for, as an own-key set. */
const CLASSIFIED_AGENT_PATHS: ReadonlySet<string> = new Set(Object.keys(AGENT_WRITE_POLICY));

/**
 * The dot-paths a patch reaches at THIS seam, which is more than the paths it
 * names — because naming an object is naming what is under it.
 *
 * ## The bypass this closes (adversarial review of DOR-1506)
 *
 * `patchPaths` emits LEAVES, and the matcher compares a touched path against a
 * guarded one by equality, ancestor, or descendant. `{ enabledToolGroups: {} }`
 * is therefore caught — it stops above the guarded leaves, so it matches all
 * five as an ancestor. `{ enabledToolGroups: { zzz: 1 } }` was NOT: it emits
 * `enabledToolGroups.zzz`, which equals no policy key, is under none, and is
 * above none either.
 *
 * And that patch WROTE. Zod strips the unrecognised key, so `parsed.data` carried
 * `enabledToolGroups: {}` — and `updateAgentManifest` intersects the parse result
 * with the RAW body's own keys, where `enabledToolGroups` is one of them, so the
 * empty object survived into a write that REPLACED the stored one. Measured
 * against a real manifest: `{"enabledToolGroups":{"zzz":1}}` answered 200 and
 * left `{}` on disk, clearing two documentation keys a person had turned off AND
 * `roomsManage: true`, which is a grant only a person may write — DOR-1506's own
 * defect, reachable through a key nobody had to guess right.
 * `{"behavior":{"zzz":1}}` was worse in kind: `AgentBehaviorSchema` defaults
 * `responseMode`, so the write re-armed the MOST permissive setting (`always`)
 * and dropped `escalationThreshold`. A nested `{"__proto__":{…}}` took the same
 * road (it arrives as an own key over HTTP; as a literal it makes the object
 * empty, which was already refused).
 *
 * ## Why it stays now that the write merges
 *
 * DOR-1719 made {@link updateAgentManifest} merge these objects leaf by leaf, so
 * an unrecognised key no longer clobbers anything on its own — that was the same
 * defect on the AGENT-WRITABLE objects, where `{"conventions":{"zzz":1}}` reset
 * four injection switches to `true`. The refusal is unchanged by that, for two
 * reasons: naming the parent of a guarded leaf is still a patch about the leaf,
 * and this seam answers such a patch with a sentence rather than a silent
 * no-op. Two independent answers to one question, which is what a security
 * control is supposed to have.
 *
 * ## The rule
 *
 * **Naming an object that sits above a guarded leaf counts as naming every leaf
 * under it, unless every key it carries is one this table classifies.** So each
 * unrecognised path contributes its ancestors, and an ancestor of a guarded leaf
 * is already matched by the existing comparison.
 *
 * Deliberately HERE and not in the shared walk. `config-write-policy.ts` has the
 * same gap and it is harmless there: `applyConfigPatch` deep-merges, so an
 * unknown key writes nothing around it. Making the walk emit ancestors for
 * everybody would also break the honesty rule the walk exists to keep — a
 * refusal must name what the caller actually tried to do (DOR-1044) — and this
 * seam is the one where naming the parent IS what the caller did.
 *
 * A top-level unrecognised key contributes no ancestor (there is nothing above
 * it), which is right: Zod strips it, `parsed.data` has no such key, and the
 * intersection drops it, so it writes nothing.
 *
 * @param body - The raw patch a caller supplied.
 * @returns Every path the patch reaches, plus the ancestors an unrecognised key
 *   makes it reach, `[]` markers removed.
 */
function touchedAgentPaths(body: unknown): string[] {
  const touched = patchPaths(body).map(withoutArrayMarkers);
  const reached = new Set(touched);

  for (const path of touched) {
    if (CLASSIFIED_AGENT_PATHS.has(path)) continue;
    const segments = path.split('.');
    for (let depth = segments.length - 1; depth > 0; depth--) {
      reached.add(segments.slice(0, depth).join('.'));
    }
  }

  return [...reached];
}

/**
 * The refusal sentence for each group of operator-only manifest fields.
 *
 * Per stake rather than one blanket claim, for the reason
 * `config-write-policy.ts` gives: a refusal that overstates what a setting does
 * is a lie the model then carries into the rest of the conversation (DOR-1044).
 * These sentences are also what the cockpit puts in a failure toast, so they name
 * the screen a person would go to.
 */
export const AGENT_OPERATOR_ONLY_STAKES: readonly {
  paths: readonly string[];
  description: string;
}[] = [
  {
    paths: ['name'],
    description:
      "An agent's short name is how everything else addresses it, so a person changes it. Use " +
      'displayName to change what it is called on screen',
  },
  {
    paths: ['namespace'],
    description:
      "An agent's namespace decides which other agents it can reach, so a person sets it",
  },
  {
    paths: ['behavior.responseMode', 'behavior.escalationThreshold'],
    description: 'When an agent speaks in a room without being asked is set by a person',
  },
  {
    paths: ['account'],
    description: "An agent's billing account is set by a person, in the agent's Runs on settings",
  },
  {
    paths: [
      'enabledToolGroups.tasks',
      'enabledToolGroups.relay',
      'enabledToolGroups.mesh',
      'enabledToolGroups.adapter',
    ],
    description:
      "Which tool groups an agent is told about is set by a person, in the agent's Tools settings",
  },
  {
    paths: ['enabledToolGroups.roomsManage'],
    description:
      "Whether an agent may manage rooms is set by a person, in the agent's Tools settings",
  },
];

/** What a refused field is called when no stake group claims it. */
const AGENT_OPERATOR_ONLY_FALLBACK = 'These settings are a person’s to choose, not an agent’s';

/**
 * Find the operator-only manifest fields a patch tries to write.
 *
 * Matches against {@link touchedAgentPaths} rather than the bare walk, so an
 * object carrying only keys this table does not classify is refused for every
 * leaf it would have replaced.
 *
 * @param body - The raw patch a caller supplied (any shape; a non-object touches
 *   nothing).
 * @returns The offending policy paths, sorted, each named once. Empty when the
 *   patch is clean.
 */
export function findOperatorOnlyAgentPaths(body: unknown): string[] {
  return matchGuardedPaths(touchedAgentPaths(body), OPERATOR_ONLY_AGENT_GUARDED);
}

/**
 * The refusal a caller reads: what it may not change, why in one plain sentence,
 * and what to do instead.
 *
 * Written for both audiences this seam has — a model, which will try again
 * unless it is told where the setting actually lives, and a person, who sees this
 * sentence in a save-failed toast.
 *
 * @param paths - The offending policy paths, from {@link findOperatorOnlyAgentPaths}.
 * @returns One short paragraph.
 */
export function describeAgentOperatorOnlyRefusal(paths: readonly string[]): string {
  const remaining = new Set(paths);
  const clauses: string[] = [];

  for (const group of AGENT_OPERATOR_ONLY_STAKES) {
    const matched = paths.filter((path) => group.paths.includes(path));
    if (matched.length === 0) continue;
    for (const path of matched) remaining.delete(path);
    clauses.push(`${group.description}: ${matched.join(', ')}.`);
  }

  if (remaining.size > 0) {
    clauses.push(`${AGENT_OPERATOR_ONLY_FALLBACK}: ${[...remaining].join(', ')}.`);
  }

  return [
    'DorkOS changed nothing.',
    ...clauses,
    'Ask the person to change them in DorkOS.',
    'If the rest of your patch was ordinary settings, send those on their own and they will go through.',
  ].join(' ');
}
