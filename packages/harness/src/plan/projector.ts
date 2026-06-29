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
import type { ProjectionAction, ProjectionPlan } from './types.js';
import { setActionContent } from './content-map.js';
import { scanSkills, type SkillEntry } from '../scan/scanner.js';
import { generateCodexHooks, type ClaudeHooksConfig } from '../generate/hooks.js';

/** The deterministic body of the scaffolded Claude instruction pointer. */
const CLAUDE_INSTRUCTION_CONTENT = '@../AGENTS.md\n';

/** Fields shared by every action for one artifact + harness pairing. */
type ActionBase = Pick<ProjectionAction, 'artifact' | 'harness' | 'provenance' | 'name' | 'source'>;

/**
 * Build a deterministic markdown pointer file that defers to AGENTS.md.
 *
 * @param relativePath - the path from the pointer file to AGENTS.md.
 * @returns the pointer file body.
 */
function instructionPointer(relativePath: string): string {
  return (
    '# Project instructions\n\n' +
    `The canonical project instructions live in [AGENTS.md](${relativePath}). Read that file.\n`
  );
}

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

/** Project the canonical AGENTS.md instruction to one harness. */
function planInstruction(harness: HarnessId, agentsMdExists: boolean): ProjectionAction {
  const base: ActionBase = {
    artifact: 'instruction',
    harness,
    provenance: 'authored',
    name: 'AGENTS.md',
    source: 'AGENTS.md',
  };

  switch (harness) {
    case 'claude-code':
      return scaffoldInstruction(
        base,
        agentsMdExists,
        '.claude/CLAUDE.md',
        CLAUDE_INSTRUCTION_CONTENT
      );
    case 'codex':
    case 'cursor':
      return { ...base, kind: 'native', reason: `${harness} reads AGENTS.md directly` };
    case 'gemini':
      return scaffoldInstruction(
        base,
        agentsMdExists,
        'GEMINI.md',
        instructionPointer('./AGENTS.md')
      );
    case 'copilot':
      return scaffoldInstruction(
        base,
        agentsMdExists,
        '.github/copilot-instructions.md',
        instructionPointer('../AGENTS.md')
      );
  }
}

/** Emit a scaffold instruction action, or a drop when there is no AGENTS.md to point at. */
function scaffoldInstruction(
  base: ActionBase,
  agentsMdExists: boolean,
  target: string,
  content: string
): ProjectionAction {
  if (!agentsMdExists) return { ...base, kind: 'drop', reason: 'no AGENTS.md to point at' };
  const action: ProjectionAction = { ...base, kind: 'scaffold', target };
  setActionContent(action, content);
  return action;
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
