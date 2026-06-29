/**
 * Codex hooks generation — translate a Claude hooks config into a Codex one.
 *
 * Claude and Codex share the same on-disk hook shape
 * (`{ matcher?, hooks: [{ type, command }] }`); only the event-key spelling
 * differs. Translation routes every Claude event name through its canonical form
 * and out to the Codex spelling. Any event with no canonical form, or no Codex
 * equivalent, is reported in `dropped` with a reason — never silently lost.
 *
 * @module generate/hooks
 */
import {
  CLAUDE_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_CODEXCLI_EVENT_NAMES,
} from '../vendor/rulesync-maps.js';

/** A single hook command (Claude and Codex both use the `command` type). */
export interface HookCommand {
  /** The hook command kind. */
  type: string;
  /** The shell command to execute. */
  command: string;
}

/** A matcher group: an optional matcher and its ordered hook commands. */
export interface HookMatcherGroup {
  /** Optional tool/event matcher (a glob or regex). */
  matcher?: string;
  /** The ordered hook commands for this matcher group. */
  hooks: HookCommand[];
}

/** The `.hooks` object from `.claude/settings.json`, keyed by Claude event name. */
export type ClaudeHooksConfig = Record<string, HookMatcherGroup[]>;

/** A generated `.codex/hooks.json` hooks object, keyed by Codex event name. */
export type CodexHooksConfig = Record<string, HookMatcherGroup[]>;

/** A single dropped hook event and the reason it could not be projected. */
interface DroppedHook {
  /** The Claude event name that was dropped. */
  event: string;
  /** Human-readable reason the event has no Codex home. */
  reason: string;
}

/**
 * Translate a Claude hooks config into a Codex hooks config.
 *
 * @param claudeHooks - the `.hooks` object from `.claude/settings.json`.
 * @returns the Codex hooks object plus an explicit list of dropped events.
 */
export function generateCodexHooks(claudeHooks: ClaudeHooksConfig): {
  hooks: CodexHooksConfig;
  dropped: DroppedHook[];
} {
  const hooks: CodexHooksConfig = {};
  const dropped: DroppedHook[] = [];

  for (const [event, groups] of Object.entries(claudeHooks)) {
    const canonical = CLAUDE_TO_CANONICAL_EVENT_NAMES[event];
    if (!canonical) {
      dropped.push({ event, reason: `no canonical mapping for Claude event "${event}"` });
      continue;
    }
    const codexEvent = CANONICAL_TO_CODEXCLI_EVENT_NAMES[canonical];
    if (!codexEvent) {
      dropped.push({
        event,
        reason: `Codex has no equivalent for "${event}" (canonical "${canonical}")`,
      });
      continue;
    }
    hooks[codexEvent] = groups;
  }

  return { hooks, dropped };
}
