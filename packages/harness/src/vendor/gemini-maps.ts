/**
 * Gemini CLI hook-event maps and path constants, AUTHORED IN-REPO.
 *
 * rulesync (the upstream we vendor in `rulesync-maps.ts`) ships NO Gemini hook
 * map and NO Gemini path constants at the pinned commit `b4bf09d5` — Gemini
 * appears there only as a config enum value and in passing comments. So, unlike
 * the rulesync maps, this file is hand-authored DorkOS source, not vendored.
 *
 * Event names below are confirmed against the official Gemini CLI hooks
 * reference: Gemini uses its own PascalCase spelling (`BeforeTool`/`AfterTool`/
 * `BeforeAgent`/`AfterAgent`/...), NOT Claude's (`PreToolUse`/`PostToolUse`).
 * Hooks are configured under the `hooks` key of `.gemini/settings.json`.
 *
 * @see https://geminicli.com/docs/hooks/reference/
 * @see https://developers.googleblog.com/tailor-gemini-cli-to-your-workflow-with-hooks/
 *
 * @module
 */

import { join } from 'node:path';
import type { HookEvent } from './rulesync-maps.js';

/**
 * Map canonical camelCase event names to Gemini CLI's PascalCase event names.
 *
 * Covers the portable 5-event core plus the directly-confirmed `sessionEnd`.
 * Two of these are documented equivalences rather than exact 1:1 names:
 *   - `beforeSubmitPrompt` -> `BeforeAgent`: Gemini's `BeforeAgent` fires after
 *     the user submits but before agent planning — the closest "prompt submit".
 *   - `stop` -> `AfterAgent`: Gemini has no literal "Stop"; `AfterAgent` runs
 *     once per turn after the final model response — the closest "turn end".
 *
 * Gemini documents additional events not in the portable core and therefore not
 * mapped here yet: `BeforeModel`, `AfterModel`, `BeforeToolSelection`,
 * `Notification`, and `PreCompress`.
 *
 * TODO(B9/DOR-143): verify exact Gemini hook config emission (the settings.json
 * `hooks` object shape + matcher semantics) when wiring the projector, and
 * decide whether to extend this map to the non-core Gemini events above.
 */
export const CANONICAL_TO_GEMINI_EVENT_NAMES: Record<string, string> = {
  preToolUse: 'BeforeTool',
  postToolUse: 'AfterTool',
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'BeforeAgent',
  stop: 'AfterAgent',
};

/** Map Gemini CLI PascalCase event names back to canonical camelCase. */
export const GEMINI_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_GEMINI_EVENT_NAMES).map(([k, v]) => [v, k])
);

/**
 * Canonical hook events supported by Gemini CLI (the subset we currently map).
 *
 * Derived from {@link CANONICAL_TO_GEMINI_EVENT_NAMES} so the two never drift.
 */
export const GEMINI_HOOK_EVENTS: readonly HookEvent[] = Object.keys(
  CANONICAL_TO_GEMINI_EVENT_NAMES
) as HookEvent[];

/**
 * Gemini CLI configuration-layout paths (skills, rules, hooks, commands).
 *
 * Confirmed conventions: Gemini reads instructions from `GEMINI.md`, merges
 * settings from `.gemini/settings.json` (where hooks live, under the `hooks`
 * key), and reads custom commands (TOML) from `.gemini/commands`. The skills
 * directory (`.gemini/skills`) is the DorkOS target convention; Gemini skill
 * loading is nascent, so confirm the exact directory when wiring the projector.
 *
 * TODO(B9/DOR-143): confirm the `.gemini/skills` directory convention against
 * the shipped Gemini CLI before relying on it for skill projection.
 */
export const geminiPaths = {
  dir: '.gemini',
  ruleFileName: 'GEMINI.md',
  skillsDirPath: join('.gemini', 'skills'),
  commandsDirPath: join('.gemini', 'commands'),
  settingsFileName: 'settings.json',
  hooksFileName: 'settings.json',
} as const;
