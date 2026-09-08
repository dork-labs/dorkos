/**
 * Projector — turn the manifest + scanned artifacts into a {@link ProjectionPlan}.
 *
 * For every enabled harness it decides how each artifact (skills, instructions,
 * hooks, commands) reaches that harness: `native` (the harness reads the
 * canonical source directly), `symlink`, `scaffold`, `generate`, or `drop`.
 * Nothing a harness cannot accept is silently omitted — it lands in `plan.drops`
 * with a reason. Deterministic bytes for `scaffold`/`generate` actions are
 * attached via {@link setActionContent} so the apply stage can reproduce them.
 *
 * @module plan/projector
 */
import { join } from 'node:path';
import { HARNESS_LABELS, type HarnessId, type HarnessManifest } from '../manifest/schema.js';
import type { ActionBase, ProjectionAction, ProjectionPlan, ProjectionWarning } from './types.js';
import { setActionContent } from './content-map.js';
import { scanSkills, AGENTS_SKILLS_DIR, type SkillEntry } from '../scan/scanner.js';
import {
  generateCodexHooks,
  generateCursorHooks,
  generateCopilotHooks,
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
  type ClaudeHooksConfig,
  type HookWarning,
  type DroppedHook,
} from '../generate/hooks.js';
import { planInstruction } from './instructions.js';

import type { InstalledPlugin } from '../sources/installed.js';
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
import { commandDropReason } from './command-formats.js';
/** The one authored hooks file the engine reads — Claude Code's own project settings. */
const CLAUDE_SETTINGS_SOURCE = '.claude/settings.json';

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
  claudeSkillDirs: ReadonlySet<string>
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
    // Listed Claude-only AND already a real directory where Claude reads: the
    // manifest and the canonical layer disagree, and a symlink over that
    // directory is a standing conflict. Warned about, never planned.
    if (claudeSkillDirs.has(skill.name)) return undefined;
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
 * Account for every `manifest.claudeOnlySkills` entry against where the skill
 * actually lives.
 *
 * The manifest names skills deliberately kept out of the canonical layer. The
 * projector used to consult the list only while walking `.agents/skills`, so an
 * entry that lives solely in `.claude/skills` — all 13 in this repository —
 * produced no line at all: not an action, not a drop, nothing (SK-04, reproduced
 * 2026-09-07). Three states, three honest answers:
 *
 * - **only in `.claude/skills`** — Claude Code reads it where it sits (`native`),
 *   and every other enabled harness is told why it did not travel.
 * - **in both roots** — the manifest contradicts the canonical layer. Warned,
 *   with no claude-code symlink planned (see {@link planSkill}); the per-harness
 *   drops for the other harnesses still come from there.
 * - **in neither** — the entry is stale. Warned, so a list nobody prunes does not
 *   quietly become fiction.
 *
 * @param input - the manifest, the authored skill names found in `.agents/skills`,
 *   and the real directory names found in `.claude/skills`.
 * @returns the claude-code `native` actions, the per-harness drops, and the warnings.
 */
function planClaudeOnlySkills(input: {
  manifest: HarnessManifest;
  agentsSkillNames: ReadonlySet<string>;
  claudeSkillDirs: ReadonlySet<string>;
}): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const { manifest, agentsSkillNames, claudeSkillDirs } = input;
  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];

  for (const entry of manifest.claudeOnlySkills) {
    const inAgents = agentsSkillNames.has(entry.name);
    const inClaude = claudeSkillDirs.has(entry.name);

    if (inAgents && inClaude) {
      warnings.push({
        artifact: 'skill',
        harness: 'claude-code',
        name: entry.name,
        reason:
          'claudeOnlySkills names a skill that also lives in .agents/skills — move it or drop the entry',
      });
      continue;
    }
    // Already covered by the `.agents/skills` walk: it produces the claude-code
    // symlink and the per-harness drops for this entry.
    if (inAgents) continue;

    if (!inClaude) {
      warnings.push({
        artifact: 'skill',
        harness: 'claude-code',
        name: entry.name,
        reason: `claudeOnlySkills entry is stale: no skill named "${entry.name}" in ${CLAUDE_SKILLS_DIR} or ${AGENTS_SKILLS_DIR}`,
      });
      continue;
    }

    const source = `${CLAUDE_SKILLS_DIR}/${entry.name}`;
    for (const harness of manifest.harnesses) {
      actions.push(
        harness === 'claude-code'
          ? {
              artifact: 'skill',
              harness,
              provenance: 'authored',
              name: entry.name,
              source,
              kind: 'native',
              reason: `Claude Code reads ${CLAUDE_SKILLS_DIR} directly`,
            }
          : {
              artifact: 'skill',
              harness,
              provenance: 'authored',
              name: entry.name,
              source,
              kind: 'drop',
              reason: CLAUDE_ONLY_DROP_REASON,
            }
      );
    }
  }

  return { actions, warnings };
}

/**
 * The static per-harness recipe for a standalone hooks file the engine
 * generates: where it goes and how to build its content.
 */
interface StandaloneHookSpec {
  /** The repo-relative target path for this harness's generated hooks file. */
  target: string;
  /**
   * Translate the merged Claude hooks into this harness's on-disk content.
   *
   * @returns the deterministic file content (or `undefined` when the harness has
   *   zero mappable events, so the file is not written and any stale one is
   *   pruned by the apply stage), plus the dropped events and warnings.
   */
  generate: (claudeHooks: ClaudeHooksConfig) => {
    content: string | undefined;
    dropped: DroppedHook[];
    warnings: HookWarning[];
  };
}

/**
 * Every harness with its own standalone hooks file. Each entry runs its
 * `generate` function over the merged Claude hooks, serializes the result to the
 * `target` path, and emits its unmapped events as drops. Every one of the three
 * writes a WRAPPED file, not a bare event map: Codex nests the event map under
 * `{ description, hooks }`, Cursor and Copilot under `{ version, hooks }`. So
 * each entry owns its own `generate`, returning already-serializable content
 * plus the dropped/warning lists.
 *
 * The engine does not own these paths by path alone — Codex's and Cursor's own
 * docs tell people to write them by hand. Ownership is decided at apply time by
 * a `.dorkos-generated` sidecar (`apply/generated-ownership.ts`).
 *
 * Gemini is intentionally NOT here: its hooks live inside the SHARED
 * `.gemini/settings.json`, which holds unrelated user settings, so it is handled
 * as an honest drop rather than a standalone generated file (see
 * {@link planHooks}).
 */
const STANDALONE_HOOK_HARNESSES: Partial<Record<HarnessId, StandaloneHookSpec>> = {
  codex: {
    target: CODEX_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCodexHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
  cursor: {
    target: CURSOR_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCursorHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
  copilot: {
    target: COPILOT_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { file, dropped, warnings } = generateCopilotHooks(claudeHooks);
      const content =
        Object.keys(file.hooks).length > 0 ? JSON.stringify(file, null, 2) + '\n' : undefined;
      return { content, dropped, warnings };
    },
  },
};

/**
 * Project hooks to one harness (may yield several actions + warnings).
 *
 * `claudeHooks` is the MERGED config — the repo's own hooks plus every installed
 * package's — because that is what the other harnesses' generated files carry.
 * `authoredHooks` is the repo's own half alone, and it is what decides Claude
 * Code's `native`: Claude reads `.claude/settings.json`, and a package's hooks
 * reach it through the separate `.claude/settings.local.json` merge, never that
 * file. With no authored hooks there is no artifact at all, so Claude Code gets
 * NO action — not a `native` for a file that may not exist, and not a `drop`
 * either, which would claim something exists that could not travel.
 */
function planHooks(
  harness: HarnessId,
  claudeHooks?: ClaudeHooksConfig,
  authoredHooks?: ClaudeHooksConfig
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const base: ActionBase = { artifact: 'hook', harness, provenance: 'authored', name: 'hooks' };
  if (harness === 'claude-code') {
    const hasAuthoredHooks = authoredHooks !== undefined && Object.keys(authoredHooks).length > 0;
    return {
      actions: hasAuthoredHooks
        ? [{ ...base, kind: 'native', source: CLAUDE_SETTINGS_SOURCE }]
        : [],
      warnings: [],
    };
  }

  const standalone = STANDALONE_HOOK_HARNESSES[harness];
  if (standalone) return planStandaloneHooks(harness, standalone, claudeHooks);

  if (harness === 'opencode') {
    // OpenCode has NO declarative hook config — only a code-based TypeScript
    // plugin API — so there is no on-disk hook file to project into. Honest drop.
    return {
      actions: [
        {
          ...base,
          kind: 'drop',
          reason:
            'OpenCode has no declarative hook config (only a code-based TypeScript plugin API), so hooks cannot be projected as files',
        },
      ],
      warnings: [],
    };
  }

  // Gemini: hooks live inside the shared `.gemini/settings.json`, which also
  // holds unrelated user settings. Projecting them safely means MERGING into
  // that file (and pruning only the engine-managed entries), which the current
  // apply stage does not yet support, so it is an honest drop, not a clobber.
  return {
    actions: [
      {
        ...base,
        kind: 'drop',
        reason:
          'Gemini hooks require a safe merge into the shared .gemini/settings.json (preserving other keys); tracked as follow-up (DOR-143)',
      },
    ],
    warnings: [],
  };
}

/**
 * Generate one harness's standalone hooks file from the Claude hooks config:
 * drop unmappable events, and warn (without dropping) when a projected hook
 * command carries a Claude-only substitution token the target harness cannot
 * resolve.
 *
 * Emits NO generate action when the merged config produces zero mappable hooks
 * for the target. The apply stage then prunes a file it can prove it wrote at
 * that path, and reports anything else there as a conflict rather than deleting
 * somebody's own hooks.
 */
function planStandaloneHooks(
  harness: HarnessId,
  spec: StandaloneHookSpec,
  claudeHooks?: ClaudeHooksConfig
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  if (!claudeHooks) return { actions: [], warnings: [] };

  const { content, dropped, warnings } = spec.generate(claudeHooks);
  const actions: ProjectionAction[] = [];

  if (content !== undefined) {
    const action: ProjectionAction = {
      artifact: 'hook',
      harness,
      provenance: 'authored',
      name: 'hooks',
      kind: 'generate',
      source: CLAUDE_SETTINGS_SOURCE,
      target: spec.target,
    };
    setActionContent(action, content);
    actions.push(action);
  }

  for (const d of dropped) {
    actions.push({
      artifact: 'hook',
      harness,
      provenance: 'authored',
      name: d.event,
      kind: 'drop',
      reason: d.reason,
    });
  }

  return {
    actions,
    warnings: warnings.map((w) => ({
      artifact: 'hook' as const,
      harness,
      name: w.event,
      reason: w.reason,
    })),
  };
}

/**
 * Project authored slash commands (`.claude/commands/**`) to one harness.
 *
 * Returns `undefined` for Claude Code when the repository has no
 * `.claude/commands` holding a command: there is nothing to read, so there is
 * nothing to call `native`. The engine asserted that `native` unconditionally
 * until 2026-09-07, source path and all.
 *
 * Every other harness drops, and each drop names that harness's OWN repo-local
 * command format (see `plan/command-formats.ts`) rather than claiming none
 * exists — four of the five have one.
 */
function planCommands(
  harness: HarnessId,
  claudeCommandsExist: boolean
): ProjectionAction | undefined {
  const base: ActionBase = {
    artifact: 'command',
    harness,
    provenance: 'authored',
    name: 'commands',
  };
  if (harness === 'claude-code') {
    if (!claudeCommandsExist) return undefined;
    return { ...base, kind: 'native', source: CLAUDE_COMMANDS_SOURCE };
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
 * `claudeHooks`. `buildPlan` stays filesystem-free, so `engine.ts` reads all
 * three off disk (`project()` always passes them). They default to "absent",
 * which is the honest reading for a caller that does not say — a plan may never
 * claim a harness reads a file nobody has confirmed is there (P9a).
 *
 * @param input - the repo root, validated manifest, optional Claude hooks,
 *   whether a canonical `AGENTS.md` exists, whether `.claude/commands` holds a
 *   command, the real skill directories in `.claude/skills`, any installed
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
   * Names of REAL skill directories under `.claude/skills` (never the engine's
   * own projection symlinks). Defaults to none. Read by the
   * `manifest.claudeOnlySkills` accounting, which cannot otherwise tell a
   * Claude-only skill kept there from a stale manifest entry.
   */
  claudeSkillDirs?: readonly string[];
  installedPlugins?: InstalledPlugin[];
  allowPluginHooks?: (packageName: string) => boolean;
}): ProjectionPlan {
  const {
    repoRoot,
    manifest,
    claudeHooks,
    agentsMdExists,
    claudeCommandsExist = false,
    claudeSkillDirs = [],
    installedPlugins = [],
  } = input;
  const skills = scanSkills(repoRoot);
  const claudeSkillDirSet = new Set(claudeSkillDirs);
  const warnings: ProjectionWarning[] = [];

  // Partition installed plugins: only project-scoped, projectable-type plugins
  // contribute assets; global installs and other types are reported as drops.
  const projectable = installedPlugins.filter(
    (p) => p.scope === 'project' && PROJECTABLE_PLUGIN_TYPES.has(p.type)
  );
  const unsupportedType = installedPlugins.filter(
    (p) => p.scope === 'project' && !PROJECTABLE_PLUGIN_TYPES.has(p.type)
  );
  const globalInstalls = installedPlugins.filter((p) => p.scope === 'global');

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
      p.relDir ? rewritePluginRootInHooks(p.hooks, join(repoRoot, p.relDir)) : p.hooks
    ),
  ]);

  // Say what the hooks salvage threw away. The scanner keeps whatever a malformed
  // `hooks/hooks.json` still states clearly and discards the rest (DOR-646); this
  // is the only place the discarded part is ever reported, because the
  // pre-install preview that discloses the same file runs before the install and
  // cannot see a file that rots afterwards (DOR-1724). Emitted once, not per
  // harness: the loss happened at read time, ahead of every harness.
  warnings.push(...planUnreadableHookWarnings(hookContributors));

  const all: ProjectionAction[] = [];
  for (const harness of manifest.harnesses) {
    for (const skill of skills) {
      const skillAction = planSkill(harness, skill, manifest, claudeSkillDirSet);
      if (skillAction) all.push(skillAction);
    }
    all.push(planInstruction(harness, agentsMdExists));
    const hookResult = planHooks(harness, mergedHooks, claudeHooks);
    all.push(...hookResult.actions);
    warnings.push(...hookResult.warnings);
    const commandAction = planCommands(harness, claudeCommandsExist);
    if (commandAction) all.push(commandAction);
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
  if (manifest.harnesses.includes('claude-code')) {
    const hooksMerge = planInstalledPluginHooks(hookContributors, repoRoot);
    if (hooksMerge) all.push(hooksMerge);
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
    agentsSkillNames: new Set(skills.map((s) => s.name)),
    claudeSkillDirs: claudeSkillDirSet,
  });
  all.push(...claudeOnly.actions);
  warnings.push(...claudeOnly.warnings);

  // Skill-name collisions (frontmatter-keyed harnesses): warn once per colliding
  // installed skill per affected enabled harness.
  warnings.push(
    ...planSkillNameCollisions({
      authoredSkillNames: skills.map((s) => s.name),
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
  for (const plugin of globalInstalls) {
    all.push(
      dropWholePlugin(
        plugin,
        'global-scope install; a project sync does not project global plugins (run a global sync)'
      )
    );
  }

  return {
    actions: all.filter((a) => a.kind !== 'drop'),
    drops: all.filter((a) => a.kind === 'drop'),
    warnings,
  };
}
