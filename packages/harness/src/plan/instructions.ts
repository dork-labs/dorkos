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
 * With no `AGENTS.md`, EVERY harness drops — the native readers included. A
 * `native` names a file the harness reads where it already sits, so claiming one
 * for a file that is not there is the plan asserting something untrue; the same
 * plan used to carry `codex native AGENTS.md` beside `claude-code drop … no
 * AGENTS.md` (IN-03, reproduced 2026-09-07).
 *
 * @module plan/instructions
 */
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
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

/** The one reason every harness gets when the canonical instruction file is absent. */
const NO_AGENTS_MD_REASON = 'no AGENTS.md — nothing to read or point at';

/**
 * Project the canonical AGENTS.md instruction to one harness.
 *
 * @param harness - the target harness.
 * @param agentsMdExists - whether a canonical AGENTS.md is present to read or point at.
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

  if (!agentsMdExists) return { ...base, kind: 'drop', reason: NO_AGENTS_MD_REASON };

  switch (harness) {
    case 'claude-code':
      return scaffoldInstruction(base, '.claude/CLAUDE.md', CLAUDE_INSTRUCTION_CONTENT);
    case 'codex':
    case 'cursor':
    case 'opencode':
      return {
        ...base,
        kind: 'native',
        reason: `${HARNESS_LABELS[harness]} reads AGENTS.md directly`,
      };
    case 'gemini':
      return scaffoldInstruction(base, 'GEMINI.md', instructionPointer('./AGENTS.md'));
    case 'copilot':
      return scaffoldInstruction(
        base,
        '.github/copilot-instructions.md',
        instructionPointer('../AGENTS.md')
      );
  }
}

/**
 * Emit a scaffold instruction action. Only reached once `AGENTS.md` is known to
 * exist — the absent case is one drop for every harness, decided above.
 */
function scaffoldInstruction(base: ActionBase, target: string, content: string): ProjectionAction {
  const action: ProjectionAction = { ...base, kind: 'scaffold', target };
  setActionContent(action, content);
  return action;
}
