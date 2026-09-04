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
import type { HarnessId, HarnessManifest } from '../manifest/schema.js';
import type { ActionBase, ProjectionAction, ProjectionPlan, ProjectionWarning } from './types.js';
import { setActionContent } from './content-map.js';
import { scanSkills, type SkillEntry } from '../scan/scanner.js';
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
  planScheduledSkillLinks,
  planSkillNameCollisions,
  dropNonPortableLayers,
  dropWholePlugin,
  mergeHookConfigs,
  rewritePluginRootInHooks,
  PROJECTABLE_PLUGIN_TYPES,
} from './installed-projector.js';
import { planUnreadableHookWarnings } from './unreadable-hooks.js';

/** Project a single skill to one harness. */
function planSkill(
  harness: HarnessId,
  skill: SkillEntry,
  manifest: HarnessManifest
): ProjectionAction {
  const base: ActionBase = {
    artifact: 'skill',
    harness,
    provenance: 'authored',
    name: skill.name,
    source: skill.sourceDir,
  };

  const isClaudeOnly = manifest.claudeOnlySkills.some((c) => c.name === skill.name);
  if (harness !== 'claude-code' && isClaudeOnly) {
    return {
      ...base,
      kind: 'drop',
      reason: `claude-only skill (manifest.claudeOnlySkills); not projected to ${harness}`,
    };
  }

  switch (harness) {
    case 'claude-code':
      return { ...base, kind: 'symlink', target: `.claude/skills/${skill.name}` };
    case 'codex':
      return { ...base, kind: 'native', reason: 'Codex reads .agents/skills directly' };
    case 'opencode':
      return { ...base, kind: 'native', reason: 'OpenCode reads .agents/skills directly' };
    default:
      return {
        ...base,
        kind: 'drop',
        reason: `skills not auto-projected to ${harness} in v1; see DOR-143`,
      };
  }
}

/**
 * Every harness with a standalone, wholly-engine-owned hooks file. Each entry
 * runs its `generate` function over the merged Claude hooks, serializes the
 * result to the `target` path, and emits its unmapped events as drops. The
 * serialized payload differs by harness (Codex uses the bare matcher-group
 * object; Cursor and Copilot use a `{ version, hooks }` flat file), so each
 * entry owns its own `generate` that returns already-serializable content plus
 * the dropped/warning lists.
 *
 * Gemini is intentionally NOT here: its hooks live inside the SHARED
 * `.gemini/settings.json`, which is not wholly engine-owned, so it is handled as
 * an honest drop rather than a standalone generated file (see {@link planHooks}).
 */
/**
 * The static per-harness recipe for a standalone, wholly-engine-owned hooks
 * file: where it goes and how to build its content.
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

const STANDALONE_HOOK_HARNESSES: Partial<Record<HarnessId, StandaloneHookSpec>> = {
  codex: {
    target: CODEX_HOOKS_TARGET,
    generate: (claudeHooks) => {
      const { hooks, dropped, warnings } = generateCodexHooks(claudeHooks);
      const content =
        Object.keys(hooks).length > 0 ? JSON.stringify(hooks, null, 2) + '\n' : undefined;
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

/** Project hooks to one harness (may yield several actions + warnings). */
function planHooks(
  harness: HarnessId,
  claudeHooks?: ClaudeHooksConfig
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const base: ActionBase = { artifact: 'hook', harness, provenance: 'authored', name: 'hooks' };
  if (harness === 'claude-code') {
    return {
      actions: [{ ...base, kind: 'native', source: '.claude/settings.json' }],
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
 * Generate one harness's standalone, wholly-engine-owned hooks file from the
 * Claude hooks config: drop unmappable events, and warn (without dropping) when a
 * projected hook command carries a Claude-only substitution token the target
 * harness cannot resolve.
 *
 * Emits NO generate action when the merged config produces zero mappable hooks
 * for the target; the apply stage then treats any existing file at the target
 * path as an orphan to prune (the file is wholly engine-owned: gitignored,
 * regenerated each sync).
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
      source: '.claude/settings.json',
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

/** Project slash commands to one harness. */
function planCommands(harness: HarnessId): ProjectionAction {
  const base: ActionBase = {
    artifact: 'command',
    harness,
    provenance: 'authored',
    name: 'commands',
  };
  if (harness === 'claude-code') {
    return { ...base, kind: 'native', source: '.claude/commands' };
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
  return {
    ...base,
    kind: 'drop',
    reason:
      'no repo-local slash-command format; behavior travels as a mapped skill (commandMappings)',
  };
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
 * One projection ignores the harness list: a plugin skill carrying a `schedule:`
 * block is linked into `.agents/skills` regardless, because that is the only
 * project skills root the DorkOS scheduler watches (DOR-1518, see
 * {@link planScheduledSkillLinks}).
 *
 * `input.allowPluginHooks` is the one lever over WHICH installed packages get to
 * contribute hooks. It gates hooks and nothing else: a package it excludes still
 * projects its skills and commands, it simply contributes no shell commands to any
 * harness. Omitting it projects every package's hooks, which is what a person
 * running `dorkos harness sync` in their own terminal asks for. See
 * {@link projectedHookCommands} for the list a caller needs to decide.
 *
 * @param input - the repo root, validated manifest, optional Claude hooks,
 *   whether a canonical `AGENTS.md` exists, any installed plugins, and an optional
 *   per-package gate on hook contribution.
 * @returns the actionable projections, the honest drop list, and any warnings —
 *   about a projection that landed but may not work in the target harness, or a
 *   source declaration the engine could not read at all.
 */
export function buildPlan(input: {
  repoRoot: string;
  manifest: HarnessManifest;
  claudeHooks?: ClaudeHooksConfig;
  agentsMdExists: boolean;
  installedPlugins?: InstalledPlugin[];
  allowPluginHooks?: (packageName: string) => boolean;
}): ProjectionPlan {
  const { repoRoot, manifest, claudeHooks, agentsMdExists, installedPlugins = [] } = input;
  const skills = scanSkills(repoRoot);
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
    for (const skill of skills) all.push(planSkill(harness, skill, manifest));
    all.push(planInstruction(harness, agentsMdExists));
    const hookResult = planHooks(harness, mergedHooks);
    all.push(...hookResult.actions);
    warnings.push(...hookResult.warnings);
    all.push(planCommands(harness));
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

  // A schedule-bearing plugin skill reaches `.agents/skills` whatever harnesses
  // are enabled — it is the only project skills root the DorkOS scheduler
  // watches, so a schedule that lands anywhere else is a schedule nobody is ever
  // asked to approve (DOR-1518). Stands down when an enabled harness already
  // links installed skills there, so the target is planned exactly once.
  const scheduled = planScheduledSkillLinks({
    plugins: projectable,
    harnesses: manifest.harnesses,
  });
  all.push(...scheduled.actions);
  warnings.push(...scheduled.warnings);

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
