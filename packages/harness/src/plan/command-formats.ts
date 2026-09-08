/**
 * Where each harness keeps its own repo-local slash commands — the vendor fact
 * behind every command `drop` reason.
 *
 * A drop says an artifact has no home in a harness. For commands that was once
 * true across the board, and one sentence — "no repo-local slash-command format"
 * — was reused for every harness. It is now true of exactly one of them: Cursor,
 * Gemini CLI, Copilot and OpenCode each document a repo-local command directory,
 * so telling their users the format does not exist is wrong in the
 * under-claiming direction (CM-04, CM-06). The drops stay — nothing projects
 * into those directories yet — but each one names the format it is not writing
 * to, so a person can see what they are missing rather than being told there is
 * nothing to miss.
 *
 * Codex is the honest absence: its custom prompts were deprecated in favour of
 * skills, so there is no repo-local command format to name.
 *
 * Vendor pages, fetched 2026-09-07 (`meta/harness-sync-capabilities.md` §1.2):
 * Cursor `.cursor/commands/*.md`, Gemini CLI `.gemini/commands/*.toml`, Copilot
 * `.github/prompts/*.prompt.md` (VS Code), OpenCode `.opencode/commands/*.md`
 * (flat, no namespacing).
 *
 * @module plan/command-formats
 */
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';

/**
 * Each harness's documented repo-local slash-command location. A harness absent
 * from this map has no such format at all.
 */
export const HARNESS_COMMAND_FORMATS: Partial<Record<HarnessId, string>> = {
  'claude-code': '.claude/commands/**/*.md',
  cursor: '.cursor/commands/*.md',
  gemini: '.gemini/commands/*.toml',
  copilot: '.github/prompts/*.prompt.md (VS Code)',
  opencode: '.opencode/commands/*.md',
};

/** The reason Codex commands drop: there is genuinely nowhere to put them. */
export const CODEX_NO_COMMAND_FORMAT_REASON =
  'no repo-local slash-command format (custom prompts are deprecated in favour of skills)';

/**
 * The honest reason a command drops for one harness: it names that harness's own
 * command format when it has one, and says so plainly when it does not.
 *
 * @param harness - the harness the command did not reach.
 * @returns a reason naming either the format nothing writes to yet, or its absence.
 */
export function commandDropReason(harness: HarnessId): string {
  const format = HARNESS_COMMAND_FORMATS[harness];
  if (!format) return CODEX_NO_COMMAND_FORMAT_REASON;
  return `not projected yet — ${HARNESS_LABELS[harness]} reads ${format}`;
}
