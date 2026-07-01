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
} from '../generate/hooks.js';
import { planInstruction } from './instructions.js';
import type { InstalledPlugin } from '../sources/installed.js';
import {
  planInstalledSkills,
  dropNonPortableLayers,
  dropWholePlugin,
  mergeHookConfigs,
} from './installed-projector.js';

/** Package types whose content projects to harnesses (skills/tasks/hooks live here). */
const PROJECTABLE_PLUGIN_TYPES = new Set(['plugin', 'skill-pack']);

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
const STANDALONE_HOOK_HARNESSES: Partial<
  Record<
    HarnessId,
    {
      /** The repo-relative target path for this harness's generated hooks file. */
      target: string;
      /**
       * Translate the merged Claude hooks into this harness's on-disk content.
       *
       * @returns the deterministic file content (or `undefined` when the harness
       *   has zero mappable events — the file should not be written and any stale
       *   one is pruned by the apply stage), plus the dropped events and warnings.
       */
      generate: (claudeHooks: ClaudeHooksConfig) => {
        content: string | undefined;
        dropped: { event: string; reason: string }[];
        warnings: HookWarning[];
      };
    }
  >
> = {
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

  // Gemini: hooks live inside the shared `.gemini/settings.json`, which also
  // holds unrelated user settings. Projecting them safely means MERGING into
  // that file (and pruning only the engine-managed entries), which the current
  // apply stage does not yet support — so it is an honest drop, not a clobber.
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
 * path as an orphan to prune (the file is wholly engine-owned — gitignored,
 * regenerated each sync).
 */
function planStandaloneHooks(
  harness: HarnessId,
  spec: NonNullable<(typeof STANDALONE_HOOK_HARNESSES)[HarnessId]>,
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
 * projected per the manifest. Marketplace-installed plugins are projected too
 * (DOR-173): a project-scoped plugin's skills + tasks symlink into each harness's
 * skill dir (namespaced `<pkg>__<name>`), its hooks fold into the generated Codex
 * hooks file, and its non-portable layers drop with reasons. Global-scoped
 * installs and non-plugin package types are dropped (reported, never projected by
 * a project sync).
 *
 * @param input - the repo root, validated manifest, optional Claude hooks,
 *   whether a canonical `AGENTS.md` exists, and any installed plugins.
 * @returns the actionable projections, the honest drop list, and any warnings
 *   about projections that landed but may not work in the target harness.
 */
export function buildPlan(input: {
  repoRoot: string;
  manifest: HarnessManifest;
  claudeHooks?: ClaudeHooksConfig;
  agentsMdExists: boolean;
  installedPlugins?: InstalledPlugin[];
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

  // Fold installed-plugin hooks into the authored hooks so Codex gets one merged
  // hooks file (it reads a single `.codex/hooks.json`).
  const mergedHooks = mergeHookConfigs([claudeHooks, ...projectable.map((p) => p.hooks)]);

  const all: ProjectionAction[] = [];
  for (const harness of manifest.harnesses) {
    for (const skill of skills) all.push(planSkill(harness, skill, manifest));
    all.push(planInstruction(harness, agentsMdExists));
    const hookResult = planHooks(harness, mergedHooks);
    all.push(...hookResult.actions);
    warnings.push(...hookResult.warnings);
    all.push(planCommands(harness));
    for (const plugin of projectable) all.push(...planInstalledSkills(harness, plugin));
  }

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
