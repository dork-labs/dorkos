/**
 * The status model — what every agent tool does with every agent file in one
 * project, derived once and read by both the app and (later) the CLI.
 *
 * ## What it is
 *
 * A grid. Each ROW is one agent file, keyed by `(artifact, source, name)`. Each
 * CELL is that file paired with one enabled harness, and carries one of seven
 * states plus the sentence that explains it. Around the grid sits an envelope:
 * the enabled harnesses, the counts the page draws, and the list of paths a sync
 * would delete.
 *
 * ## Where it gets its facts
 *
 * Six facts from five calls, and nothing else:
 *
 * ```
 * loadManifest(projectPath)                    → the enabled set + the declared Claude-only names
 * manifestNotices(manifest)                    → what is wrong with the manifest itself
 * planWithConsent(projectPath, …)              → { plan, withheld }
 * checkPlan(projectPath, plan)                 → { drifted, blocked, orphans, leftAlone, clean }
 * inventorySourceTree(projectPath)             → what is authored in the tree
 * ```
 *
 * After a write a seventh joins them — `applyPlan`'s `conflicts`, handed in
 * through {@link BuildHarnessStatusOptions.afterWrite} — because a file somebody
 * else owns at a target is only discovered when the write is attempted.
 *
 * **The model never re-derives a harness's behaviour.** Where a chip says "Codex
 * can't see it", the sentence under it is the plan's own `reason` string,
 * unchanged. So a wrong chip is a PLAN bug and is fixed in the plan; this file
 * has no opinion of its own to correct. For the same reason `harnessCoverage()`
 * is not called here: its own module doc calls it the oracle a projection is
 * measured against, and running it in the read path would put a second,
 * independent model of six vendors' behaviour on a screen where it could
 * disagree with the first.
 *
 * ## Read-only, and it has to stay that way
 *
 * Nothing here writes. The plan is built through `planWithConsent` — never the
 * engine's bare `project()`, which is the seam `project-seam-guard.test.ts`
 * holds — and applying it is somebody else's job. `__tests__/status-model.test.ts`
 * pins that with a path-set snapshot of the tree before and after.
 *
 * @module services/harness/status
 */
import {
  checkPlan,
  globalInstallDropReason,
  HARNESS_MANIFEST_PATH,
  HARNESS_NATIVE_SKILL_ROOTS,
  inventorySourceTree,
  loadManifest,
  manifestNotices,
  scanInstalledPlugins,
  type ArtifactType,
  type DriftResult,
  type HarnessManifest,
  type InstalledLocation,
  type ProjectionAction,
  type ProjectionPlan,
  type ProjectionWarning,
  type Provenance,
  type SourceInventory,
} from '@dorkos/harness';
import type {
  HarnessArtifactKind,
  HarnessCell,
  HarnessId,
  HarnessPendingApproval,
  HarnessProjectEntry,
  HarnessProvenance,
  HarnessRow,
  HarnessScope,
  HarnessStatusResponse,
} from '@dorkos/shared/harness-schemas';
import { z } from 'zod';
import type { HookDecisions } from './hook-consent.js';
import {
  planWithConsent,
  type WithheldHooks,
  type WithheldReason,
} from './project-with-consent.js';

/**
 * The engine's artifact kinds, mapped onto the response's.
 *
 * The two lists are identical today and are still restated rather than shared:
 * `@dorkos/shared` cannot import the engine (the dependency edge runs the other
 * way), and the engine's list is documented as *what the projector plans*, which
 * is a different subject from *what the page draws*. The `satisfies` is what
 * keeps them honest — add a kind to `ArtifactType` and the compiler names the
 * gap here, exactly as it does in the projector's own placement tables.
 */
const ARTIFACT_KIND = {
  skill: 'skill',
  instruction: 'instruction',
  hook: 'hook',
  command: 'command',
  plugin: 'plugin',
  agent: 'agent',
  rule: 'rule',
  mcp: 'mcp',
} satisfies Record<ArtifactType, HarnessArtifactKind>;

/**
 * The engine's provenance values, mapped onto the response's.
 *
 * The response has a fourth the engine does not — `harness-native`, for a skill
 * authored in one tool's own directory (`.claude/skills`, `.opencode/skills`, …)
 * rather than in the canonical layer — so this direction is total and the reverse
 * one is not.
 */
const PROVENANCE = {
  authored: 'authored',
  installed: 'installed',
  adopted: 'adopted',
} satisfies Record<Provenance, HarnessProvenance>;

/**
 * The engine's install scopes, mapped onto the response's.
 *
 * The second `satisfies` table in this file, and it earns its place the same way
 * the first does: a third scope added to `InstalledLocation` — a machine tier, a
 * workspace tier — is a scope the page has to say something about, and the
 * compiler names this file the moment one appears rather than letting a row
 * quietly claim to be a project row.
 */
const INSTALL_SCOPE = {
  project: 'project',
  global: 'global',
} satisfies Record<InstalledLocation['scope'], HarnessScope>;

/** The canonical skills root: a skill here is shared with every harness. */
const CANONICAL_SKILLS_ROOT = '.agents/skills';

/** The Claude Code skills root. */
const CLAUDE_SKILLS_ROOT = '.claude/skills';

/**
 * Every skills root that belongs to one agent tool rather than to all of them —
 * `.claude/skills` and each folder another tool reads (`.opencode/skills`,
 * `.cursor/skills`, …).
 *
 * A skill in any of these is `harness-native` and is the one a person can adopt:
 * the fact the row is about is that the file sits where only some tools look, and
 * `.claude/skills` was never special about that — it was only the root the
 * inventory happened to walk (DOR-1902).
 */
const HARNESS_OWNED_SKILL_ROOTS: ReadonlySet<string> = new Set<string>([
  CLAUDE_SKILLS_ROOT,
  ...HARNESS_NATIVE_SKILL_ROOTS,
]);

/**
 * The separator inside a row or cell key. A NUL, because no artifact name, path
 * or harness id can contain one — so no two different triples can ever join into
 * the same string.
 */
const SEP = '\u0000';

/**
 * What the page says about a package whose hooks are held back, by reason.
 *
 * The commands themselves are deliberately absent — see
 * {@link HarnessPendingApproval}. `satisfies Record<WithheldReason, …>` so a
 * fourth reason cannot be added to the seam without a sentence for it.
 */
const WITHHELD_SENTENCE = {
  unasked: (pkg: string) => `${pkg} wants to run commands. Approve it to share its hooks.`,
  refused: (pkg: string) =>
    `You turned down ${pkg}'s commands. dorkos harness hooks --revoke ${pkg} undoes that.`,
  'unreadable-config': () =>
    "DorkOS couldn't read your settings, so nothing was installed on a guess.",
} satisfies Record<WithheldReason, (pkg: string) => string>;

/** What {@link buildHarnessStatus} needs to answer. */
export interface BuildHarnessStatusOptions {
  /** The project root — absolute, and already canonicalized by the caller. */
  projectPath: string;
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  /**
   * The stored hook decisions to obey. Defaults to the running server's config
   * store; the CLI passes the copy it reads straight off `config.json`, because
   * opening the store would write one (DOR-678).
   */
  decisions?: HookDecisions;
  /**
   * What the write that just happened ran into, when this status is being
   * computed after one.
   *
   * Only the conflicts are read: a file somebody else owns at a projection
   * target is discovered when the write is attempted, so `applyPlan` is the only
   * thing that can name it. Absent means this is a plain read.
   *
   * **Two of `applyPlan`'s conflict paths carry no `reason`** (`apply.ts`'s
   * symlink-EEXIST and corrupt-merge branches), so the cell they produce is a
   * `conflict` chip with nothing under it. The state is still the right one and
   * still changes what the person does, but the sentence is the engine's to
   * supply — a slice-7 follow-up, not something to invent here, because a reason
   * this model wrote would be the second voice §1.2 exists to prevent.
   */
  afterWrite?: { conflicts: readonly ProjectionAction[] };
  /**
   * The harness DorkOS's own default runtime reads
   * (`services/harness/dorkos-harness.ts`).
   *
   * Passed in rather than read here, because this function is a plain read-only
   * derivation over an options bag and reaching for the config store inside it
   * would make it one of the things DOR-678 forbids. When the manifest does not
   * enable it, it becomes a `dorkos-runtime` entry in {@link
   * HarnessStatusResponse.notEnabled} — the panel that says a tool is not being
   * shared to, for the one tool that leaves no footprint to find (DOR-1901).
   */
  dorkosHarness?: HarnessId;
}

/** A row while it is being built, before its cells are sealed into the response. */
interface DraftRow {
  artifact: HarnessArtifactKind;
  provenance: HarnessProvenance;
  /** Which scope the file lives in — part of the row key, and drawn on the row. */
  scope: HarnessScope;
  name: string;
  source?: string;
  cells: Map<HarnessId, HarnessCell>;
}

/**
 * The key that decides whether two entries are the same file.
 *
 * `scope` is the fourth component and global scope is what it is for: the same
 * package installed both in this project and for every project projects a skill
 * of the same name, of the same artifact kind, from sources that differ only in
 * whether the path happens to be absolute. Two rows differing in nothing a
 * reader can name is exactly the shape a key must not collapse, and relying on
 * the absolute-versus-relative spelling would be relying on an accident of how
 * each scan writes a path. Absent means `'project'`, matching the schema's
 * default, so every producer that predates global scope keys as it always did.
 *
 * Two of the other three have a measured counter-example on the J-01 fixture: two
 * settings files both contribute a hook group named `hooks` (so `source` is
 * needed), and two MCP servers share one `.mcp.json` (so `name` is).
 *
 * `artifact` does NOT, and the spec's stated example for it does not hold: it
 * offers a skill and a hook declared in that skill's own frontmatter as sharing
 * a source, but their sources are `.claude/skills/release` and
 * `.claude/skills/release/SKILL.md` — different strings, which `(source, name)`
 * already tells apart. Measured on this repository, `(source, name)` and
 * `(artifact, name)` each yield the same 57 distinct rows the full key does. It
 * stays in the key as cheap insurance: two kinds sharing one path is a shape the
 * inventory could grow at any time, and the cost of carrying it is one string
 * concatenation. (The spec's claim is corrected in slice 8.)
 *
 * The separator is a NUL because no path or artifact name can contain one.
 *
 * Exported so the four-part contract can be tested as a contract. On real trees
 * the two scopes' `source` strings already differ — one is repo-relative and one
 * absolute — so a fixture cannot make two entries collide on everything but
 * `scope`, and a key that quietly dropped it would pass every end-to-end
 * assertion right up until the day two sources agreed.
 *
 * @param entry - anything with the four components a row is keyed on.
 * @returns the key, NUL-separated.
 */
export function harnessRowKey(entry: {
  artifact: string;
  source?: string;
  name: string;
  scope?: HarnessScope;
}): string {
  return [entry.scope ?? 'project', entry.artifact, entry.source ?? '', entry.name].join(SEP);
}

/** The `(artifact, source)` half of a row key — what a warning attaches by. */
function artifactSourceKey(entry: { artifact: string; source?: string }): string {
  return `${entry.artifact}${SEP}${entry.source ?? ''}`;
}

/** The key that decides whether two entries are about the same file AND harness. */
function cellKey(
  entry: { artifact: string; source?: string; name: string; scope?: HarnessScope },
  h: HarnessId
): string {
  return `${harnessRowKey(entry)}${SEP}${h}`;
}

/**
 * Index entries by the cell they are about, keeping the first of any duplicates.
 *
 * First wins because the derivation table is a first-match-wins ladder, and a
 * plan that somehow named one cell twice should read the same way: the earlier
 * answer is the one the report already prints.
 */
function byCell(entries: readonly ProjectionAction[]): Map<string, ProjectionAction> {
  const index = new Map<string, ProjectionAction>();
  for (const entry of entries) {
    if (entry.harnessAgnostic === true) continue;
    const key = cellKey(entry, entry.harness);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * Every skill in one tool's own folder that a person could move into the
 * canonical layer.
 *
 * Read straight off the inventory, with the two exclusions that ARE the
 * definition rather than an optimisation. A skill that also lives in
 * `.agents/skills` is a duplicate whose fix is a deletion — a blocker, in
 * `.claude/skills`, where it occupies the projection target — so offering to move
 * it would offer the one action that makes it worse. A skill named in
 * `manifest.claudeOnlySkills` is a person saying the placement is deliberate, and
 * offering to undo it would argue with a decision that was written down.
 *
 * @param inventory - the source-tree inventory.
 * @param claudeOnlyNames - the names `manifest.claudeOnlySkills` declares.
 * @returns the repo-relative source paths of the adoptable skills.
 */
function adoptableSkillSources(
  inventory: SourceInventory,
  claudeOnlyNames: ReadonlySet<string>
): ReadonlySet<string> {
  const canonicalNames = new Set(
    inventory.skills.filter((s) => s.root === CANONICAL_SKILLS_ROOT).map((s) => s.name)
  );
  return new Set(
    inventory.skills
      .filter(
        (s) =>
          HARNESS_OWNED_SKILL_ROOTS.has(s.root) &&
          !canonicalNames.has(s.name) &&
          !claudeOnlyNames.has(s.name)
      )
      .map((s) => s.source)
  );
}

/**
 * Decide one cell, top to bottom, first match wins.
 *
 * `conflict` outranks `drifted` because the two mean opposite things to a
 * person: "re-run and it fixes itself" versus "re-running will never fix this".
 * `pending-approval` sits above everything but `conflict` because a withheld
 * package's hooks are filtered out of the plan BEFORE it is built — the state
 * fills a hole rather than overriding anything — and if a future engine change
 * ever put a withheld hook in the plan as well, the answer should stay "a person
 * has to decide".
 *
 * `warned` is not decided here: a warning either annotates the cell this
 * function returned, or becomes the whole of a cell nothing else named (row 8),
 * and both are settled once every row exists.
 */
function deriveCell(
  key: string,
  index: {
    conflicts: Map<string, ProjectionAction>;
    blocked: Map<string, ProjectionAction>;
    drifted: Map<string, ProjectionAction>;
    drops: Map<string, ProjectionAction>;
    actions: Map<string, ProjectionAction>;
  }
): HarnessCell | undefined {
  const conflict = index.conflicts.get(key) ?? index.blocked.get(key);
  if (conflict) return cell('conflict', conflict);

  const drifted = index.drifted.get(key);
  // No reason on a drifted cell: the target is what says where the file should
  // have been, and "it is not there yet" needs no sentence beyond that.
  if (drifted) {
    return {
      state: 'drifted',
      ...(drifted.target === undefined ? {} : { target: drifted.target }),
    };
  }

  const drop = index.drops.get(key);
  if (drop) return cell('dropped', drop);

  const action = index.actions.get(key);
  if (action) return cell(action.kind === 'native' ? 'native' : 'projected', action);

  return undefined;
}

/** One cell in a settled state, carrying the action's own words and target. */
function cell(state: HarnessCell['state'], action: ProjectionAction): HarnessCell {
  return {
    state,
    ...(action.reason === undefined ? {} : { reason: action.reason }),
    ...(action.target === undefined ? {} : { target: action.target }),
  };
}

/**
 * Attach one warning to the row it belongs to, or give it a row of its own.
 *
 * A `ProjectionWarning` has no provenance and its `name` does not always match
 * the action's for the same file — on J-01 the unparseable rule's warning is
 * named `.claude/rules/testing.md` while the action for that file is named
 * `testing` — so keying a warning by the full row key would fork a second row
 * holding one cell and two holes. It attaches by `(artifact, source)` instead,
 * choosing by `name` when more than one row shares that pair, and forms its own
 * row only when it matches none.
 *
 * @param warning - the warning to place.
 * @param rows - every row built so far, keyed by {@link harnessRowKey}.
 * @param byArtifactSource - row keys indexed by `(artifact, source)`.
 * @returns the row it landed on, creating one if it had to.
 */
function placeWarning(
  warning: ProjectionWarning,
  rows: Map<string, DraftRow>,
  byArtifactSource: Map<string, string[]>
): DraftRow {
  const candidates = byArtifactSource.get(artifactSourceKey(warning)) ?? [];
  const chosen =
    candidates.length > 1
      ? (candidates.find((key) => rows.get(key)?.name === warning.name) ?? candidates[0])
      : candidates[0];
  const existing = chosen === undefined ? undefined : rows.get(chosen);
  if (existing) return existing;

  const key = harnessRowKey(warning);
  const created: DraftRow = {
    artifact: ARTIFACT_KIND[warning.artifact],
    // A warning carries no provenance, and every non-agnostic warning the engine
    // emits is about a file in the person's own tree — which is also why its own
    // row is a project row.
    provenance: 'authored',
    scope: 'project',
    name: warning.name,
    ...(warning.source === undefined ? {} : { source: warning.source }),
    cells: new Map(),
  };
  rows.set(key, created);
  byArtifactSource.set(artifactSourceKey(warning), [key]);
  return created;
}

/** One skill in a package installed for all projects, with the sentence about it. */
interface GlobalSkill {
  /** The namespaced name a projection of it carries: `<pkg>__<skill>`. */
  name: string;
  /** The skill directory, absolute — a global package has no repo to be relative to. */
  source: string;
  /** The engine's own sentence about the package this skill is in. */
  reason: string;
}

/**
 * Every skill in every package installed for all projects, in scan order.
 *
 * The sentence is the engine's — `globalInstallDropReason`, the same string
 * `dorkos harness sync` prints under `plugin layers:` — so the terminal and the
 * screen say one thing about one package, including the clause slice A2 appends
 * about skills that run on a timer.
 *
 * @param dorkHome - the resolved data directory.
 * @returns one entry per skill, or none when the folder cannot be read.
 */
function globalSkills(dorkHome: string): GlobalSkill[] {
  let packages;
  try {
    packages = scanInstalledPlugins({ dorkHome });
  } catch {
    // A data directory that cannot be read is not this answer's to complain
    // about: the status page is a read, and `dorkos harness sync --global` is
    // the surface that reports on the folder itself.
    return [];
  }
  const skills: GlobalSkill[] = [];
  for (const plugin of packages) {
    if (plugin.location.scope !== 'global') continue;
    const reason = globalInstallDropReason(plugin);
    for (const skill of plugin.skills) {
      skills.push({
        name: `${plugin.name}__${skill.name}`,
        source: skill.sourceDir,
        reason,
      });
    }
  }
  return skills;
}

/**
 * What every enabled agent tool does with a global package's skills: nothing,
 * said out loud, one entry per skill per tool.
 *
 * **Dropped is the honest answer, and it stays honest now that slice A2 has
 * built the dork-home tier.** That tier links a global package's skills into
 * `<dorkHome>/skills`, which is DorkOS's own folder and which no agent tool
 * reads: it is what makes a global scheduled skill RUN, and it is not a way for
 * Codex or Claude Code to see the skill here.
 *
 * These are shaped as {@link ProjectionAction} drops rather than as finished
 * rows so that they go through the one row-and-cell derivation everything else
 * does: the row key decides collisions, the cell ladder decides states, and a
 * global row cannot drift into a second model of what a row is. They are
 * deliberately NOT `harnessAgnostic` — each really is about the tool it names,
 * and an agnostic entry would be filtered out of every cell.
 *
 * @param input - the global skills and the enabled agent tools.
 * @returns one drop per (global skill x enabled harness).
 */
function globalSkillEntries(input: {
  skills: readonly GlobalSkill[];
  enabled: readonly HarnessId[];
}): ProjectionAction[] {
  const entries: ProjectionAction[] = [];
  for (const skill of input.skills) {
    for (const harness of input.enabled) {
      entries.push({
        kind: 'drop',
        artifact: 'skill',
        harness,
        provenance: 'installed',
        scope: INSTALL_SCOPE.global,
        name: skill.name,
        source: skill.source,
        reason: skill.reason,
      });
    }
  }
  return entries;
}

/**
 * The global rows for an answer with no enabled harnesses to fill cells with — a
 * project with no manifest, or one whose manifest will not parse.
 *
 * The rows still appear, with no cells, because the alternative is silence: a
 * folder that is not set up can still belong to somebody who installed a package
 * for every project, and answering nothing about it would reproduce the defect
 * the honest drop list exists to end. With no enabled tool there is no cell to
 * put a sentence in, so the row IS the answer.
 *
 * @param dorkHome - the resolved data directory.
 * @returns one cell-less row per global skill.
 */
function globalRowsWithoutHarnesses(dorkHome: string): HarnessRow[] {
  return globalSkills(dorkHome).map((skill) => ({
    artifact: 'skill',
    provenance: 'installed',
    scope: 'global',
    name: skill.name,
    source: skill.source,
    adoptable: false,
    cells: {},
  }));
}

/** One withheld package, reduced to what a person may be told about it. */
function pendingApprovalEntry(withheld: WithheldHooks): HarnessPendingApproval {
  return {
    packageName: withheld.request.packageName,
    events: [...new Set(withheld.request.hooks.map((h) => h.event))].sort(),
    commandCount: withheld.request.hooks.length,
    reason: withheld.reason,
    ...(withheld.unreadable === undefined ? {} : { detail: withheld.unreadable }),
  };
}

/**
 * An envelope with nothing of this PROJECT's in it — the honest shape for every
 * state but `ready`.
 *
 * The global half is not empty, and that is deliberate: a project with no
 * manifest can still hold a person who installed a package for every project,
 * and this folder not being set up says nothing about that.
 */
function emptyStatus(
  projectPath: string,
  dorkHome: string,
  state: HarnessStatusResponse['state'],
  detail?: string
): HarnessStatusResponse {
  const rows = globalRowsWithoutHarnesses(dorkHome);
  return {
    projectPath,
    state,
    ...(detail === undefined ? {} : { detail }),
    computedAt: new Date().toISOString(),
    enabled: [],
    notEnabled: [],
    // Nothing is out of date, because nothing is set up to be out of date. The
    // page draws the state, not the banner, so this never offers a sync.
    clean: true,
    counts: {
      skills: 0,
      globalSkills: rows.length,
      drifted: 0,
      conflicts: 0,
      orphans: 0,
      adoptable: 0,
      pendingApproval: 0,
    },
    sweepPreview: [],
    removals: [],
    rows,
    projectLevel: [],
    pendingApproval: [],
  };
}

/**
 * Why `.agents/harness.manifest.json` could not be used, in words a person can
 * act on.
 *
 * A Zod error's own `message` is a JSON dump of its issues, which is not a
 * sentence; a `SyntaxError` from `JSON.parse` already is one and only needs the
 * file named.
 */
function manifestFailureDetail(err: unknown): string {
  const file = '.agents/harness.manifest.json';
  if (err instanceof z.ZodError) {
    const issues = err.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return `${file} does not match the harness manifest format — ${issues}`;
  }
  return `${file} could not be read — ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * What one project's agent-file sharing looks like right now.
 *
 * Read-only: it plans, diffs and inventories, and writes nothing. The derivation
 * order, per cell, is the one this module's docs describe — conflict, then
 * pending approval, then drift, then a drop, then a native or projected action,
 * and `warned` last for a cell nothing else named.
 *
 * `state` answers for the project as a whole: `ready` when the manifest parsed,
 * `not-set-up` when there is no manifest, and `unreadable` when there is one and
 * it will not parse (with `detail` saying why). On anything but `ready` every
 * list is empty and every count is zero. The fourth value, `unavailable`, is
 * never returned here — it belongs to a build with no harness service at all,
 * which is the Obsidian transport's answer rather than this function's.
 *
 * **A `projectPath` that does not exist reads `not-set-up`**, because the
 * manifest read fails with `ENOENT` either way and this function cannot tell an
 * empty project from an absent one. Distinguishing them is the route's job, and
 * it takes a `stat` to do it: the boundary validator does NOT refuse a path that
 * leads nowhere — measured, `validateBoundaryOrDorkHome` canonicalizes a
 * not-yet-existing path through its deepest existing ancestor and RETURNS it,
 * which is what lets a workspace about to be cloned validate. `routes/harness.ts`
 * answers `404` there.
 *
 * @param options - the project, the data directory, the decisions to obey, and
 *   what a write that just happened ran into.
 * @returns the full status response, ready to be sent as-is.
 */
export function buildHarnessStatus(options: BuildHarnessStatusOptions): HarnessStatusResponse {
  const { projectPath, dorkHome, decisions, afterWrite, dorkosHarness } = options;

  let manifest: HarnessManifest;
  try {
    manifest = loadManifest(projectPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyStatus(projectPath, dorkHome, 'not-set-up');
    }
    return emptyStatus(projectPath, dorkHome, 'unreadable', manifestFailureDetail(err));
  }

  // Read the moment the manifest parses, and from the engine's own function, so
  // the page and `dorkos harness sync` carry the same sentences about the same
  // file rather than two derivations of one fact (DOR-1906).
  const notices = manifestNotices(manifest);

  const { plan, withheld } = planWithConsent(projectPath, {
    dorkHome,
    ...(decisions === undefined ? {} : { decisions }),
    ...(dorkosHarness === undefined ? {} : { dorkosHarness }),
  });
  const drift = checkPlan(projectPath, plan);
  const inventory = inventorySourceTree(projectPath);

  // De-duplicated: the manifest is a hand-editable file and `harnesses` is a
  // plain array, so `["codex", "codex"]` parses. Left alone it draws the column
  // twice and doubles every count that walks it.
  const enabledSet = new Set(manifest.harnesses);
  const enabled = [...enabledSet];
  const rows = buildRows({
    plan,
    drift,
    inventory,
    withheld,
    enabled,
    enabledSet,
    claudeOnlyNames: new Set(manifest.claudeOnlySkills.map((entry) => entry.name)),
    conflicts: afterWrite?.conflicts ?? [],
    // Folded into every project's answer, never behind a `?scope=global`
    // variant: the question a person asks is what an agent tool can see HERE,
    // and here always includes what is installed for every project. A second
    // call would make the page merge two answers and decide precedence between
    // them, which is the one thing DorkOS has no opinion about.
    globalEntries: globalSkillEntries({ skills: globalSkills(dorkHome), enabled }),
  });

  const cells = rows.flatMap((row) =>
    Object.values(row.cells).filter((c): c is HarnessCell => c !== undefined)
  );
  return {
    projectPath,
    state: 'ready',
    computedAt: new Date().toISOString(),
    enabled,
    notEnabled: plan.notEnabled.map((d) => ({
      harness: d.harness,
      why: d.why,
      ...(d.signal === undefined ? {} : { signal: d.signal }),
    })),
    // Stated in full rather than read off `DriftResult.clean`, because the field
    // this page cares about is "would a sync change anything" and an orphan-only
    // tree — nothing drifted, nothing blocked, nine files a sync deletes — is the
    // case that reads clean the moment orphans are left out of the sentence.
    clean: drift.drifted.length === 0 && drift.blocked.length === 0 && drift.orphans.length === 0,
    counts: {
      // Project rows only, which is exactly what this counted before global rows
      // existed — so the number under the profile row does not move when they
      // ship. `globalSkills` counts the other half, and the two are disjoint.
      skills: rows.filter((row) => row.artifact === 'skill' && row.scope === 'project').length,
      globalSkills: rows.filter((row) => row.artifact === 'skill' && row.scope === 'global').length,
      drifted: cells.filter((c) => c.state === 'drifted').length,
      conflicts: cells.filter((c) => c.state === 'conflict').length,
      orphans: drift.orphans.length,
      adoptable: rows.filter((row) => row.adoptable).length,
      pendingApproval: withheld.length,
    },
    sweepPreview: [...drift.orphans],
    // The same paths with the reason each one goes (DOR-1906). Both are sent:
    // the bare list is what the equality contract with the next `swept` is
    // written against, and this is what the page shows a person before a click
    // deletes anything.
    removals: [...drift.removals],
    rows,
    projectLevel: projectLevelEntries(plan, enabledSet, notices),
    pendingApproval: withheld.map(pendingApprovalEntry),
  };
}

/**
 * Whether a warning is really about a harness this project runs.
 *
 * This is the predicate {@link buildRows} and {@link projectLevelEntries} split
 * on, and they split on the SAME one so that every warning lands in exactly one
 * of the two — a cell, or the project-level list, never both and never neither.
 *
 * Two ways to fail it. `harnessAgnostic` is the declared one: the entry was
 * never about a harness, and the `harness` beside it is a placeholder its
 * emitter documents as such. The second is a placeholder nobody flagged —
 * measured on four ordinary trees, where a project enabling only OpenCode got a
 * `claude-code` cell for its unreadable `.mcp.json`, which is either an invisible
 * row (a renderer drawing the enabled columns finds nothing in it) or a chip for
 * an agent the person does not run. The engine's own emitters were fixed to
 * carry the flag; this check is the half that stays true when the next
 * placeholder is added without it.
 */
function isAboutEnabledHarness(
  warning: ProjectionWarning,
  enabled: ReadonlySet<HarnessId>
): boolean {
  return warning.harnessAgnostic !== true && enabled.has(warning.harness);
}

/**
 * Everything about this project that is about no harness it runs.
 *
 * The manifest notices go FIRST, and they are the one population that does not
 * come from the plan at all: they are about `.agents/harness.manifest.json`
 * itself — a retired key, a hook policy naming a tool this manifest does not
 * enable (DOR-1906) — so nothing in the plan could ever hold them. First because
 * they are the cheapest thing on the list to fix and the only one whose fix is a
 * line to delete.
 *
 * Then two plan populations, and neither is discriminated by `source`: a plugin-layer drop
 * carries no source, and the unreadable-hook warning carries one and is still
 * agnostic. The first is `harnessAgnostic`; the second is a warning naming a
 * harness the manifest does not enable, which reaches no column and so has
 * nowhere else honest to go (see {@link isAboutEnabledHarness}).
 *
 * Actions land here too, for one reason and one shape: an action naming a
 * harness the manifest does not enable, whose kind WRITES. The unconditional
 * `.agents/skills` link is the live case — it exists for the directory, not for
 * one reader, so the plan attributes it to Codex whether or not Codex is on, and
 * on a Claude-Code-only project it reached no column at all while `clean` was
 * false and a sync created the file. A preview that omits a file the click
 * creates is the same hole as one that omits a file the click deletes.
 *
 * A `native` action for a harness nobody runs is deliberately NOT here: nothing
 * is written, so there is nothing for a person to act on or be surprised by.
 * Drops are not either — every non-agnostic drop names an enabled harness, since
 * the drop lists are built by walking `manifest.harnesses` — and if that ever
 * stops being true this is where the case belongs.
 */
function projectLevelEntries(
  plan: ProjectionPlan,
  enabled: ReadonlySet<HarnessId>,
  notices: readonly string[]
): HarnessProjectEntry[] {
  const entry = (
    kind: 'drop' | 'warning' | 'write',
    e: { artifact: ArtifactType; name: string; source?: string; target?: string; reason?: string }
  ): HarnessProjectEntry => ({
    kind,
    artifact: ARTIFACT_KIND[e.artifact],
    name: e.name,
    ...(e.source === undefined ? {} : { source: e.source }),
    ...(e.target === undefined ? {} : { target: e.target }),
    // A drop without a reason is an engine bug, not a blank line on somebody's
    // screen: the field is required for a `drop` and the page has a paragraph
    // shaped to hold it. Say what is missing rather than rendering nothing.
    reason: e.reason ?? `${e.name} has no home in any agent tool, and the plan gave no reason`,
  });
  return [
    ...notices.map(noticeEntry),
    ...plan.drops.filter((d) => d.harnessAgnostic === true).map((d) => entry('drop', d)),
    ...plan.warnings
      .filter((w) => !isAboutEnabledHarness(w, enabled))
      .map((w) => entry('warning', w)),
    ...plan.actions.filter(isUnattributedWrite(enabled)).map((a) => entry('write', a)),
  ];
}

/**
 * One line about the manifest itself, as a project-level entry (DOR-1906).
 *
 * The sentence is `manifestNotices`' own, unchanged — the CLI prints the same
 * words through `formatManifestNotices`, and the engine function is called once
 * here rather than the derivation being repeated, so the terminal and the screen
 * cannot disagree about which key is dead.
 *
 * **`name` is the manifest file, not the key or the tool the line is about, and
 * that is a deliberate limit rather than an oversight.** `manifestNotices`
 * returns sentences; the subject lives inside the sentence. Recovering it here
 * would mean either matching prose or re-deriving which keys are retired and
 * which policies reach nothing — a second model of a thing the engine already
 * decided, which is exactly what this module's header refuses to do for a plan's
 * `reason`, and which would fall silently out of step the day a fifth notice
 * family is added. Naming the file is true of every line (each one says
 * "X in `.agents/harness.manifest.json` …"), and the sentence beneath it already
 * names the key or the tool in plain words. The honest fix is for
 * `manifestNotices` to return its subject beside its sentence; that belongs in
 * the engine, and is a follow-up.
 */
function noticeEntry(reason: string): HarnessProjectEntry {
  return { kind: 'notice', artifact: 'manifest', name: HARNESS_MANIFEST_PATH, reason };
}

/**
 * An action that writes a file for a harness this project does not enable.
 *
 * Curried so the filter reads as one line, and named so the reason it exists is
 * the name: the harness on such an action is a placeholder the emitter documents
 * as arbitrary, and the file it writes is real.
 */
function isUnattributedWrite(
  enabled: ReadonlySet<HarnessId>
): (action: ProjectionAction) => boolean {
  return (action) =>
    action.harnessAgnostic !== true &&
    !enabled.has(action.harness) &&
    action.kind !== 'native' &&
    action.target !== undefined;
}

/**
 * Build every row, in the order the plan named them.
 *
 * Four passes, because each depends on the one before it: the actions and drops
 * decide which rows exist at all, the warnings need those rows to attach to, the
 * withheld packages add rows the plan deliberately does not contain, and the
 * adoptable flag is a fact about the file rather than about any of them.
 */
function buildRows(input: {
  plan: ProjectionPlan;
  drift: DriftResult;
  inventory: SourceInventory;
  withheld: readonly WithheldHooks[];
  enabled: readonly HarnessId[];
  enabledSet: ReadonlySet<HarnessId>;
  claudeOnlyNames: ReadonlySet<string>;
  conflicts: readonly ProjectionAction[];
  /**
   * The global drops folded into this project's answer — see
   * {@link globalSkillEntries}. They travel with the plan's own drops through
   * every pass below, so a global row is derived by the same rules a project row
   * is; the row key is what keeps the two apart.
   */
  globalEntries: readonly ProjectionAction[];
}): HarnessRow[] {
  const {
    plan,
    drift,
    inventory,
    withheld,
    enabled,
    enabledSet,
    claudeOnlyNames,
    conflicts,
    globalEntries,
  } = input;
  const allDrops = [...plan.drops, ...globalEntries];
  const index = {
    conflicts: byCell(conflicts),
    blocked: byCell(drift.blocked),
    drifted: byCell(drift.drifted),
    drops: byCell(allDrops),
    actions: byCell(plan.actions),
  };

  const rows = new Map<string, DraftRow>();
  const byArtifactSource = new Map<string, string[]>();
  for (const entry of [...plan.actions, ...allDrops]) {
    if (entry.harnessAgnostic === true) continue;
    const key = harnessRowKey(entry);
    if (!rows.has(key)) {
      rows.set(key, {
        artifact: ARTIFACT_KIND[entry.artifact],
        provenance: PROVENANCE[entry.provenance],
        scope: entry.scope ?? 'project',
        name: entry.name,
        ...(entry.source === undefined ? {} : { source: entry.source }),
        cells: new Map(),
      });
      const pair = artifactSourceKey(entry);
      byArtifactSource.set(pair, [...(byArtifactSource.get(pair) ?? []), key]);
    }
  }

  // Pass 1 — the state of every cell the plan names, asked per enabled harness so
  // a cell can only ever belong to a harness the person actually runs.
  for (const [key, row] of rows) {
    for (const harness of enabled) {
      const derived = deriveCell(`${key}${SEP}${harness}`, index);
      if (derived) row.cells.set(harness, derived);
    }
  }

  // Pass 2 — warnings. One rides a cell that already has a state; one that names
  // a cell nothing else did becomes that cell (row 8 of the derivation table).
  // A warning about a harness this project does not run is neither: it went to
  // `projectLevel` instead, on the same predicate, so no warning is dropped and
  // none reaches a column that is not drawn.
  for (const warning of plan.warnings) {
    if (!isAboutEnabledHarness(warning, enabledSet)) continue;
    const row = placeWarning(warning, rows, byArtifactSource);
    const existing = row.cells.get(warning.harness);
    if (existing) existing.warnings = [...(existing.warnings ?? []), warning.reason];
    else row.cells.set(warning.harness, { state: 'warned', reason: warning.reason });
  }

  // Pass 3 — the packages whose hooks were filtered out before the plan was
  // built. Every enabled harness gets the cell, because the hooks reached none of
  // them; which harness would have taken them is the plan's question, and the
  // plan was never asked.
  //
  // KNOWN SHAPE, stated because it looks like a bug from the outside: a withheld
  // package's row identity is not stable across a consent decision. Withheld, it
  // is one row keyed `(hook, —, "<package>")`, named after the package, because
  // the package is the only thing there is to name — the plan holds nothing about
  // it. Approved, the same commands arrive as the plan's own entries under keys
  // that share none of that: measured, a Claude Code merge at
  // `(hook, —, "plugin-hooks")` — the merge action carries no `source` — plus one
  // generated row per other harness at
  // `(hook, .dork/plugins/<pkg>/hooks/hooks.json, "hooks")`. So a client keying
  // rows for animation or selection sees the row replaced, not updated, the
  // moment somebody says yes. That is the honest reading rather than a defect to
  // paper over: before the decision there is no projection to describe, and
  // inventing a post-approval key for a projection that does not exist would put
  // a row on the page claiming a file that is not there.
  for (const held of withheld) {
    const draft: DraftRow = {
      artifact: 'hook',
      provenance: 'installed',
      scope: 'project',
      name: held.request.packageName,
      cells: new Map(),
    };
    const key = harnessRowKey(draft);
    // UNREACHABLE TODAY, and deliberately kept. The seam filters a withheld
    // package's hooks out before the plan is built, so nothing else can have
    // claimed this key and `rows.get` always misses — which also means the
    // `conflict` guard below never fires, and no test can red it. Both are here
    // because the precedence they encode is the spec's and the cost is two lines:
    // if a future engine change ever puts a withheld hook in the plan as well,
    // the state fills a hole rather than replacing a row, and "a person has to
    // move a file" still outranks "a person has to decide". Delete them the day
    // that becomes impossible rather than leaving them to rot.
    const row = rows.get(key) ?? draft;
    const reason = WITHHELD_SENTENCE[held.reason](held.request.packageName);
    for (const harness of enabled) {
      if (row.cells.get(harness)?.state === 'conflict') continue;
      row.cells.set(harness, {
        state: 'pending-approval',
        reason: held.unreadable === undefined ? reason : `${reason} ${held.unreadable}`,
      });
    }
    rows.set(key, row);
  }

  const adoptable = adoptableSkillSources(inventory, claudeOnlyNames);
  const harnessNativeSkills = new Set(
    inventory.skills.filter((s) => HARNESS_OWNED_SKILL_ROOTS.has(s.root)).map((s) => s.source)
  );
  return [...rows.values()].map((row) => ({
    artifact: row.artifact,
    scope: row.scope,
    // The one override on top of the plan's own provenance, and the only producer
    // of `harness-native`: a skill authored where one tool looks rather than in
    // the canonical layer is what the adoptable advice is about.
    provenance:
      row.artifact === 'skill' && row.source !== undefined && harnessNativeSkills.has(row.source)
        ? 'harness-native'
        : row.provenance,
    name: row.name,
    ...(row.source === undefined ? {} : { source: row.source }),
    adoptable: row.artifact === 'skill' && row.source !== undefined && adoptable.has(row.source),
    cells: Object.fromEntries(row.cells),
  }));
}
