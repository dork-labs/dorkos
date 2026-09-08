import { z } from 'zod';

/**
 * The harness vocabulary — the ids and display names of every agent harness
 * Harness Sync knows about.
 *
 * This lives in `@dorkos/shared` rather than in `@dorkos/harness` because the
 * client needs `HarnessId` and `HARNESS_LABELS` to draw a chip row, and it
 * cannot import `@dorkos/harness`, which is a Node filesystem engine.
 * `@dorkos/harness` re-exports all four names from here (`src/manifest/schema.ts`)
 * so every existing import keeps working and there is exactly one definition.
 */

/**
 * The agent harnesses Harness Sync can project to. Claude Code is the canonical
 * authoring harness; the rest are projection targets.
 */
export const HARNESS_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
] as const;

/** Zod schema for a single harness identifier (one of {@link HARNESS_IDS}). */
export const HarnessIdSchema = z.enum(HARNESS_IDS);

/** A supported agent harness identifier. */
export type HarnessId = z.infer<typeof HarnessIdSchema>;

/**
 * How each harness is named in prose a person reads — drop reasons, projection
 * notes, warnings.
 *
 * The id is the key in a manifest and a CLI flag; it is not the product's name.
 * `gemini` is Gemini CLI, `claude-code` is Claude Code. One map, so a reason
 * built in the projector and one built in the installed-plugin projector call
 * the same harness the same thing.
 */
export const HARNESS_LABELS: Readonly<Record<HarnessId, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  copilot: 'Copilot',
  opencode: 'OpenCode',
};
