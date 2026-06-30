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
import type { ActionBase, ProjectionAction, ProjectionPlan } from './types.js';
import { setActionContent } from './content-map.js';
import { scanSkills, type SkillEntry } from '../scan/scanner.js';
import { generateCodexHooks, type ClaudeHooksConfig } from '../generate/hooks.js';
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

/** Project hooks to one harness (may yield several actions for Codex). */
function planHooks(harness: HarnessId, claudeHooks?: ClaudeHooksConfig): ProjectionAction[] {
  const base: ActionBase = { artifact: 'hook', harness, provenance: 'authored', name: 'hooks' };
  switch (harness) {
    case 'claude-code':
      return [{ ...base, kind: 'native', source: '.claude/settings.json' }];
    case 'codex':
      return planCodexHooks(claudeHooks);
    default:
      return [
        { ...base, kind: 'drop', reason: `hook projection to ${harness} is out of scope in v1` },
      ];
  }
}

/** Generate `.codex/hooks.json` from the Claude hooks config, dropping unmappable events. */
function planCodexHooks(claudeHooks?: ClaudeHooksConfig): ProjectionAction[] {
  if (!claudeHooks) return [];

  const { hooks, dropped } = generateCodexHooks(claudeHooks);
  const actions: ProjectionAction[] = [];

  if (Object.keys(hooks).length > 0) {
    const action: ProjectionAction = {
      artifact: 'hook',
      harness: 'codex',
      provenance: 'authored',
      name: 'hooks',
      kind: 'generate',
      source: '.claude/settings.json',
      target: '.codex/hooks.json',
    };
    setActionContent(action, JSON.stringify(hooks, null, 2) + '\n');
    actions.push(action);
  }

  for (const d of dropped) {
    actions.push({
      artifact: 'hook',
      harness: 'codex',
      provenance: 'authored',
      name: d.event,
      kind: 'drop',
      reason: d.reason,
    });
  }
  return actions;
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
 * @returns the actionable projections plus the honest, explicit drop list.
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
    all.push(...planHooks(harness, mergedHooks));
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
  };
}
