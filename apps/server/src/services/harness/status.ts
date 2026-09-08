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
 * Five facts from four calls, and nothing else:
 *
 * ```
 * loadManifest(projectPath)                    → the enabled set + the declared Claude-only names
 * planWithConsent(projectPath, …)              → { plan, withheld }
 * checkPlan(projectPath, plan)                 → { drifted, blocked, orphans, leftAlone, clean }
 * inventorySourceTree(projectPath)             → what is authored in the tree
 * ```
 *
 * After a write a sixth joins them — `applyPlan`'s `conflicts`, handed in
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
  inventorySourceTree,
  loadManifest,
  type ArtifactType,
  type DriftResult,
  type HarnessManifest,
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
 * authored in a harness's own directory rather than in the canonical layer — so
 * this direction is total and the reverse one is not.
 */
const PROVENANCE = {
  authored: 'authored',
  installed: 'installed',
  adopted: 'adopted',
} satisfies Record<Provenance, HarnessProvenance>;

/** The canonical skills root: a skill here is shared with every harness. */
const CANONICAL_SKILLS_ROOT = '.agents/skills';

/** The Claude Code skills root: a skill here is the one a person can adopt. */
const CLAUDE_SKILLS_ROOT = '.claude/skills';

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
   */
  afterWrite?: { conflicts: readonly ProjectionAction[] };
}

/** A row while it is being built, before its cells are sealed into the response. */
interface DraftRow {
  artifact: HarnessArtifactKind;
  provenance: HarnessProvenance;
  name: string;
  source?: string;
  cells: Map<HarnessId, HarnessCell>;
}

/**
 * The key that decides whether two entries are the same file.
 *
 * All three components are load-bearing, and each has a counter-example on the
 * J-01 fixture: two settings files both contribute a hook group named `hooks`
 * (so `source` is needed), two MCP servers share one `.mcp.json` (so `name` is),
 * and a skill and a hook declared in that skill's own frontmatter share a source
 * (so `artifact` is). The separator is a NUL because no path or artifact name
 * can contain one.
 */
function rowKey(entry: { artifact: string; source?: string; name: string }): string {
  return [entry.artifact, entry.source ?? '', entry.name].join(SEP);
}

/** The `(artifact, source)` half of a row key — what a warning attaches by. */
function artifactSourceKey(entry: { artifact: string; source?: string }): string {
  return `${entry.artifact}${SEP}${entry.source ?? ''}`;
}

/** The key that decides whether two entries are about the same file AND harness. */
function cellKey(entry: { artifact: string; source?: string; name: string }, h: HarnessId): string {
  return `${rowKey(entry)}${SEP}${h}`;
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
 * Every `.claude/skills` skill a person could move into the canonical layer.
 *
 * Read straight off the inventory, with the two exclusions that ARE the
 * definition rather than an optimisation. A skill that also lives in
 * `.agents/skills` is a blocker whose fix is a deletion — the projector's own
 * words — so offering to move it would offer the one action that makes it worse.
 * A skill named in `manifest.claudeOnlySkills` is a person saying the placement
 * is deliberate, and offering to undo it would argue with a decision that was
 * written down.
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
          s.root === CLAUDE_SKILLS_ROOT &&
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
 * @param rows - every row built so far, keyed by {@link rowKey}.
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

  const key = rowKey(warning);
  const created: DraftRow = {
    artifact: ARTIFACT_KIND[warning.artifact],
    // A warning carries no provenance, and every non-agnostic warning the engine
    // emits is about a file in the person's own tree.
    provenance: 'authored',
    name: warning.name,
    ...(warning.source === undefined ? {} : { source: warning.source }),
    cells: new Map(),
  };
  rows.set(key, created);
  byArtifactSource.set(artifactSourceKey(warning), [key]);
  return created;
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

/** An envelope with nothing in it — the honest shape for every state but `ready`. */
function emptyStatus(
  projectPath: string,
  state: HarnessStatusResponse['state'],
  detail?: string
): HarnessStatusResponse {
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
    counts: { skills: 0, drifted: 0, conflicts: 0, orphans: 0, adoptable: 0, pendingApproval: 0 },
    sweepPreview: [],
    rows: [],
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
 * @param options - the project, the data directory, the decisions to obey, and
 *   what a write that just happened ran into.
 * @returns the full status response, ready to be sent as-is.
 */
export function buildHarnessStatus(options: BuildHarnessStatusOptions): HarnessStatusResponse {
  const { projectPath, dorkHome, decisions, afterWrite } = options;

  let manifest: HarnessManifest;
  try {
    manifest = loadManifest(projectPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyStatus(projectPath, 'not-set-up');
    }
    return emptyStatus(projectPath, 'unreadable', manifestFailureDetail(err));
  }

  const { plan, withheld } = planWithConsent(projectPath, {
    dorkHome,
    ...(decisions === undefined ? {} : { decisions }),
  });
  const drift = checkPlan(projectPath, plan);
  const inventory = inventorySourceTree(projectPath);

  const enabled = [...manifest.harnesses];
  const rows = buildRows({
    plan,
    drift,
    inventory,
    withheld,
    enabled,
    claudeOnlyNames: new Set(manifest.claudeOnlySkills.map((entry) => entry.name)),
    conflicts: afterWrite?.conflicts ?? [],
  });

  const cells = rows.flatMap((row) =>
    Object.values(row.cells).filter((c): c is HarnessCell => c !== undefined)
  );
  return {
    projectPath,
    state: 'ready',
    computedAt: new Date().toISOString(),
    enabled,
    notEnabled: plan.notEnabled.map((d) => ({ harness: d.harness, signal: d.signal })),
    // Stated in full rather than read off `DriftResult.clean`, because the field
    // this page cares about is "would a sync change anything" and an orphan-only
    // tree — nothing drifted, nothing blocked, nine files a sync deletes — is the
    // case that reads clean the moment orphans are left out of the sentence.
    clean: drift.drifted.length === 0 && drift.blocked.length === 0 && drift.orphans.length === 0,
    counts: {
      skills: rows.filter((row) => row.artifact === 'skill').length,
      drifted: cells.filter((c) => c.state === 'drifted').length,
      conflicts: cells.filter((c) => c.state === 'conflict').length,
      orphans: drift.orphans.length,
      adoptable: rows.filter((row) => row.adoptable).length,
      pendingApproval: withheld.length,
    },
    sweepPreview: [...drift.orphans],
    rows,
    projectLevel: projectLevelEntries(plan),
    pendingApproval: withheld.map(pendingApprovalEntry),
  };
}

/**
 * Everything the plan said that is about no harness at all.
 *
 * `harnessAgnostic` is the discriminator and `source` is not a proxy for it: a
 * plugin-layer drop carries no source, and the unreadable-hook warning carries
 * one and is still agnostic. Filing either under a harness would tell somebody
 * who runs Codex alone that Claude Code has a problem.
 *
 * Only drops and warnings are read, because only drops and warnings are ever
 * agnostic: the three emitters are `dropWholePlugin`, `dropNonPortableLayers`
 * and `planUnreadableHookWarnings`. An agnostic ACTION would be a projection
 * that reaches no harness, which is a contradiction the engine has never
 * produced — and it would need a third `kind` here rather than being folded
 * into one of these two, so it stays a decision to make rather than a default.
 */
function projectLevelEntries(plan: ProjectionPlan): HarnessProjectEntry[] {
  const entry = (
    kind: 'drop' | 'warning',
    e: { artifact: ArtifactType; name: string; source?: string; reason?: string }
  ): HarnessProjectEntry => ({
    kind,
    artifact: ARTIFACT_KIND[e.artifact],
    name: e.name,
    ...(e.source === undefined ? {} : { source: e.source }),
    reason: e.reason ?? '',
  });
  return [
    ...plan.drops.filter((d) => d.harnessAgnostic === true).map((d) => entry('drop', d)),
    ...plan.warnings.filter((w) => w.harnessAgnostic === true).map((w) => entry('warning', w)),
  ];
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
  claudeOnlyNames: ReadonlySet<string>;
  conflicts: readonly ProjectionAction[];
}): HarnessRow[] {
  const { plan, drift, inventory, withheld, enabled, claudeOnlyNames, conflicts } = input;
  const index = {
    conflicts: byCell(conflicts),
    blocked: byCell(drift.blocked),
    drifted: byCell(drift.drifted),
    drops: byCell(plan.drops),
    actions: byCell(plan.actions),
  };

  const rows = new Map<string, DraftRow>();
  const byArtifactSource = new Map<string, string[]>();
  for (const entry of [...plan.actions, ...plan.drops]) {
    if (entry.harnessAgnostic === true) continue;
    const key = rowKey(entry);
    if (!rows.has(key)) {
      rows.set(key, {
        artifact: ARTIFACT_KIND[entry.artifact],
        provenance: PROVENANCE[entry.provenance],
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
  for (const warning of plan.warnings) {
    if (warning.harnessAgnostic === true) continue;
    const row = placeWarning(warning, rows, byArtifactSource);
    const existing = row.cells.get(warning.harness);
    if (existing) existing.warnings = [...(existing.warnings ?? []), warning.reason];
    else row.cells.set(warning.harness, { state: 'warned', reason: warning.reason });
  }

  // Pass 3 — the packages whose hooks were filtered out before the plan was
  // built. Every enabled harness gets the cell, because the hooks reached none of
  // them; which harness would have taken them is the plan's question, and the
  // plan was never asked.
  for (const held of withheld) {
    const draft: DraftRow = {
      artifact: 'hook',
      provenance: 'installed',
      name: held.request.packageName,
      cells: new Map(),
    };
    const key = rowKey(draft);
    // The seam filters a withheld package's hooks out before the plan is built,
    // so no row can exist under this key today. Taking the existing one if there
    // ever is one keeps the precedence honest in both directions: the state fills
    // a hole rather than replacing a row, and `conflict` still outranks it,
    // because "a person has to move a file" survives "a person has to decide".
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
  const claudeNativeSkills = new Set(
    inventory.skills.filter((s) => s.root === CLAUDE_SKILLS_ROOT).map((s) => s.source)
  );
  return [...rows.values()].map((row) => ({
    artifact: row.artifact,
    // The one override on top of the plan's own provenance, and the only producer
    // of `harness-native`: a skill authored where a harness looks rather than in
    // the canonical layer is what the adoptable advice is about.
    provenance:
      row.artifact === 'skill' && row.source !== undefined && claudeNativeSkills.has(row.source)
        ? 'harness-native'
        : row.provenance,
    name: row.name,
    ...(row.source === undefined ? {} : { source: row.source }),
    adoptable: row.artifact === 'skill' && row.source !== undefined && adoptable.has(row.source),
    cells: Object.fromEntries(row.cells),
  }));
}
