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
 * The pointer file each harness that cannot read `AGENTS.md` itself needs, and
 * the deterministic body written into it.
 *
 * A table rather than three `case` bodies because the TARGET is asked for on its
 * own: the scaffold notice for a harness DorkOS turned on has to name the file
 * that will point at the person's `AGENTS.md` (`dorkosHarnessScaffoldNotice`),
 * and building a throwaway projection action to read it back would leave an
 * entry in the content side-table for a plan nobody is applying.
 *
 * `null` is a harness that reads `AGENTS.md` where it already sits, and it is
 * spelled out rather than left absent: a TOTAL `Record` is what makes a seventh
 * harness id a compile error here. The `switch` this replaced had that property
 * for free, and a `Partial` would have quietly let the new one fall through to
 * `native` — which is the IN-03 lie, a plan claiming a harness reads a file
 * nobody pointed it at.
 */
const INSTRUCTION_POINTERS: Record<HarnessId, { target: string; content: string } | null> = {
  'claude-code': { target: '.claude/CLAUDE.md', content: CLAUDE_INSTRUCTION_CONTENT },
  gemini: { target: 'GEMINI.md', content: instructionPointer('./AGENTS.md') },
  copilot: {
    target: '.github/copilot-instructions.md',
    content: instructionPointer('../AGENTS.md'),
  },
  codex: null,
  cursor: null,
  opencode: null,
};

/**
 * The pointer file a harness needs to be sent to `AGENTS.md`, or `undefined`
 * when it reads `AGENTS.md` where it already sits.
 *
 * @param harness - the target harness.
 * @returns the repo-relative pointer path, or `undefined` for a native reader.
 */
export function instructionPointerTarget(harness: HarnessId): string | undefined {
  return INSTRUCTION_POINTERS[harness]?.target;
}

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

  const pointer = INSTRUCTION_POINTERS[harness];
  if (pointer) return scaffoldInstruction(base, pointer.target, pointer.content);
  return {
    ...base,
    kind: 'native',
    reason: `${HARNESS_LABELS[harness]} reads AGENTS.md directly`,
  };
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
