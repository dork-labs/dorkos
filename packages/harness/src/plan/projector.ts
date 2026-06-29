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
 * @param input - the repo root, validated manifest, optional Claude hooks, and
 *   whether a canonical `AGENTS.md` exists.
 * @returns the actionable projections plus the honest, explicit drop list.
 */
export function buildPlan(input: {
  repoRoot: string;
  manifest: HarnessManifest;
  claudeHooks?: ClaudeHooksConfig;
  agentsMdExists: boolean;
}): ProjectionPlan {
  const { repoRoot, manifest, claudeHooks, agentsMdExists } = input;
  const skills = scanSkills(repoRoot);

  const all: ProjectionAction[] = [];
  for (const harness of manifest.harnesses) {
    for (const skill of skills) all.push(planSkill(harness, skill, manifest));
    all.push(planInstruction(harness, agentsMdExists));
    all.push(...planHooks(harness, claudeHooks));
    all.push(planCommands(harness));
  }

  return {
    actions: all.filter((a) => a.kind !== 'drop'),
    drops: all.filter((a) => a.kind === 'drop'),
  };
}
