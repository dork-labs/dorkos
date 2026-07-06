/**
 * Instruction projection — map the canonical AGENTS.md to each harness.
 *
 * Each harness either reads AGENTS.md natively (codex, cursor, opencode) or needs
 * a scaffolded pointer file (claude-code → `.claude/CLAUDE.md`, gemini → `GEMINI.md`,
 * copilot → `.github/copilot-instructions.md`). Instructions are SCAFFOLDED, never
 * generated (ADR-0302): the pointer is written once and the canonical body is
 * never regenerated. Shared by the projector (repo-wide projection) and the
 * agent-workspace instruction scaffolder, so the per-harness target + pointer
 * content live in exactly one place.
 *
 * @module plan/instructions
 */
import type { HarnessId } from '../manifest/schema.js';
import type { ActionBase, ProjectionAction } from './types.js';
import { setActionContent } from './content-map.js';

/** The deterministic body of the scaffolded Claude instruction pointer. */
export const CLAUDE_INSTRUCTION_CONTENT = '@../AGENTS.md\n';

/**
 * Build a deterministic markdown pointer file that defers to AGENTS.md.
 *
 * @param relativePath - the path from the pointer file to AGENTS.md.
 * @returns the pointer file body.
 */
export function instructionPointer(relativePath: string): string {
  return (
    '# Project instructions\n\n' +
    `The canonical project instructions live in [AGENTS.md](${relativePath}). Read that file.\n`
  );
}

/**
 * Project the canonical AGENTS.md instruction to one harness.
 *
 * @param harness - the target harness.
 * @param agentsMdExists - whether a canonical AGENTS.md is present to point at.
 * @returns the projection action (`native`, `scaffold`, or `drop`).
 */
export function planInstruction(harness: HarnessId, agentsMdExists: boolean): ProjectionAction {
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
    case 'opencode':
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
