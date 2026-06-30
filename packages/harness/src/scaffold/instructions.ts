/**
 * Instruction scaffolding — write a canonical AGENTS.md plus per-harness pointers
 * into a workspace directory (an agent workspace, or any repo root).
 *
 * This is the standalone counterpart to the projector's instruction handling:
 * the projector plans instructions for an existing repo; this writes them into a
 * freshly created workspace. Both share {@link planInstruction} so the per-harness
 * target + pointer content stay in one place.
 *
 * Everything is WRITE-IF-ABSENT (ADR-0302). The canonical `AGENTS.md` body is
 * written only when no AGENTS.md exists and is NEVER regenerated — a hand-edited
 * AGENTS.md is left exactly as the user left it. Each harness pointer is likewise
 * created only when absent, so re-running never clobbers a customized pointer.
 *
 * @module scaffold/instructions
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_IDS, type HarnessId } from '../manifest/schema.js';
import { planInstruction } from '../plan/instructions.js';
import { getActionContent } from '../plan/content-map.js';

/** Options for {@link scaffoldInstructions}. */
export interface ScaffoldInstructionsOptions {
  /**
   * The body written to a freshly created `AGENTS.md`. Ignored when an AGENTS.md
   * already exists — the canonical body is never regenerated.
   */
  agentsBody: string;
  /**
   * Which harnesses to scaffold instruction pointers for. Defaults to every
   * supported harness, so the workspace is portable to any of them.
   */
  harnesses?: readonly HarnessId[];
}

/** What {@link scaffoldInstructions} did, by repo-relative path. */
export interface ScaffoldInstructionsResult {
  /** Files written this run (did not exist before). */
  created: string[];
  /** Files left untouched because they already existed (user-owned). */
  skipped: string[];
}

/**
 * Scaffold a canonical `AGENTS.md` and per-harness instruction pointers into a
 * workspace, writing only files that do not already exist.
 *
 * Produces `AGENTS.md` (canonical), `.claude/CLAUDE.md` (`@../AGENTS.md`),
 * `GEMINI.md`, and `.github/copilot-instructions.md` (pointers). Harnesses that
 * read `AGENTS.md` natively (Codex, Cursor) get no pointer file.
 *
 * @param rootDir - absolute path to the workspace root to scaffold into.
 * @param opts - the canonical AGENTS.md body and optional harness filter.
 * @returns the files created and the files skipped (already present).
 */
export function scaffoldInstructions(
  rootDir: string,
  opts: ScaffoldInstructionsOptions
): ScaffoldInstructionsResult {
  const created: string[] = [];
  const skipped: string[] = [];

  // 1. The canonical AGENTS.md — write-if-absent, never regenerated (ADR-0302).
  writeIfAbsent(rootDir, 'AGENTS.md', opts.agentsBody, created, skipped);

  // 2. Per-harness pointers — reuse the projector's instruction mapping so the
  //    target paths + pointer content stay defined in exactly one place.
  const harnesses = opts.harnesses ?? HARNESS_IDS;
  for (const harness of harnesses) {
    const action = planInstruction(harness, true);
    if (action.kind !== 'scaffold' || !action.target) continue; // native harnesses write nothing
    const content = getActionContent(action);
    if (content === undefined) continue; // planInstruction always attaches content to a scaffold
    writeIfAbsent(rootDir, action.target, content, created, skipped);
  }

  return { created, skipped };
}

/** Write `relPath` under `rootDir` only when absent; record the outcome. */
function writeIfAbsent(
  rootDir: string,
  relPath: string,
  content: string,
  created: string[],
  skipped: string[]
): void {
  const abs = join(rootDir, relPath);
  if (existsSync(abs)) {
    skipped.push(relPath);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  created.push(relPath);
}
