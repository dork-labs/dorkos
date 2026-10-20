/**
 * Which pending tool approvals may be answered from the web at all (Security
 * Must 4: no standing raises from the web). Fail closed: a short list of tools
 * whose single run is the whole effect, and everything else is decided at
 * this computer.
 *
 * Allowed from the web, once each:
 *
 * - Claude Code `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`,
 *   `WebFetch`, `WebSearch`;
 * - Codex `Shell`, and Codex `ApplyPatch` that asks for no write root and
 *   whose every change is to an allowed file.
 *
 * Refused, whatever proof follows: every `mcp__*` tool (DorkOS's own and any
 * other server's), Codex `Permissions`, OpenCode `external_directory`, `Task`,
 * `Agent`, `ExitPlanMode`, and any name not on the list. A file change is
 * refused when it lands under a protected name (`relay-protected-roots.ts`:
 * harness settings folders and files, which change what agents may do next,
 * and folders and files that run code later, such as `.git` hooks and
 * `.vscode` tasks) or in one of the protected roots the caller passes
 * (DorkOS's data folder and every folder DorkOS resolves for a harness:
 * Claude Code accounts, the Codex home, OpenCode's data and config folders,
 * `~/.agents`). A path with a `..` part is refused outright, so text
 * folding can never step around a symlink, and so is one starting with `~`.
 * A Codex patch is checked change by change, including where an `update`
 * moves a file to. Paths are judged after following
 * every symlink that exists, in the case the disk stores them, and compared
 * without regard to case on macOS and Windows. A Codex card whose input is the
 * placeholder Codex shows when it does not know the real input is refused,
 * since the owner would sign an input that is not the one that runs.
 *
 * `Bash` and `Shell` cannot be classified from their text: a command can do
 * anything. They are allowed because each is a one-shot the owner reads in
 * full on the approve page before signing, never a standing permission. A
 * cheap tripwire still refuses one whose text names a protected root or a
 * protected name, and one with no command text; it is not a parser, and a
 * command that hides the name gets through (the accepted residual).
 *
 * Accepted residuals: a folder made into a symlink after this check, by
 * another process or another turn (the same class as an unasked shell, out of
 * B4's scope), and Windows 8.3 short names (`PROGRA~1`), which are not
 * expanded here.
 *
 * @module services/core/session-relay/relay-approvable
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PendingApprovalCard } from './approval-challenges.js';
import { commandNamesProtected, pathNamesProtected } from './relay-protected-roots.js';

/** Tools whose web approval is a single run of exactly what the owner read. */
const ONE_SHOT_TOOLS = new Set(['WebFetch', 'WebSearch']);

/** Shell tools, whose `command` text passes the tripwire: Claude Code `Bash`, Codex `Shell`. */
const COMMAND_TOOLS = new Set(['Bash', 'Shell']);

/** Claude Code file tools, by the input field naming the file they change. */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/**
 * The inputs Codex shows when the real one is unknown (`server-requests.ts`
 * in the Codex runtime): a card that holds one binds nothing.
 */
const CODEX_PLACEHOLDER_INPUTS: Record<string, string> = {
  Shell: '{}',
  ApplyPatch: JSON.stringify({ changes: [] }),
};

/** Where a file change is judged from. */
export interface RelayApprovableContext {
  /** The chat's folder, which a relative path resolves against. */
  cwd: string | null;
  /** Folders no web approval may write in: DorkOS's data folder and every harness folder. */
  protectedRoots: readonly string[];
  /** The home folder, so the tripwire knows `~/…` and `$HOME/…` spellings of a root. */
  homeDir?: string | null;
  /** Compare without regard to case; defaults to true on macOS and Windows. */
  caseInsensitive?: boolean;
}

/** Lower case where the file system ignores case, the text unchanged elsewhere. */
function folder(context: RelayApprovableContext): (text: string) => string {
  return (context.caseInsensitive ??
    (process.platform === 'darwin' || process.platform === 'win32'))
    ? (text: string) => text.toLowerCase()
    : (text: string) => text;
}

/**
 * A path with its deepest existing ancestor resolved by the OS (symlinks
 * followed, the case the disk stores), the rest appended as written.
 */
function realOrResolved(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `child` is `parent` or inside it. */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether one file a tool would change is somewhere the web may write. */
function targetAllowed(raw: unknown, context: RelayApprovableContext): boolean {
  if (typeof raw !== 'string' || raw === '') return false;
  // Refused before resolving: `path.resolve` folds `..` as text, past any symlink.
  const segments = raw.split(/[\\/]/);
  if (segments.includes('..')) return false;
  // A `~` path means the home folder to a shell but a literal folder here: refused either way.
  if (segments[0]?.startsWith('~')) return false;
  if (!path.isAbsolute(raw) && context.cwd === null) return false;
  const fold = folder(context);
  const target = fold(realOrResolved(path.resolve(context.cwd ?? '/', raw)));
  if (pathNamesProtected(target)) return false;
  return !context.protectedRoots.some((root) => {
    const resolved = path.resolve(root);
    return isWithin(target, fold(resolved)) || isWithin(target, fold(realOrResolved(resolved)));
  });
}

/** The input as an object, or `null` when it is not a JSON object. */
function inputObject(card: PendingApprovalCard): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(card.input);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The change kinds Codex's app-server sends (`PatchChangeKind` in the Codex
 * runtime's `protocol/schema-snapshot.json`): `add`, `delete`, and `update`,
 * which may also move the file to `move_path`.
 */
const PATCH_CHANGE_KINDS = new Set(['add', 'delete', 'update']);

/** Whether one patch change, and the file it may move to, is somewhere the web may write. */
function changeAllowed(change: unknown, context: RelayApprovableContext): boolean {
  if (change === null || typeof change !== 'object') return false;
  const { path: target, kind } = change as Record<string, unknown>;
  if (kind === null || typeof kind !== 'object' || Array.isArray(kind)) return false;
  const { type, move_path: movePath } = kind as Record<string, unknown>;
  if (typeof type !== 'string' || !PATCH_CHANGE_KINDS.has(type)) return false;
  if (!targetAllowed(target, context)) return false;
  // A rename writes its destination too.
  return movePath === undefined || movePath === null || targetAllowed(movePath, context);
}

/** Whether a Codex patch names at least one change, and only changes to allowed files. */
function patchAllowed(card: PendingApprovalCard, context: RelayApprovableContext): boolean {
  // A patch that also asks for a write root would widen where Codex may write.
  if (card.blockedPath !== undefined) return false;
  const changes = inputObject(card)?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return false;
  return changes.every((change: unknown) => changeAllowed(change, context));
}

/** Whether a shell command has text, and none of it names a protected root or name. */
function commandAllowed(card: PendingApprovalCard, context: RelayApprovableContext): boolean {
  const command = inputObject(card)?.command;
  if (typeof command !== 'string' || command.trim() === '') return false;
  return !commandNamesProtected(command, {
    protectedRoots: context.protectedRoots,
    homeDir: context.homeDir ?? null,
    fold: folder(context),
  });
}

/**
 * Whether a pending tool approval may be answered from the web. Checked when
 * a challenge is issued and again when the signed answer arrives.
 *
 * @param card - The pending tool approval, as the chat holds it now.
 * @param context - The chat's folder and the protected roots.
 * @returns True only for a tool on the list, with a real input and allowed targets.
 */
export function relayApprovableCard(
  card: PendingApprovalCard,
  context: RelayApprovableContext
): boolean {
  const placeholder = CODEX_PLACEHOLDER_INPUTS[card.toolName];
  if (placeholder !== undefined && card.input === placeholder) return false;
  if (ONE_SHOT_TOOLS.has(card.toolName)) return true;
  if (COMMAND_TOOLS.has(card.toolName)) return commandAllowed(card, context);
  if (card.toolName === 'ApplyPatch') return patchAllowed(card, context);
  const field = FILE_TOOLS[card.toolName];
  return field !== undefined && targetAllowed(inputObject(card)?.[field], context);
}
