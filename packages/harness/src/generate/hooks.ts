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

/**
 * The repo-relative path of the engine-generated Codex hooks file. It is wholly
 * engine-owned for the Codex harness (gitignored, regenerated every sync from the
 * canonical `.claude/settings.json` hooks plus installed-plugin hooks), so the
 * single source of truth for this path is shared by the projector's generate
 * target and the apply stage's generated-orphan prune. When no plugin or authored
 * hook contributes a Codex-mappable event, the projector emits no generate action
 * and the apply stage prunes any stale file at this path.
 */
export const CODEX_HOOKS_TARGET = '.codex/hooks.json';

/**
 * Every repo-relative file the engine generates and wholly owns per harness.
 * The apply stage prunes any of these still on disk that the current plan no
 * longer regenerates (the source plugin/hook is gone). Hand-authored content is
 * never listed here, so the prune can never clobber it.
 */
export const GENERATED_HOOK_TARGETS = [CODEX_HOOKS_TARGET] as const;

/** A single dropped hook event and the reason it could not be projected. */
interface DroppedHook {
  /** The Claude event name that was dropped. */
  event: string;
  /** Human-readable reason the event has no Codex home. */
  reason: string;
}

/** A projected hook that may not work in the target harness, with the reason. */
export interface HookWarning {
  /** The Claude event name whose command carries the unresolved token. */
  event: string;
  /** Human-readable warning (which token, and that the non-Claude harness will not resolve it). */
  reason: string;
}

/**
 * Substitution tokens Claude Code resolves at hook-exec time that no other
 * harness understands. A projected command that still contains one of these
 * (e.g. `${CLAUDE_PLUGIN_ROOT}` in a plugin's Stop hook) is broken in the target
 * harness, so the engine warns rather than projecting it as silently-correct.
 */
const CLAUDE_ONLY_HOOK_TOKENS = ['${CLAUDE_PLUGIN_ROOT}'] as const;

/**
 * Match any `${CLAUDE_*}` / `${CLAUDE_*_ROOT}`-style substitution: a literal
 * `CLAUDE_`-prefixed variable Claude Code expands but Codex (and other harnesses)
 * leave verbatim. This is the general net beyond the named tokens above.
 */
const CLAUDE_VAR_PATTERN = /\$\{CLAUDE_[A-Z0-9_]*\}/;

/**
 * Detect Claude-only substitution tokens in a projected hook command.
 *
 * @param command - the shell command being projected to a non-Claude harness.
 * @returns the distinct Claude-only tokens found (empty when the command is portable).
 */
function findClaudeOnlyTokens(command: string): string[] {
  const found = new Set<string>();
  for (const token of CLAUDE_ONLY_HOOK_TOKENS) {
    if (command.includes(token)) found.add(token);
  }
  for (const match of command.matchAll(new RegExp(CLAUDE_VAR_PATTERN, 'g'))) {
    found.add(match[0]);
  }
  return [...found];
}

/**
 * Collect warnings for any matcher group in `groups` whose command still carries
 * a Claude-only token. The hook is still projected (warn-and-project, not drop):
 * a broken hook that is reported is honest, an absent one is not.
 */
function warnClaudeOnlyTokens(event: string, groups: HookMatcherGroup[]): HookWarning[] {
  const tokens = new Set<string>();
  for (const group of groups) {
    for (const hook of group.hooks) {
      for (const token of findClaudeOnlyTokens(hook.command)) tokens.add(token);
    }
  }
  if (tokens.size === 0) return [];
  return [
    {
      event,
      reason: `hook command for "${event}" uses Claude-only ${[...tokens]
        .map((t) => `"${t}"`)
        .join(', ')}; Codex will not resolve it, so this hook may not work`,
    },
  ];
}

/**
 * Translate a Claude hooks config into a Codex hooks config.
 *
 * Events with no Codex home land in `dropped` (never silently lost). Events that
 * DO project but whose command carries a Claude-only substitution token (e.g.
 * `${CLAUDE_PLUGIN_ROOT}`, which Codex leaves verbatim) are still projected but
 * surface in `warnings` so the operator is told the hook may not work.
 *
 * @param claudeHooks - the `.hooks` object from `.claude/settings.json`.
 * @returns the Codex hooks object, the list of dropped events, and the list of
 *   projected-but-possibly-broken hook warnings.
 */
export function generateCodexHooks(claudeHooks: ClaudeHooksConfig): {
  hooks: CodexHooksConfig;
  dropped: DroppedHook[];
  warnings: HookWarning[];
} {
  const hooks: CodexHooksConfig = {};
  const dropped: DroppedHook[] = [];
  const warnings: HookWarning[] = [];

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
    warnings.push(...warnClaudeOnlyTokens(event, groups));
    hooks[codexEvent] = groups;
  }

  return { hooks, dropped, warnings };
}
