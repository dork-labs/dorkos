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
 * refused when it lands in a harness settings folder (any `.claude*`,
 * `.dork`, `.codex`, `.opencode` or `.agents` folder), in one of the
 * protected roots the caller passes (DorkOS's data folder and every folder
 * DorkOS resolves for a harness: Claude Code accounts, the Codex home,
 * OpenCode's data and config folders, `~/.agents`), or in a file named
 * `opencode.json`, `opencode.jsonc` or `.mcp.json`: writing there changes what
 * agents may do next. A path with a `..` part is refused outright, so text
 * folding can never step around a symlink. Paths are judged after following
 * every symlink that exists, in the case the disk stores them, and compared
 * without regard to case on macOS and Windows. A Codex card whose input is the
 * placeholder Codex shows when it does not know the real input is refused,
 * since the owner would sign an input that is not the one that runs.
 *
 * `Bash` and `Shell` cannot be classified from their text: a command can do
 * anything. They are allowed because each is a one-shot the owner reads in
 * full on the approve page before signing, never a standing permission.
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

/** Tools whose web approval is a single run of exactly what the owner read. */
const ONE_SHOT_TOOLS = new Set(['Bash', 'WebFetch', 'WebSearch', 'Shell']);

/** Claude Code file tools, by the input field naming the file they change. */
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Folders whose contents decide what an agent harness may do (`.claude*` by prefix). */
const SETTINGS_FOLDERS = new Set(['.dork', '.codex', '.opencode', '.agents']);

/** Files that configure a harness wherever they sit. */
const SETTINGS_FILES = new Set(['opencode.json', 'opencode.jsonc', '.mcp.json']);

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
  /** Compare without regard to case; defaults to true on macOS and Windows. */
  caseInsensitive?: boolean;
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
  if (raw.split(/[\\/]/).includes('..')) return false;
  if (!path.isAbsolute(raw) && context.cwd === null) return false;
  const fold =
    (context.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32'))
      ? (text: string) => text.toLowerCase()
      : (text: string) => text;
  const target = fold(realOrResolved(path.resolve(context.cwd ?? '/', raw)));
  const parts = target.split(path.sep);
  if (parts.some((part) => part.startsWith('.claude') || SETTINGS_FOLDERS.has(part))) return false;
  if (SETTINGS_FILES.has(path.basename(target))) return false;
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

/** Whether a Codex patch names at least one change, and only changes to allowed files. */
function patchAllowed(card: PendingApprovalCard, context: RelayApprovableContext): boolean {
  // A patch that also asks for a write root would widen where Codex may write.
  if (card.blockedPath !== undefined) return false;
  const changes = inputObject(card)?.changes;
  if (!Array.isArray(changes) || changes.length === 0) return false;
  return changes.every(
    (change: unknown) =>
      change !== null &&
      typeof change === 'object' &&
      targetAllowed((change as Record<string, unknown>).path, context)
  );
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
  if (card.toolName === 'ApplyPatch') return patchAllowed(card, context);
  const field = FILE_TOOLS[card.toolName];
  return field !== undefined && targetAllowed(inputObject(card)?.[field], context);
}
