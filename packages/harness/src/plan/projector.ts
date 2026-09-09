/**
 * Projector — turn the manifest + scanned artifacts into a {@link ProjectionPlan}.
 *
 * For every enabled harness it decides how each artifact (skills, instructions,
 * hooks, commands) reaches that harness: `native` (the harness reads the
 * canonical source directly), `symlink`, `scaffold`, `generate`, or `drop`.
 * Nothing a harness cannot accept is silently omitted — it lands in `plan.drops`
 * with a reason. Deterministic bytes for `scaffold`/`generate` actions are
 * attached via `setActionContent` so the apply stage can reproduce them.
 *
 * The hooks half lives next door in `plan/hooks-projection.ts`: it is the one
 * artifact kind whose answer varies per harness in three directions at once (the
 * file shape, the events that survive translation, and `manifest.hookPolicies`),
 * and it was most of this module.
 *
 * @module plan/projector
 */
import { join } from 'node:path';
import { HARNESS_LABELS, type HarnessId, type HarnessManifest } from '../manifest/schema.js';
import type {
  ActionBase,
  ClaudeOnlySkillLocation,
  DetectedHarness,
  ProjectionAction,
  ProjectionPlan,
  ProjectionWarning,
} from './types.js';
import { scanSkills, AGENTS_SKILLS_DIR, type SkillEntry } from '../scan/scanner.js';
import type { ClaudeHooksConfig } from '../generate/hooks.js';
import {
  collectHookSources,
  dropSuppressedPluginHookMerge,
  hookPolicyFor,
  planHooks,
} from './hooks-projection.js';
import { planInstruction } from './instructions.js';
import { planGlobalInstallDrops, planGlobalUnreadableHookWarnings } from './global-installs.js';

import { isProjectScoped, type InstalledPlugin } from '../sources/installed.js';
import {
  planInstalledSkills,
  planInstalledCommands,
  planInstalledPluginHooks,
  planOpencodeCommandsGitignore,
  planCanonicalSkillLinks,
  planSkillNameCollisions,
  dropNonPortableLayers,
  dropWholePlugin,
  mergeHookConfigs,
  rewritePluginRootInHooks,
  PROJECTABLE_PLUGIN_TYPES,
  CLAUDE_COMMANDS_DIR,
  CLAUDE_SKILLS_DIR,
} from './installed-projector.js';
import { planUnreadableHookWarnings } from './unreadable-hooks.js';
import { planInventoriedArtifacts, planInventoryWarnings } from './source-artifacts.js';
import { commandDropReason } from './command-formats.js';
import { inventorySourceTree, type SourceInventory } from '../inventory/index.js';

/** The authored slash-command directory Claude Code reads (namespaced by subdirectory). */
const CLAUDE_COMMANDS_SOURCE = CLAUDE_COMMANDS_DIR;

/**
 * The reason every harness but Claude Code takes an authored skill `native`.
 *
 * Claude Code is the ONLY harness that does not read `.agents/skills` — Codex,
 * OpenCode, Cursor, Gemini CLI and Copilot all do, per their own docs fetched
 * 2026-09-07 (`meta/harness-sync-capabilities.md` §1.1). Cursor, Gemini and
 * Copilot used to be told their skills were dropped ("not auto-projected in v1;
 * see DOR-143"), which was true when written and had been wrong for a while
 * (SK-05).
 *
 * @param harness - the harness reading the canonical directory.
 * @returns the note carried on the `native` action.
 */
function readsAgentsSkillsReason(harness: HarnessId): string {
  return `${HARNESS_LABELS[harness]} reads ${AGENTS_SKILLS_DIR} directly (vendor docs, 2026-09-07)`;
}

/**
 * Project a single authored skill (one found in `.agents/skills`) to one harness.
 *
 * Returns `undefined` for the one case with nothing honest to say: a skill the
 * manifest lists in `claudeOnlySkills` that ALSO lives as a real directory in
 * `.claude/skills`. Planning the usual claude-code symlink there would conflict
 * with that directory on every apply, so the plan says nothing and
 * {@link planClaudeOnlySkills} raises a warning naming the contradiction instead.
 */
function planSkill(
  harness: HarnessId,
  skill: SkillEntry,
  manifest: HarnessManifest,
  claudeOnly: ReadonlyMap<string, ClaudeOnlySkillLocation>
): ProjectionAction | undefined {
  const base: ActionBase = {
    artifact: 'skill',
    harness,
    provenance: 'authored',
    name: skill.name,
    source: skill.sourceDir,
  };

  const isClaudeOnly = manifest.claudeOnlySkills.some((c) => c.name === skill.name);
  if (isClaudeOnly) {
    if (harness !== 'claude-code') {
      return { ...base, kind: 'drop', reason: CLAUDE_ONLY_DROP_REASON };
    }
    // Listed Claude-only AND already a real directory at the very path the
    // projection would occupy: the manifest and the canonical layer disagree,
    // and the symlink is a standing conflict on every apply. Warned about, never
    // planned. A symlink there is the engine's own projection and IS planned —
    // withholding it would make the sweep treat a working link as an orphan.
    const location = claudeOnly.get(skill.name);
    if (location?.kind === 'directory' && location.atProjectionTarget) return undefined;
  }

  if (harness === 'claude-code') {
    return { ...base, kind: 'symlink', target: `${CLAUDE_SKILLS_DIR}/${skill.name}` };
  }
  return { ...base, kind: 'native', reason: readsAgentsSkillsReason(harness) };
}

/** The one reason a harness other than Claude Code is told about a Claude-only skill. */
const CLAUDE_ONLY_DROP_REASON =
  'claude-only skill, kept in .claude/skills by manifest.claudeOnlySkills';

/**
 * What is at a redundant entry's declared path, as a clause a warning can carry.
 *
 * The entry is already wrong — the skill is in `.agents/skills` — so this only
 * says WHICH wrong it is, and it has to read the same on a fresh clone as after
 * a sync. `missing` is the fresh-clone shape and `symlink` is the same tree one
 * apply later, so both name the same fault rather than one of them describing
 * the link DorkOS just made.
 *
 * @param location - the resolved entry, never `directory` at the projection target.
 * @returns a lower-case clause, no trailing punctuation.
 */
function describeLocation(location: ClaudeOnlySkillLocation): string {
  if (location.kind === 'symlink') {
    return `${location.path} is a symlink, which is the projection DorkOS makes for it`;
  }
  if (location.kind === 'directory') {
    return `${location.path} is a second copy no harness reads`;
  }
  return `nothing is at ${location.path}`;
}

/**
 * Account for every `manifest.claudeOnlySkills` entry against where the skill
 * actually is.
 *
 * The manifest names skills deliberately kept out of the canonical layer, and it
 * is the ONLY evidence they exist — the scanner walks `.agents/skills` and these
 * are not there. So the entry's own `path` is the claim under test, and
 * {@link ClaudeOnlySkillLocation} (resolved by `engine.ts`) is what it resolved
 * to. Five states, five honest answers:
 *
 * - **a real directory at `.claude/skills/<name>`** — Claude Code reads it where
 *   it sits (`native`), and every other enabled harness is told why it did not
 *   travel. The only state that produces actions.
 * - **a real directory somewhere else** — the skill is real and no harness loads
 *   it: `claudeOnlySkills` is about skills kept where Claude Code reads, and
 *   Claude Code reads `.claude/skills`. Warned, naming the path. Reporting this
 *   as "stale" was a wrong statement about a skill that is right there.
 * - **a symlink** — either the engine's own projection of a canonical skill, in
 *   which case the entry contradicts itself, or a link to a skill kept outside
 *   the repo, in which case `.claude/skills` is not where it lives. Both readings
 *   say the entry is wrong, so both get the same warning. The projection itself
 *   is still planned; withholding it would make the sweep prune a working link.
 * - **also in `.agents/skills`** — the walk already produces this entry's
 *   claude-code projection and its per-harness drops, so nothing is added here.
 *   When a real directory sits at the projection target too, that is the
 *   conflict {@link planSkill} withholds, and it is warned about.
 * - **nothing there at all** — the entry is stale. Warned, so a list nobody
 *   prunes does not quietly become fiction.
 *
 * **The path check is the filesystem's, not a string compare**, so its case
 * behaviour is the filesystem's: an entry whose case does not match its
 * directory resolves on macOS and reads stale on Linux. Match the case.
 *
 * @param input - the manifest, the authored skill names found in `.agents/skills`,
 *   and each entry's resolved location keyed by name.
 * @returns the claude-code `native` actions, the per-harness drops, and the warnings.
 */
function planClaudeOnlySkills(input: {
  manifest: HarnessManifest;
  agentsSkillNames: ReadonlySet<string>;
  claudeOnly: ReadonlyMap<string, ClaudeOnlySkillLocation>;
}): { warnings: ProjectionWarning[] } {
  const { manifest, agentsSkillNames, claudeOnly } = input;
  const warnings: ProjectionWarning[] = [];

  /**
   * One warning about an entry, attributed to the harness the list is named for.
   *
   * The subject is the MANIFEST, not a harness: an entry that is stale, redundant
   * or contradicted is wrong whichever agents this project runs, and the person
   * has to edit the same line either way. So `claude-code` here is a placeholder
   * — `claudeOnlySkills` is a Claude Code concept and no other id would read
   * better — and `harnessAgnostic` says so, which is what gives these their own
   * heading and keeps them past every `--harness` filter. Without the flag a
   * project running Cursor alone was told Claude Code had a problem, and
   * `--harness cursor` hid the stale entry completely (contract VC-02).
   *
   * The `source` is the completeness check's handle on it (P6): for the one entry
   * whose ONLY line is a warning — a skill listed Claude-only that also occupies
   * the projection target, so {@link planSkill} withholds the symlink — a warning
   * that named no path would read as silence about a skill that is right there.
   */
  const warn = (name: string, source: string, reason: string): void => {
    warnings.push({
      artifact: 'skill',
      harness: 'claude-code',
      harnessAgnostic: true,
      name,
      source,
      reason,
    });
  };

  for (const entry of manifest.claudeOnlySkills) {
    const location = claudeOnly.get(entry.name) ?? {
      path: `${CLAUDE_SKILLS_DIR}/${entry.name}`,
      kind: 'missing' as const,
      atProjectionTarget: true,
    };
    const inAgents = agentsSkillNames.has(entry.name);

    // The skill is in the canonical layer, so the entry is wrong however its
    // path resolves — and it must say so on the FIRST pass, before an apply has
    // created anything. Keyed on `kind` because the reading changes with it, but
    // never on whether a projection happens to exist yet: an entry that is
    // silent on a fresh clone and speaks up after the first sync is describing
    // DorkOS's own output rather than the manifest.
    if (inAgents) {
      if (location.kind === 'directory' && location.atProjectionTarget) {
        // The one case with a consequence beyond the warning: a real directory
        // at the projection target, so {@link planSkill} withholds the symlink
        // rather than conflicting with it on every apply.
        warn(
          entry.name,
          `${AGENTS_SKILLS_DIR}/${entry.name}`,
          `claudeOnlySkills names a skill that also lives in ${AGENTS_SKILLS_DIR} — move it or drop the entry`
        );
      } else {
        warn(
          entry.name,
          `${AGENTS_SKILLS_DIR}/${entry.name}`,
          `claudeOnlySkills names a skill that also lives in ${AGENTS_SKILLS_DIR}; ${describeLocation(location)}. The entry is redundant — drop it`
        );
      }
      continue;
    }

    if (location.kind === 'symlink') {
      warn(
        entry.name,
        location.path,
        `claudeOnlySkills names "${entry.name}", but ${location.path} is a symlink — a projection of ${AGENTS_SKILLS_DIR}, or a link to a skill kept elsewhere. Either way it is not a skill kept in ${CLAUDE_SKILLS_DIR}: drop the entry`
      );
      continue;
    }

    if (location.kind === 'missing') {
      warn(
        entry.name,
        location.path,
        `claudeOnlySkills entry is stale: no skill at ${location.path}, and none named "${entry.name}" in ${AGENTS_SKILLS_DIR}`
      );
      continue;
    }

    if (!location.atProjectionTarget) {
      warn(
        entry.name,
        location.path,
        `claudeOnlySkills names a real skill at ${location.path}, which no harness reads — Claude Code loads skills from ${CLAUDE_SKILLS_DIR}, so move it to ${CLAUDE_SKILLS_DIR}/${entry.name} or drop the entry`
      );
      continue;
    }

    // A real directory at `.claude/skills/<name>` needs no line from here: the
    // inventory walks that directory, so `planInventoriedArtifacts` already
    // accounts for it, from the vendor facts, for every enabled harness. This
    // branch used to emit its own — `native` for Claude Code and a flat drop for
    // everyone else — which contradicted the other path about two identical
    // directories and told OpenCode users their skill was dropped from a
    // directory OpenCode reads (DOR-1845 review).
  }

  return { warnings };
}

/**
 * Project authored slash commands (`.claude/commands/**`) to one harness.
 *
 * Returns `undefined` for EVERY harness when the repository has no
 * `.claude/commands` holding a command. There is no artifact, so there is
 * nothing to call `native` and nothing to drop — a repo that has never written a
 * slash command should not be told, five times over, that its commands did not
 * travel. The engine asserted Claude Code's `native` unconditionally until
 * 2026-09-07, source path and all, and went on naming the other five long after
 * that was fixed.
 *
 * Once commands DO exist, every harness but Claude Code drops, and each drop
 * names that harness's OWN repo-local command format (see
 * `plan/command-formats.ts`) rather than claiming none exists — four of the five
 * have one.
 */
function planCommands(
  harness: HarnessId,
  claudeCommandsExist: boolean
): ProjectionAction | undefined {
  if (!claudeCommandsExist) return undefined;

  const base: ActionBase = {
    artifact: 'command',
    harness,
    provenance: 'authored',
    name: 'commands',
    source: CLAUDE_COMMANDS_SOURCE,
  };
  if (harness === 'claude-code') {
    return { ...base, kind: 'native' };
  }
  if (harness === 'opencode') {
    // OpenCode has a flat `.opencode/commands` format, but authored `.claude/commands`
    // are Claude-namespaced slash commands; only installed-plugin commands are
    // projected to `.opencode/commands` (as wrappers) in v1.
    return {
      ...base,
      kind: 'drop',
      reason:
        'authored .claude/commands are Claude-namespaced; only installed-plugin commands project to .opencode/commands in v1',
    };
  }
  return { ...base, kind: 'drop', reason: commandDropReason(harness) };
}

/**
 * Build the full projection plan for a repository.
 *
 * Authored artifacts (`.agents/`, `.claude/settings.json`, `AGENTS.md`) are
 * projected per the manifest. Marketplace-installed plugins are projected as
 * harness-native files so the external CLI and DorkOS sessions see the same thing
 * (ADR 260706-192819): a project-scoped plugin's skills + tasks symlink into each
 * harness's skill dir (namespaced `<pkg>__<name>`); its commands become generated
 * repo-local wrappers under `.claude/commands/<pkg>/` (claude-code) or drop
 * (other harnesses); its hooks merge into `.claude/settings.local.json`
 * (claude-code) and fold into the generated Codex hooks file; its non-portable
 * layers drop with reasons. Global-scoped installs and non-plugin package types
 * are dropped (reported, never projected by a project sync).
 *
 * One projection ignores the harness list: every installed plugin skill is linked
 * into `.agents/skills` regardless of which harnesses are enabled, because that
 * is the one directory Codex, OpenCode, Cursor, Gemini CLI and Copilot all read,
 * and the only project skills root the DorkOS scheduler watches (DOR-1518,
 * DOR-1847; see {@link planCanonicalSkillLinks}).
 *
 * `input.allowPluginHooks` is the one lever over WHICH installed packages get to
 * contribute hooks. It gates hooks and nothing else: a package it excludes still
 * projects its skills and commands, it simply contributes no shell commands to any
 * harness. Omitting it projects every package's hooks, which is what a person
 * running `dorkos harness sync` in their own terminal asks for. See
 * {@link projectedHookCommands} for the list a caller needs to decide.
 *
 * Three inputs describe files whose EXISTENCE decides whether a projection may
 * be called `native`: `agentsMdExists`, `claudeCommandsExist`, and the hooks in
 * `claudeHooks`. A fourth, `claudeOnlySkills`, resolves where each manifest
 * exception really is. `buildPlan` stays filesystem-free, so `engine.ts` reads
 * all of them off disk (`project()` always passes them). They default to
 * "absent", which is the honest reading for a caller that does not say — a plan
 * may never claim a harness reads a file nobody has confirmed is there (P9a).
 *
 * @param input - the repo root, validated manifest, optional Claude hooks,
 *   whether a canonical `AGENTS.md` exists, whether `.claude/commands` holds a
 *   command, where each `claudeOnlySkills` entry resolves to, any installed
 *   plugins, and an optional per-package gate on hook contribution.
 * @returns the actionable projections, the honest drop list, and any warnings —
 *   about a projection that landed but may not work in the target harness, or a
 *   source declaration the engine could not read at all.
 */
export function buildPlan(input: {
  repoRoot: string;
  manifest: HarnessManifest;
  claudeHooks?: ClaudeHooksConfig;
  agentsMdExists: boolean;
  /** Whether `.claude/commands` exists and holds at least one `.md`. Defaults to `false`. */
  claudeCommandsExist?: boolean;
  /**
   * Where each `manifest.claudeOnlySkills` entry's declared `path` resolves to,
   * keyed by the entry's name. Defaults to empty, which reads every entry as
   * stale — the honest answer for a caller that has not looked.
   *
   * These skills are deliberately absent from `.agents/skills`, so the scanner
   * never sees them and the manifest is the only evidence they exist. See
   * {@link ClaudeOnlySkillLocation} and `engine.ts`'s `scanClaudeOnlySkills`.
   */
  claudeOnlySkills?: ReadonlyMap<string, ClaudeOnlySkillLocation>;
  installedPlugins?: InstalledPlugin[];
  allowPluginHooks?: (packageName: string) => boolean;
  /**
   * Everything the repository's source tree holds, by kind — the answer to
   * "what is in here at all?", as opposed to "what can the engine project?".
   *
   * It is what makes the drop list honest about the kinds the engine does not
   * project: subagent definitions, path-scoped rules, MCP servers, and the two
   * hook sources `loadClaudeHooks` never reads. Defaults to scanning `repoRoot`,
   * exactly as the skill scan below already does, so an existing caller keeps
   * working and gets the new lines; `project()` passes one so the tree is walked
   * once.
   */
  inventory?: SourceInventory;
  /**
   * Every harness whose own files are on disk in this repo, from
   * `detectHarnessFootprints`. The ones the manifest does not enable become
   * {@link ProjectionPlan.notEnabled}.
   *
   * Passed in rather than probed, like `agentsMdExists` and the other
   * filesystem answers: `buildPlan` stays filesystem-free. Omitted, no harness
   * is reported as present — the honest answer for a caller that has not looked.
   */
  detectedHarnesses?: readonly DetectedHarness[];
  /**
   * The harness DorkOS's own default runtime reads. When the manifest does not
   * enable it, it joins {@link ProjectionPlan.notEnabled} as a `dorkos-runtime`
   * entry — the notice for a repo that has left no footprint for that harness
   * because it has never run it (DOR-1901).
   *
   * Injected rather than read, like every other answer `buildPlan` is handed:
   * `runtimes.default` is a `~/.dork/config.json` key and this engine reads no
   * config. Omitted, no such entry is produced, which is the honest answer for a
   * caller that has not looked.
   */
  dorkosHarness?: HarnessId;
}): ProjectionPlan {
  const {
    repoRoot,
    manifest,
    claudeHooks,
    agentsMdExists,
    claudeCommandsExist = false,
    claudeOnlySkills = new Map<string, ClaudeOnlySkillLocation>(),
    installedPlugins = [],
    inventory = inventorySourceTree(repoRoot),
    detectedHarnesses = [],
    dorkosHarness,
  } = input;
  const skills = scanSkills(repoRoot);
  const warnings: ProjectionWarning[] = [];
  const claudeOnlyNames = new Set(manifest.claudeOnlySkills.map((entry) => entry.name));
  const agentsSkillNames = new Set(skills.map((skill) => skill.name));

  // Say what the tree holds and could not be read — a `.mcp.json` that will not
  // parse, a file where `.claude/agents` should be a directory. Once per source,
  // ahead of every harness, for the reason `planUnreadableHookWarnings` gives.
  warnings.push(...planInventoryWarnings(inventory));

  // Partition installed plugins: only project-scoped, projectable-type plugins
  // contribute assets; global installs and other types are reported as drops.
  // `isProjectScoped` is a type predicate, so everything downstream of this line
  // carries a repo-relative install directory the compiler can see.
  const projectScoped = installedPlugins.filter(isProjectScoped);
  const projectable = projectScoped.filter((p) => PROJECTABLE_PLUGIN_TYPES.has(p.type));
  const unsupportedType = projectScoped.filter((p) => !PROJECTABLE_PLUGIN_TYPES.has(p.type));

  // Which packages may contribute shell commands. Applied HERE, before the hooks
  // are folded in, because a package's hooks reach every enabled harness — the
  // generated `.codex/hooks.json` and friends below, as well as the Claude Code
  // settings merge further down. Filtering either target alone would leave the
  // other one writing the same commands (DOR-522).
  const hookContributors = input.allowPluginHooks
    ? projectable.filter((p) => input.allowPluginHooks?.(p.name))
    : projectable;

  // Fold installed-plugin hooks into the authored hooks so Codex gets one merged
  // hooks file (it reads a single `.codex/hooks.json`). An installed plugin's
  // install root is known at plan time, so its `${CLAUDE_PLUGIN_ROOT}` is rewritten
  // to the absolute path FIRST — the generated Codex/Cursor/Copilot hook files then
  // carry the resolved path and actually work there, leaving only authored hooks
  // (unknown root) or other unresolved `${CLAUDE_*}` tokens to earn a warning.
  const mergedHooks = mergeHookConfigs([
    claudeHooks,
    ...hookContributors.map((p) =>
      rewritePluginRootInHooks(p.hooks, join(repoRoot, p.location.relDir))
    ),
  ]);

  // Say what the hooks salvage threw away. The scanner keeps whatever a malformed
  // `hooks/hooks.json` still states clearly and discards the rest (DOR-646); this
  // is the only place the discarded part is ever reported, because the
  // pre-install preview that discloses the same file runs before the install and
  // cannot see a file that rots afterwards (DOR-1724). Emitted once, not per
  // harness: the loss happened at read time, ahead of every harness.
  //
  // Over `projectable`, NOT `hookContributors`: the loss is a fact about the
  // file, and it is true whether or not the package's hooks were allowed to
  // contribute. Reporting only the allowed ones meant a person decided whether
  // to trust a package from a list of commands that silently omitted the ones
  // the reader could not parse, and heard about the omission only after saying
  // yes (DOR-1849).
  warnings.push(...planUnreadableHookWarnings(projectable));

  // The same promise for the packages installed for every project: the scan
  // reads their hooks file too, so a rotted one is said out loud rather than
  // read and thrown away. Emitted here, beside its project-scope twin, because
  // both losses happened at read time, ahead of every harness.
  warnings.push(...planGlobalUnreadableHookWarnings(installedPlugins));

  // Which file each merged hook came from, so no line about hooks names a
  // `.claude/settings.json` the repository does not have.
  const hookSources = collectHookSources(claudeHooks, hookContributors);

  const all: ProjectionAction[] = [];
  for (const harness of manifest.harnesses) {
    for (const skill of skills) {
      const skillAction = planSkill(harness, skill, manifest, claudeOnlySkills);
      if (skillAction) all.push(skillAction);
    }
    all.push(planInstruction(harness, agentsMdExists));
    const hookResult = planHooks(
      harness,
      hookSources,
      hookPolicyFor(manifest, harness),
      mergedHooks,
      claudeHooks
    );
    all.push(...hookResult.actions);
    warnings.push(...hookResult.warnings);
    const commandAction = planCommands(harness, claudeCommandsExist);
    if (commandAction) all.push(commandAction);
    // Everything the engine can now SEE but does not project: rules, subagents,
    // MCP servers, a person's own `settings.local.json` hooks, and the hooks a
    // skill declares in its frontmatter. Each one is a native where the harness
    // really reads the source, and a drop naming where it would have to be
    // otherwise — never nothing (DOR-1845).
    const inventoried = planInventoriedArtifacts({
      harness,
      inventory,
      claudeOnlyNames,
      agentsSkillNames,
    });
    all.push(...inventoried.actions);
    warnings.push(...inventoried.warnings);
    for (const plugin of projectable) {
      const skillResult = planInstalledSkills(harness, plugin);
      all.push(...skillResult.actions);
      warnings.push(...skillResult.warnings);
      all.push(...planInstalledCommands(harness, plugin, repoRoot));
    }
  }

  // Installed-plugin hooks reach claude-code by merging into the user-owned
  // `.claude/settings.local.json` (one action for all plugins). Codex already
  // gets them folded into its generated hooks file above.
  //
  // This merge is the ONE thing the engine writes at Claude Code, so it is what
  // a `hookPolicies` entry of `none` for claude-code switches off — the `native`
  // reading of `.claude/settings.json` above is Claude Code's own and no
  // manifest's to revoke. Each package that would have contributed is dropped by
  // name, so nothing goes quiet.
  if (manifest.harnesses.includes('claude-code')) {
    const hooksMerge = planInstalledPluginHooks(hookContributors, repoRoot);
    if (hooksMerge) {
      if (hookPolicyFor(manifest, 'claude-code') === 'none') {
        all.push(...dropSuppressedPluginHookMerge(hookContributors));
      } else {
        all.push(hooksMerge);
      }
    }
  }

  // OpenCode command wrappers share one flat dir, so their gitignore is a single
  // aggregated action (naming every engine wrapper explicitly) rather than one
  // per plugin.
  if (manifest.harnesses.includes('opencode')) {
    const ocGitignore = planOpencodeCommandsGitignore(projectable);
    if (ocGitignore) all.push(ocGitignore);
  }

  // Every installed plugin skill reaches `.agents/skills` whatever harnesses are
  // enabled: it is the one directory five of the six read, and the only project
  // skills root the DorkOS scheduler watches (DOR-1518, DOR-1847). Stands down
  // when an enabled harness already links installed skills there, so the target
  // is planned exactly once.
  const canonicalLinks = planCanonicalSkillLinks({
    plugins: projectable,
    harnesses: manifest.harnesses,
  });
  all.push(...canonicalLinks.actions);
  warnings.push(...canonicalLinks.warnings);

  // Account for every `manifest.claudeOnlySkills` entry, including the ones the
  // `.agents/skills` walk above never sees because they live only in
  // `.claude/skills` (SK-04).
  const claudeOnly = planClaudeOnlySkills({
    manifest,
    agentsSkillNames,
    claudeOnly: claudeOnlySkills,
  });
  warnings.push(...claudeOnly.warnings);

  // Skill-name collisions (frontmatter-keyed harnesses): warn once per colliding
  // installed skill per affected enabled harness.
  warnings.push(
    ...planSkillNameCollisions({
      authoredSkillNames: [...agentsSkillNames],
      plugins: projectable,
      harnesses: manifest.harnesses,
    })
  );

  // Harness-agnostic installed-plugin drops (emitted once, not per harness).
  for (const plugin of projectable) all.push(...dropNonPortableLayers(plugin));
  for (const plugin of unsupportedType) {
    all.push(
      dropWholePlugin(plugin, `package type "${plugin.type}" is not a harness-portable plugin`)
    );
  }
  // One drop per package installed for all projects, each followed by the
  // SRC-12 notice when the same name is also installed here. The notice resolves
  // nothing, because a DorkOS-side precedence would be unenforceable — the
  // projection is a symlink in a directory the agent tool reads on its own
  // terms. `repoRoot` reaches it because its uninstall command names this
  // repository by absolute path; a `.` would be resolved by the SERVER, against
  // a working directory that is not the reader's.
  all.push(...planGlobalInstallDrops({ plugins: installedPlugins, repoRoot }));

  return {
    actions: all.filter((a) => a.kind !== 'drop'),
    drops: all.filter((a) => a.kind === 'drop'),
    warnings,
    notEnabled: notEnabledHarnesses(manifest.harnesses, detectedHarnesses, dorkosHarness),
  };
}

/**
 * Every harness this manifest does not enable that something says it should,
 * footprints first.
 *
 * The DorkOS entry is added only when no footprint already names that harness,
 * so a repo that has both a `.claude/` and DorkOS running Claude Code is one
 * line rather than two — and the line it gets is the one with a path in it,
 * because a path is the more actionable of the two answers.
 *
 * @param enabled - the manifest's own harness set.
 * @param detected - harnesses whose own files are in the repo.
 * @param dorkosHarness - the harness DorkOS's default runtime reads, if known.
 * @returns one entry per harness to report, in the order the report prints them.
 */
function notEnabledHarnesses(
  enabled: readonly HarnessId[],
  detected: readonly DetectedHarness[],
  dorkosHarness: HarnessId | undefined
): DetectedHarness[] {
  const missing = detected.filter((d) => !enabled.includes(d.harness));
  if (dorkosHarness === undefined || enabled.includes(dorkosHarness)) return missing;
  if (missing.some((d) => d.harness === dorkosHarness)) return missing;
  return [...missing, { harness: dorkosHarness, why: 'dorkos-runtime' }];
}
