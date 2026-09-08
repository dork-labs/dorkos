/**
 * The projector half of the source inventory — turning everything
 * `inventory/` counted into an honest per-harness line.
 *
 * Four kinds reach a harness report for the first time here: subagent
 * definitions, path-scoped rules, MCP servers, and the two hook sources the
 * engine never read (`.claude/settings.local.json` and a skill's own
 * frontmatter). Nothing is WRITTEN for any of them — `applyPlan` treats
 * `native` and `drop` as no-ops — so this changes what a person is told and
 * nothing about what lands on disk.
 *
 * **Every reason names a real path a real vendor documents.** The three tables
 * below were each checked against the vendor's own page on
 * {@link SOURCE_ARTIFACT_FACTS_FETCHED_AT}, and two of them contradicted the
 * capabilities contract, which had marked those cells "(verify)":
 *
 * - **Codex does have project subagents** — `.codex/agents/*.toml`, one TOML
 *   file per agent (learn.chatgpt.com/docs/agent-configuration/subagents.md).
 * - **Gemini CLI does too** — `.gemini/agents/*.md` with YAML frontmatter
 *   (geminicli.com/docs/core/subagents/).
 *
 * And one cell is a `native` rather than a drop for the same reason five
 * harnesses take `.agents/skills` natively: **Cursor reads `.claude/agents`
 * directly**, with its own `.cursor/agents` taking precedence
 * (cursor.com/docs/subagents). Telling a Cursor user their subagents were
 * dropped would be the stale-drop mistake SK-05 records, in a new place.
 *
 * The rule for a cell nobody could verify is the contract's: say so. No table
 * entry invents a path, and a harness whose page documents nothing gets a reason
 * that says the vendor documents nothing — never a plausible guess.
 *
 * @module plan/source-artifacts
 */
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { ProjectionAction, ProjectionWarning } from './types.js';
import type {
  HookInventoryEntry,
  HookOrigin,
  SkillInventoryEntry,
  SourceInventory,
} from '../inventory/types.js';
import { CLAUDE_SKILLS_DIR } from './installed-projector.js';
import { AGENTS_SKILLS_DIR } from '../scan/scanner.js';
import { skillsFactsFor, VENDOR_FACTS_FETCHED_AT } from '../vendor-facts/index.js';
import { evaluateSkillRules, summariseSkillRules } from '../vendor-facts/skill-rules.js';

/**
 * The day every vendor page behind the tables in this module was read.
 *
 * Separate from `vendor-facts`'s own constant on purpose: that one dates the
 * SKILLS rows, and a partial re-fetch of one kind must not silently re-date the
 * other. Changing a reason below means re-opening the page and moving this.
 */
export const SOURCE_ARTIFACT_FACTS_FETCHED_AT = '2026-09-07';

/** The dated citation every reason in this module carries. */
const CITED = `(vendor docs, ${SOURCE_ARTIFACT_FACTS_FETCHED_AT})`;

/**
 * How one harness treats one kind of authored artifact.
 *
 * Only two answers exist while nothing is projected: the harness reads the
 * canonical file where it already sits (`native`), or it does not and is told
 * where it would have to be instead (`drop`).
 */
interface Placement {
  /** Whether the harness reads the source as it stands. */
  kind: 'native' | 'drop';
  /** The note on a `native`, or the required reason on a `drop`. */
  reason: string;
}

/**
 * Where each harness keeps SUBAGENT definitions.
 *
 * All six have somewhere, which is not what the contract said: its Codex and
 * Gemini cells were marked "(verify)" and both turned out to exist.
 */
const AGENT_PLACEMENTS = {
  'claude-code': {
    kind: 'native',
    reason: `Claude Code reads .claude/agents recursively, keying each definition by its frontmatter name ${CITED}`,
  },
  cursor: {
    kind: 'native',
    reason: `Cursor reads .claude/agents directly; a same-named file in .cursor/agents would take precedence ${CITED}`,
  },
  codex: {
    kind: 'drop',
    reason: `not projected yet — Codex keeps project subagents in .codex/agents/*.toml, one TOML file per agent ${CITED}`,
  },
  opencode: {
    kind: 'drop',
    reason: `not projected yet — OpenCode keeps project subagents in .opencode/agents/*.md ${CITED}`,
  },
  gemini: {
    kind: 'drop',
    reason: `not projected yet — Gemini CLI keeps project subagents in .gemini/agents/*.md ${CITED}`,
  },
  copilot: {
    kind: 'drop',
    reason: `not projected yet — Copilot keeps project subagents in .github/agents, as NAME.agent.md or NAME.md ${CITED}`,
  },
} satisfies Record<HarnessId, Placement>;

/**
 * Where each harness keeps PATH-SCOPED RULES.
 *
 * Three have the same idea under another name; three genuinely have none, and
 * say so on their own pages — their only per-directory mechanism is a nested
 * instructions file, which is a different thing from a glob-scoped rule.
 */
const RULE_PLACEMENTS = {
  'claude-code': {
    kind: 'native',
    reason: `Claude Code reads .claude/rules/*.md and applies each rule to the files its "paths" frontmatter names ${CITED}`,
  },
  cursor: {
    kind: 'drop',
    reason: `not projected yet — Cursor keeps path-scoped rules in .cursor/rules/*.mdc under a "globs" key, and ignores a plain .md there ${CITED}`,
  },
  copilot: {
    kind: 'drop',
    reason: `not projected yet — Copilot keeps path-scoped rules in .github/instructions/*.instructions.md under an "applyTo" key ${CITED}`,
  },
  codex: {
    kind: 'drop',
    reason: `Codex has no path-scoped rules format — its only per-directory mechanism is a nested AGENTS.md ${CITED}`,
  },
  opencode: {
    kind: 'drop',
    reason: `OpenCode has no path-scoped rules format — its only per-directory mechanism is a nested AGENTS.md ${CITED}`,
  },
  gemini: {
    kind: 'drop',
    reason: `Gemini CLI has no path-scoped rules format — its only per-directory mechanism is a nested GEMINI.md ${CITED}`,
  },
} satisfies Record<HarnessId, Placement>;

/**
 * Where each harness keeps MCP SERVER definitions.
 *
 * Copilot is the one cell that is not a single file: its CLI reads this same
 * `.mcp.json`, its VS Code extension reads `.vscode/mcp.json` under a `servers`
 * key, and its cloud agent has no repo file at all. One row would be wrong for
 * two of the three surfaces, so the reason names all three. It stays a drop
 * because DorkOS projects nothing there, and the person still gets the fact.
 */
const MCP_PLACEMENTS = {
  'claude-code': {
    kind: 'native',
    reason: `Claude Code reads .mcp.json at the repository root ${CITED}`,
  },
  codex: {
    kind: 'drop',
    reason: `not projected yet — Codex keeps MCP servers in .codex/config.toml under [mcp_servers.<name>] ${CITED}`,
  },
  opencode: {
    kind: 'drop',
    reason: `not projected yet — OpenCode keeps MCP servers in opencode.json under "mcp" ${CITED}`,
  },
  cursor: {
    kind: 'drop',
    reason: `not projected yet — Cursor keeps MCP servers in .cursor/mcp.json ${CITED}`,
  },
  gemini: {
    kind: 'drop',
    reason: `not projected yet — Gemini CLI keeps MCP servers in .gemini/settings.json under "mcpServers" ${CITED}`,
  },
  copilot: {
    kind: 'drop',
    reason: `not projected yet — where Copilot reads MCP servers depends on the surface: its CLI reads this same .mcp.json, the VS Code extension reads .vscode/mcp.json under "servers", and the cloud agent is configured in repository settings rather than a file ${CITED}`,
  },
} satisfies Record<HarnessId, Placement>;

/**
 * How each harness is told about hooks in `.claude/settings.local.json`.
 *
 * The file is a person's own, gitignored by convention, and Claude Code merges
 * it with `.claude/settings.json`. Nothing is projected out of it — that would
 * publish somebody's private commands to every harness in a shared repo — so the
 * report says where to move a hook that SHOULD travel.
 *
 * @param harness - the harness the line is for.
 * @returns how that harness reads (or does not read) the file.
 */
function localSettingsPlacement(harness: HarnessId): Placement {
  if (harness === 'claude-code') {
    return {
      kind: 'native',
      reason: `Claude Code merges .claude/settings.local.json with .claude/settings.json ${CITED}`,
    };
  }
  return {
    kind: 'drop',
    reason: `hooks in .claude/settings.local.json are yours alone and stay in Claude Code; move them to .claude/settings.json to project them to ${HARNESS_LABELS[harness]}`,
  };
}

/**
 * How each harness is told about hooks a skill declares in its own frontmatter.
 *
 * Claude Code registers them when the skill is invoked and keeps running them
 * for the rest of the session unless the hook sets `once: true`. No other
 * harness has skill-scoped hooks at all, so there is nowhere to put these even
 * in principle — which is why the reason says "no equivalent" rather than naming
 * a file.
 *
 * @param harness - the harness the line is for.
 * @returns how that harness handles skill-frontmatter hooks.
 */
function frontmatterHookPlacement(harness: HarnessId): Placement {
  if (harness === 'claude-code') {
    return {
      kind: 'native',
      reason: `Claude Code registers a skill's frontmatter hooks when the skill is invoked, and keeps running them for the rest of the session ${CITED}`,
    };
  }
  return {
    kind: 'drop',
    reason: `hooks declared in a skill's frontmatter are registered when Claude Code invokes that skill; ${HARNESS_LABELS[harness]} has no equivalent`,
  };
}

/**
 * How one harness reaches one skill kept in `.claude/skills` — the single
 * decision behind every line about that directory.
 *
 * `manifest.claudeOnlySkills` and the rest used to be two code paths, and they
 * disagreed: an unlisted skill was `native` for OpenCode while an IDENTICAL
 * listed one was dropped with "claude-only skill, kept in .claude/skills by
 * manifest.claudeOnlySkills". A manifest entry is a statement of INTENT, not a
 * fact about what OpenCode reads, and the coverage walk discovers the two alike
 * — so that drop was SK-05's shape, on the path that runs on this very
 * repository (DOR-1845 review). One function now, and the listed half only
 * changes the wording.
 *
 * **Every cell of the facts row, not three of them.** The first version asked
 * `readPaths` and `symlinks` and called everything else `native`, so
 * `.claude/skills/My_Skill` holding `name: totally-different` was claimed as
 * loading in OpenCode and Cursor while `harnessCoverage`, reading the same
 * table, refused to decide. `.claude/skills` is exactly where an agent drops a
 * directory under whatever name it liked, so that is not a corner case. The
 * rule ladder is `evaluateSkillRules`, shared with the walk, and the three
 * outcomes map straight onto the three things a plan can say:
 *
 * - the rules are enough and it loads → `native`
 * - a documented rule says the harness skips it → `drop` naming the rule
 * - the vendor documented the rule and not its consequence → a `warning`, which
 *   is the plan making the same refusal the walk makes. Not a `native`, which
 *   would be a guess in the over-claiming direction, and not a `drop`, which
 *   would be one in the other.
 *
 * @param input - the harness, the inventoried skill, and what else is known about it.
 * @returns the one action or the one warning this pairing earns.
 */
function planClaudeSkillsDirSkill(input: {
  harness: HarnessId;
  skill: SkillInventoryEntry;
  /** Whether `manifest.claudeOnlySkills` names it. */
  listed: boolean;
  /** Whether a skill of the same name also lives in the canonical layer. */
  alsoCanonical: boolean;
}): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const { harness, skill, listed, alsoCanonical } = input;
  const label = HARNESS_LABELS[harness];
  const facts = skillsFactsFor(harness);
  const cited = `(vendor docs, ${VENDOR_FACTS_FETCHED_AT})`;
  const base = {
    artifact: 'skill' as const,
    harness,
    provenance: 'authored' as const,
    name: skill.name,
    source: skill.source,
  };
  const action = (
    kind: 'native' | 'drop',
    reason: string
  ): ReturnType<typeof planClaudeSkillsDirSkill> => ({
    actions: [{ ...base, kind, reason }],
    warnings: [],
  });

  // A skill in BOTH roots. `planSkill` already answers for the canonical copy, so
  // a second line telling somebody to "move it to .agents/skills" — where it
  // already is — is advice that contradicts the line above it. One honest
  // sentence about the copy that is actually in the way instead.
  if (alsoCanonical) {
    return action(
      harness === 'claude-code' ? 'native' : 'drop',
      `a second copy of a skill that also lives in ${AGENTS_SKILLS_DIR}; this one sits at the path DorkOS projects the canonical skill to, so it blocks that projection — remove it, or remove the canonical copy`
    );
  }

  if (!facts.readPaths.project.includes(CLAUDE_SKILLS_DIR)) {
    return action(
      'drop',
      listed
        ? `listed in manifest.claudeOnlySkills, and ${label} does not read ${CLAUDE_SKILLS_DIR} either way ${cited} — move it to ${AGENTS_SKILLS_DIR} to share it`
        : `kept in ${CLAUDE_SKILLS_DIR}, which ${label} does not read ${cited} — move it to ${AGENTS_SKILLS_DIR} to share it, or list it in manifest.claudeOnlySkills to say the Claude-only placement is deliberate`
    );
  }

  const outcome = evaluateSkillRules(harness, facts, {
    dirName: skill.name,
    ...(skill.frontmatterName === undefined ? {} : { frontmatterName: skill.frontmatterName }),
    reachedThroughSymlink: skill.isSymlink,
  });

  if (outcome.loads) {
    return action(
      'native',
      listed
        ? `listed in manifest.claudeOnlySkills, but ${label} reads ${CLAUDE_SKILLS_DIR} directly ${cited}, so it loads there too`
        : `${label} reads ${CLAUDE_SKILLS_DIR} directly ${cited}`
    );
  }
  if (outcome.droppedByRule) {
    return action(
      'drop',
      `kept in ${CLAUDE_SKILLS_DIR}, which ${label} reads — but ${outcome.droppedReason ?? 'it refuses this one'} ${cited}; rename it to travel`
    );
  }
  return {
    actions: [],
    warnings: [
      {
        artifact: 'skill',
        harness,
        name: skill.name,
        source: skill.source,
        reason: `kept in ${CLAUDE_SKILLS_DIR}, which ${label} reads — but whether it loads this one is undocumented: ${summariseSkillRules(outcome)}`,
      },
    ],
  };
}

/** Build one action from a placement, so every table entry is turned into a line the same way. */
function actionFrom(
  placement: Placement,
  base: { artifact: ProjectionAction['artifact']; harness: HarnessId; name: string; source: string }
): ProjectionAction {
  return { ...base, provenance: 'authored', kind: placement.kind, reason: placement.reason };
}

/** The distinct sources among hook entries of one origin, in first-seen order. */
function sourcesOf(hooks: readonly HookInventoryEntry[], origin: HookOrigin): Map<string, string> {
  const sources = new Map<string, string>();
  for (const hook of hooks) {
    if (hook.origin !== origin || sources.has(hook.source)) continue;
    sources.set(hook.source, hook.skill ?? 'hooks');
  }
  return sources;
}

/** What {@link planInventoriedArtifacts} needs beyond the inventory itself. */
export interface InventoriedArtifactInput {
  /** The harness this batch of lines is for. */
  harness: HarnessId;
  /** The source inventory to account for. */
  inventory: SourceInventory;
  /**
   * The names `manifest.claudeOnlySkills` carries.
   *
   * It changes the WORDING of a line and nothing else. It used to divert a listed
   * skill to a second code path that dropped it for every harness but Claude
   * Code — a statement of intent overriding a documented fact about what OpenCode
   * reads, which is how two identical directories got opposite answers.
   */
  claudeOnlyNames: ReadonlySet<string>;
  /**
   * The skill names found in `.agents/skills`.
   *
   * Needed for one corner: a skill that is listed Claude-only AND lives in the
   * canonical layer too. `planClaudeOnlySkills` answers for that entry by warning
   * about the canonical directory, so the real directory sitting in
   * `.claude/skills` — the thing actually blocking the projection — is still
   * nobody's line unless this module takes it.
   */
  agentsSkillNames: ReadonlySet<string>;
}

/**
 * Account for every inventoried artifact this module owns, for one harness.
 *
 * Skills in `.agents/skills`, authored commands and `.claude/settings.json`
 * hooks are NOT here: the projector has always had lines for those, and
 * duplicating them would put one artifact in two places in the report. What is
 * here is exactly what was silent.
 *
 * @param input - the harness, the inventory, and the manifest's Claude-only names.
 * @returns one line per artifact — `native` where the harness reads the source as
 *   it stands, `drop` naming where it would have to be otherwise, and a `warning`
 *   for the one case a plan may not decide: a `.claude/skills` skill whose vendor
 *   documented the rule it breaks and not the consequence.
 */
export function planInventoriedArtifacts(input: InventoriedArtifactInput): {
  actions: ProjectionAction[];
  warnings: ProjectionWarning[];
} {
  const { harness, inventory, claudeOnlyNames, agentsSkillNames } = input;
  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];

  for (const rule of inventory.rules) {
    actions.push(
      actionFrom(RULE_PLACEMENTS[harness], {
        artifact: 'rule',
        harness,
        name: rule.name,
        source: rule.source,
      })
    );
  }

  for (const agent of inventory.agents) {
    actions.push(
      actionFrom(AGENT_PLACEMENTS[harness], {
        artifact: 'agent',
        harness,
        name: agent.name,
        source: agent.source,
      })
    );
  }

  for (const server of inventory.mcpServers) {
    actions.push(
      actionFrom(MCP_PLACEMENTS[harness], {
        artifact: 'mcp',
        harness,
        name: server.name,
        source: server.source,
      })
    );
  }

  // One line per SOURCE FILE, not per event: the answer is the same for every
  // event in one file, and six identical lines under one harness heading is
  // noise a person has to read past to find the one thing they can act on.
  for (const [source] of sourcesOf(inventory.hooks, 'claude-settings-local')) {
    actions.push(
      actionFrom(localSettingsPlacement(harness), {
        artifact: 'hook',
        harness,
        name: 'hooks',
        source,
      })
    );
  }
  for (const [source, skill] of sourcesOf(inventory.hooks, 'skill-frontmatter')) {
    actions.push(
      actionFrom(frontmatterHookPlacement(harness), {
        artifact: 'hook',
        harness,
        name: skill,
        source,
      })
    );
  }

  // Every real skill directory in `.claude/skills`, listed by the manifest or
  // not — one path, so the two can never again say different things about two
  // identical directories.
  for (const skill of inventory.skills) {
    if (skill.root !== CLAUDE_SKILLS_DIR) continue;
    const placed = planClaudeSkillsDirSkill({
      harness,
      skill,
      listed: claudeOnlyNames.has(skill.name),
      alsoCanonical: agentsSkillNames.has(skill.name),
    });
    actions.push(...placed.actions);
    warnings.push(...placed.warnings);
  }

  return { actions, warnings };
}

/**
 * The harness an inventory-read failure is attributed to.
 *
 * Same reasoning as `plan/unreadable-hooks.ts`: the loss is harness-agnostic — a
 * `.mcp.json` that will not parse reaches nobody — but every
 * {@link ProjectionWarning} has to name a harness, and claude-code is the honest
 * answer available, since every source the inventory reads is a file Claude Code
 * is the canonical reader of.
 *
 * It is a PLACEHOLDER, so every warning below carries `harnessAgnostic` beside
 * it. Without the flag the placeholder is read as an answer: a project running
 * OpenCode alone was told its unreadable `.mcp.json` was a Claude Code problem,
 * and `--harness opencode` hid the loss entirely — the second half of contract
 * VC-02, arriving through a different emitter.
 */
const UNREADABLE_ATTRIBUTION: HarnessId = 'claude-code';

/**
 * Report every source the inventory could see and could not read.
 *
 * A warning, not a drop, for the reason `unreadable-hooks.ts` gives: a drop says
 * a whole artifact had no home in a target harness, while this is a file the
 * engine could not read at all. Emitted once per source rather than once per
 * enabled harness — the failure happened at read time, ahead of every harness.
 *
 * @param inventory - the inventory whose `unreadable` list to report.
 * @returns one warning per unreadable source, empty when the tree read cleanly.
 */
export function planInventoryWarnings(inventory: SourceInventory): ProjectionWarning[] {
  return inventory.unreadable.map((entry) => ({
    artifact: entry.kind,
    harness: UNREADABLE_ATTRIBUTION,
    harnessAgnostic: true,
    name: entry.source,
    source: entry.source,
    reason: entry.reason,
  }));
}
