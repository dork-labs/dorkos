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
 * - Codex `Shell`, and Codex `ApplyPatch` that asks for no write root.
 *
 * Refused, whatever proof follows: every `mcp__*` tool (DorkOS's own and any
 * other server's), Codex `Permissions`, OpenCode `external_directory`, `Task`,
 * `Agent`, `ExitPlanMode`, and any name not on the list. A file tool whose
 * target sits in an agent harness's settings folder (`.claude/`, `.dork/`,
 * `.codex/`, `.opencode/`) or in DorkOS's data folder is refused too: writing
 * there changes what agents may do next. A Codex card whose input is the
 * placeholder Codex shows when it does not know the real input is refused,
 * since the owner would sign an input that is not the one that runs.
 *
 * `Bash` and `Shell` cannot be classified from their text: a command can do
 * anything. They are allowed because each is a one-shot the owner reads in
 * full on the approve page before signing, never a standing permission.
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

/** Folders whose contents decide what an agent harness may do. */
const SETTINGS_FOLDERS = new Set(['.claude', '.dork', '.codex', '.opencode']);

/**
 * The inputs Codex shows when the real one is unknown (`server-requests.ts`
 * in the Codex runtime): a card that holds one binds nothing.
 */
const CODEX_PLACEHOLDER_INPUTS: Record<string, string> = {
  Shell: '{}',
  ApplyPatch: JSON.stringify({ changes: [] }),
};

/** Where a file tool's target is judged from. */
export interface RelayApprovableContext {
  /** The chat's folder, which a relative path resolves against. */
  cwd: string | null;
  /** DorkOS's data folder. */
  dorkHome: string;
}

/** A path with every existing part's symlinks resolved, the rest appended as written. */
function realOrResolved(target: string): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
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

/** Whether a file tool's target is somewhere the web may write. */
function fileTargetAllowed(
  card: PendingApprovalCard,
  field: string,
  context: RelayApprovableContext
): boolean {
  let input: unknown;
  try {
    input = JSON.parse(card.input);
  } catch {
    return false;
  }
  const raw = (input as Record<string, unknown> | null)?.[field];
  if (typeof raw !== 'string' || raw === '') return false;
  if (!path.isAbsolute(raw) && context.cwd === null) return false;
  const target = realOrResolved(path.resolve(context.cwd ?? '/', raw));
  if (target.split(path.sep).some((part) => SETTINGS_FOLDERS.has(part))) return false;
  const home = path.resolve(context.dorkHome);
  return !isWithin(target, home) && !isWithin(target, realOrResolved(home));
}

/**
 * Whether a pending tool approval may be answered from the web. Checked when
 * a challenge is issued and again when the signed answer arrives.
 *
 * @param card - The pending tool approval, as the chat holds it now.
 * @param context - The chat's folder and DorkOS's data folder.
 * @returns True only for a tool on the list, with a real input and an allowed target.
 */
export function relayApprovableCard(
  card: PendingApprovalCard,
  context: RelayApprovableContext
): boolean {
  const placeholder = CODEX_PLACEHOLDER_INPUTS[card.toolName];
  if (placeholder !== undefined && card.input === placeholder) return false;
  if (ONE_SHOT_TOOLS.has(card.toolName)) return true;
  // A patch that also asks for a write root would widen where Codex may write.
  if (card.toolName === 'ApplyPatch') return card.blockedPath === undefined;
  const field = FILE_TOOLS[card.toolName];
  return field !== undefined && fileTargetAllowed(card, field, context);
}
