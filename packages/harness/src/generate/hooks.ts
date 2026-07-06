/**
 * Cross-harness hooks generation: translate a Claude hooks config into each
 * target harness's on-disk hook config.
 *
 * Claude and Codex share the same matcher-group hook shape
 * (`{ matcher?, hooks: [{ type, command }] }`); Cursor and Copilot flatten each
 * command into a standalone entry under a `{ version, hooks }` wrapper. Every
 * generator routes each Claude event name through its canonical form and out to
 * the target harness spelling. Any event with no canonical form, or no target
 * equivalent, is reported in `dropped` with a reason, never silently lost. A
 * projected command STILL carrying a Claude-only substitution token (e.g.
 * `${CLAUDE_PLUGIN_ROOT}`) surfaces in `warnings`: the hook still projects, but
 * the operator is told it may not work in the (non-Claude) target.
 *
 * By the time hooks reach these generators, an installed plugin's
 * `${CLAUDE_PLUGIN_ROOT}` has already been rewritten to its absolute install dir
 * by the projector (the install root is known at plan time), so those hooks are
 * portable and warning-free. Only AUTHORED hooks (whose root is unknown) and
 * other unresolved `${CLAUDE_*}` tokens remain here to warn on.
 *
 * @module generate/hooks
 */
import {
  CLAUDE_TO_CANONICAL_EVENT_NAMES,
  CANONICAL_TO_CODEXCLI_EVENT_NAMES,
  CANONICAL_TO_CURSOR_EVENT_NAMES,
  CANONICAL_TO_COPILOT_EVENT_NAMES,
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

/**
 * A generated matcher-group hooks object (Codex `.codex/hooks.json`), keyed by
 * the target harness's event name. Same shape as {@link ClaudeHooksConfig}.
 */
export type CodexHooksConfig = Record<string, HookMatcherGroup[]>;

/**
 * A single flattened hook entry for a harness (Cursor / Copilot) that does not
 * use the nested matcher-group shape. The optional `matcher` rides on the entry
 * itself rather than wrapping a group.
 */
export interface FlatHookEntry {
  /** The hook command kind (`command`). */
  type: string;
  /** The shell command to execute. */
  command: string;
  /** Optional tool/event matcher carried over from the source matcher group. */
  matcher?: string;
}

/**
 * A generated flat hooks file: a `{ version, hooks }` wrapper whose `hooks` maps
 * each target event name to an array of standalone {@link FlatHookEntry} items.
 * This is the shape Cursor (`.cursor/hooks.json`) and Copilot
 * (`.github/hooks/copilot-hooks.json`) both use.
 */
export interface FlatHooksFile {
  /** The config schema version (currently 1 for both Cursor and Copilot). */
  version: 1;
  /** Target-event-keyed arrays of flat hook entries. */
  hooks: Record<string, FlatHookEntry[]>;
}

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
 * The repo-relative path of the engine-generated Cursor hooks file. Wholly
 * engine-owned for the Cursor harness (gitignored, regenerated every sync), on
 * the same lifecycle as {@link CODEX_HOOKS_TARGET}.
 *
 * @see https://cursor.com/docs/agent/hooks
 */
export const CURSOR_HOOKS_TARGET = '.cursor/hooks.json';

/**
 * The repo-relative path of the engine-generated Copilot hooks file. Wholly
 * engine-owned for the Copilot harness (gitignored, regenerated every sync), on
 * the same lifecycle as {@link CODEX_HOOKS_TARGET}.
 *
 * @see https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks
 */
export const COPILOT_HOOKS_TARGET = '.github/hooks/copilot-hooks.json';

/**
 * Every repo-relative file the engine generates and wholly owns per harness.
 * The apply stage prunes any of these still on disk that the current plan no
 * longer regenerates (the source plugin/hook is gone). Hand-authored content is
 * never listed here, so the prune can never clobber it.
 *
 * Gemini is deliberately absent: its hooks live inside the SHARED
 * `.gemini/settings.json`, which also holds unrelated user settings, so the file
 * is NOT wholly engine-owned and must never be pruned by the orphan sweep.
 */
export const GENERATED_HOOK_TARGETS = [
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
] as const;

/** A single dropped hook event and the reason it could not be projected. */
export interface DroppedHook {
  /** The Claude event name that was dropped. */
  event: string;
  /** Human-readable reason the event has no home in the target harness. */
  reason: string;
}

/** A projected hook that may not work in the target harness, with the reason. */
export interface HookWarning {
  /** The Claude event name whose command carries the unresolved token. */
  event: string;
  /** Human-readable warning (which token, and that the target harness will not resolve it). */
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
 * `CLAUDE_`-prefixed variable Claude Code expands but other harnesses leave
 * verbatim. This is the general net beyond the named tokens above.
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
 * a broken hook that is reported is honest, an absent one is not. The warning
 * names the actual target harness (FND-11) so it is correct for every target,
 * not just Codex.
 *
 * @param harnessLabel - the human-readable target harness name (e.g. `"Cursor"`).
 * @param event - the Claude event name whose command is being checked.
 * @param groups - the matcher groups projected for this event.
 * @returns zero or one warning for the event (empty when the command is portable).
 */
function warnClaudeOnlyTokens(
  harnessLabel: string,
  event: string,
  groups: HookMatcherGroup[]
): HookWarning[] {
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
        .join(', ')}; ${harnessLabel} will not resolve it, so this hook may not work`,
    },
  ];
}

/** One event that translated to a target harness, with its source matcher groups. */
interface TranslatedEvent {
  /** The target harness's event name (e.g. Codex `Stop`, Cursor `stop`). */
  targetEvent: string;
  /** The source matcher groups to project under `targetEvent`. */
  groups: HookMatcherGroup[];
}

/**
 * Translate a Claude hooks config's event keys into one target harness's event
 * names, collecting drops (no canonical / no target home) and warnings
 * (projected-but-possibly-broken). The caller decides how to serialize the
 * translated events into the target's on-disk shape.
 *
 * @param claudeHooks - the `.hooks` object from `.claude/settings.json`.
 * @param harnessLabel - the human-readable target harness name (for warnings/drops).
 * @param eventMap - the `CANONICAL_TO_<tool>_EVENT_NAMES` map for the target.
 * @returns the translated events plus the drop and warning lists.
 */
function translateHooks(
  claudeHooks: ClaudeHooksConfig,
  harnessLabel: string,
  eventMap: Record<string, string>
): { translated: TranslatedEvent[]; dropped: DroppedHook[]; warnings: HookWarning[] } {
  const translated: TranslatedEvent[] = [];
  const dropped: DroppedHook[] = [];
  const warnings: HookWarning[] = [];

  for (const [event, groups] of Object.entries(claudeHooks)) {
    const canonical = CLAUDE_TO_CANONICAL_EVENT_NAMES[event];
    if (!canonical) {
      dropped.push({ event, reason: `no canonical mapping for Claude event "${event}"` });
      continue;
    }
    const targetEvent = eventMap[canonical];
    if (!targetEvent) {
      dropped.push({
        event,
        reason: `${harnessLabel} has no equivalent for "${event}" (canonical "${canonical}")`,
      });
      continue;
    }
    warnings.push(...warnClaudeOnlyTokens(harnessLabel, event, groups));
    translated.push({ targetEvent, groups });
  }

  return { translated, dropped, warnings };
}

/** Flatten matcher groups into standalone entries, carrying `matcher` onto each entry. */
function flattenGroups(groups: HookMatcherGroup[]): FlatHookEntry[] {
  const entries: FlatHookEntry[] = [];
  for (const group of groups) {
    for (const hook of group.hooks) {
      const entry: FlatHookEntry = { type: hook.type, command: hook.command };
      if (group.matcher !== undefined) entry.matcher = group.matcher;
      entries.push(entry);
    }
  }
  return entries;
}

/** Assemble translated events into a `{ version, hooks }` flat file, concatenating per event. */
function toFlatFile(translated: TranslatedEvent[]): FlatHooksFile {
  const hooks: Record<string, FlatHookEntry[]> = {};
  for (const { targetEvent, groups } of translated) {
    hooks[targetEvent] = [...(hooks[targetEvent] ?? []), ...flattenGroups(groups)];
  }
  return { version: 1, hooks };
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
  const { translated, dropped, warnings } = translateHooks(
    claudeHooks,
    'Codex',
    CANONICAL_TO_CODEXCLI_EVENT_NAMES
  );
  const hooks: CodexHooksConfig = {};
  for (const { targetEvent, groups } of translated) hooks[targetEvent] = groups;
  return { hooks, dropped, warnings };
}

/**
 * Translate a Claude hooks config into a Cursor hooks file
 * (`.cursor/hooks.json`).
 *
 * Cursor uses a `{ version, hooks }` wrapper whose `hooks` maps each event to an
 * array of FLAT entries (`{ command, type, matcher? }`), not the nested
 * matcher-group shape, so each source command becomes its own entry. Events
 * with no Cursor home land in `dropped`; a projected command with a Claude-only
 * token surfaces in `warnings` naming Cursor.
 *
 * @param claudeHooks - the `.hooks` object from `.claude/settings.json`.
 * @returns the Cursor hooks file, the dropped events, and the warnings.
 * @see https://cursor.com/docs/agent/hooks
 */
export function generateCursorHooks(claudeHooks: ClaudeHooksConfig): {
  file: FlatHooksFile;
  dropped: DroppedHook[];
  warnings: HookWarning[];
} {
  const { translated, dropped, warnings } = translateHooks(
    claudeHooks,
    'Cursor',
    CANONICAL_TO_CURSOR_EVENT_NAMES
  );
  return { file: toFlatFile(translated), dropped, warnings };
}

/**
 * Translate a Claude hooks config into a Copilot hooks file
 * (`.github/hooks/copilot-hooks.json`).
 *
 * Copilot (the cloud coding agent) uses the same `{ version, hooks }` wrapper +
 * flat-entry shape as Cursor. Its command entries additionally accept
 * platform-specific `bash`/`powershell` keys, but a portable `command` entry is
 * valid, so the engine emits the same `{ command, type, matcher? }` entry it
 * emits for Cursor. Events with no Copilot home land in `dropped`; a projected
 * command with a Claude-only token surfaces in `warnings` naming Copilot.
 *
 * @param claudeHooks - the `.hooks` object from `.claude/settings.json`.
 * @returns the Copilot hooks file, the dropped events, and the warnings.
 * @see https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks
 */
export function generateCopilotHooks(claudeHooks: ClaudeHooksConfig): {
  file: FlatHooksFile;
  dropped: DroppedHook[];
  warnings: HookWarning[];
} {
  const { translated, dropped, warnings } = translateHooks(
    claudeHooks,
    'Copilot',
    CANONICAL_TO_COPILOT_EVENT_NAMES
  );
  return { file: toFlatFile(translated), dropped, warnings };
}
