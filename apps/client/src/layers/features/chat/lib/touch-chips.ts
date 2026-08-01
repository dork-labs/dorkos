/**
 * Touch chips — one chip per thing an assistant turn touched.
 *
 * Folds a message's `MessagePart[]` into a deduplicated roster of the files,
 * URLs, and commands the agent handled, so the turn keeps a record of its own
 * work after the individual tool cards auto-hide.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **Append-then-merge, never track-latest.** Every tool call is folded into
 *    the accumulator; a chip's counters and history only ever grow. Dedup that
 *    works by remembering "the current state of file X" silently drops real
 *    edits when events interleave (Cursor ships that bug), so this never
 *    overwrites a chip — it merges into it.
 * 2. **Pure and derived-on-render.** No DOM, no React, no parallel store. Chips
 *    are a function of the transcript, so replay and hydration can never
 *    disagree with what is on screen.
 *
 * @module features/chat/lib/touch-chips
 */
import type { MessagePart } from '@dorkos/shared/types';
import {
  basename,
  editDiffstat,
  formatDiffstat,
  grepHits,
  multiEditDiffstat,
  normalizePath,
  normalizeUrl,
  parseDeletedPaths,
  parseToolInput,
  readString,
  urlLabel,
  type Diffstat,
} from './touch-chip-parsers';

/** What kind of thing a chip points at — decides how a click opens it. */
export type TouchChipKind = 'file' | 'url' | 'command';

/** What the agent did to the target. Drives the icon and the verb animation. */
export type TouchChipVerb = 'read' | 'search' | 'edit' | 'create' | 'delete' | 'fetch' | 'run';

/** One unique target the turn touched, with everything that happened to it folded in. */
export interface TouchChip {
  /**
   * Stable identity of the target, namespaced by target space (`file:`, `url:`,
   * `run:`, …). The namespace is what keeps a Bash command that happens to read
   * like a path from merging with a file of that name, and a `Grep` for "todo"
   * from merging with a `WebSearch` for the same word.
   */
  key: string;
  /** File, URL, or bare command — the click behaviour follows from this. */
  kind: TouchChipKind;
  /** Short display name: basename, domain, or the command itself. */
  label: string;
  /** Full path / URL / command — the tooltip text and the canvas open target. */
  fullTarget: string;
  /** Highest-precedence verb this target has seen (`delete` > `create` > `edit` > rest). */
  verb: TouchChipVerb;
  /** Whether any contributing tool call is still pending or running. */
  live: boolean;
  /** Whether any contributing tool call failed. Sticky — a later success never clears it. */
  error: boolean;
  /** How many tool calls folded into this chip (the `×N` badge). */
  touches: number;
  /** Lines added across every edit to this target. Absent when nothing reported a diffstat. */
  additions?: number;
  /** Lines removed across every edit to this target. Absent when nothing reported a diffstat. */
  deletions?: number;
  /** Set once, the first time a read target becomes an edited one — drives the morph. */
  upgraded?: boolean;
  /** Index of the part that first touched this target (default chip order). */
  firstSeq: number;
  /** Index of the part that most recently touched it (the chronological lens). */
  lastSeq: number;
  /** One human-readable entry per touch, oldest first — the tooltip's audit trail. */
  history: string[];
}

/**
 * Verb precedence. A chip's verb only ever climbs: a file that is read and then
 * edited stays "edited" however many times it is read afterwards. Verbs that
 * describe no mutation share the bottom rank, so between them the first one
 * wins.
 */
const VERB_RANK: Record<TouchChipVerb, number> = {
  delete: 3,
  create: 2,
  edit: 1,
  read: 0,
  search: 0,
  fetch: 0,
  run: 0,
};

/**
 * Tools that get no chip in v1: subagent dispatch and the todo list are about
 * the agent's own bookkeeping, not about something it touched. MCP tools are
 * excluded by prefix below — their targets are server-defined and unmappable.
 */
const EXCLUDED_TOOLS = new Set(['Task', 'Agent', 'TodoWrite']);

/** A single tool call's contribution to one chip, before it is merged. */
interface Touch {
  /** Namespaced target identity — see {@link TouchChip.key}. */
  key: string;
  /** File, URL, or bare command. */
  kind: TouchChipKind;
  /** Short display name for the chip. */
  label: string;
  /** Full path / URL / command. */
  fullTarget: string;
  /** What this one tool call did to the target. */
  verb: TouchChipVerb;
  /** History line for this one touch, e.g. `edited +12 −4`. */
  entry: string;
  /** Lines this one touch added, when it reported a diffstat. */
  additions?: number;
  /** Lines this one touch removed, when it reported a diffstat. */
  deletions?: number;
}

/** Build a file touch from a path, with the label and key every file chip shares. */
function fileTouch(path: string, verb: TouchChipVerb, entry: string, stat?: Diffstat): Touch {
  const target = normalizePath(path);
  return {
    key: `file:${target}`,
    kind: 'file',
    label: basename(target),
    fullTarget: target,
    verb,
    entry,
    additions: stat?.additions,
    deletions: stat?.deletions,
  };
}

/**
 * Everything one tool call contributes. Usually one touch; a `Bash` call that
 * deletes files contributes the command plus one file touch per deleted path.
 * An unmapped or excluded tool contributes nothing.
 */
function deriveTouches(part: Extract<MessagePart, { type: 'tool_call' }>): Touch[] {
  const { toolName } = part;
  if (EXCLUDED_TOOLS.has(toolName) || toolName.startsWith('mcp__')) return [];

  const input = parseToolInput(part.input);
  if (!input) return [];

  switch (toolName) {
    case 'Read': {
      const path = readString(input, 'file_path');
      return path ? [fileTouch(path, 'read', 'read')] : [];
    }
    case 'Glob': {
      const pattern = readString(input, 'pattern');
      if (!pattern) return [];
      return [
        {
          key: `file:${pattern}`,
          kind: 'file',
          label: pattern,
          fullTarget: pattern,
          verb: 'read',
          entry: 'globbed',
        },
      ];
    }
    case 'Grep': {
      const pattern = readString(input, 'pattern');
      if (!pattern) return [];
      const hits = grepHits(part.result);
      return [
        {
          key: `grep:${pattern}`,
          kind: 'command',
          label: `"${pattern}"`,
          fullTarget: pattern,
          verb: 'search',
          entry: hits === undefined ? 'searched' : `searched (${hits} hits)`,
        },
      ];
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      // NotebookEdit names its target `notebook_path`; the other two use
      // `file_path`. Both are accepted so a notebook still gets a chip.
      const path = readString(input, 'file_path') ?? readString(input, 'notebook_path');
      if (!path) return [];
      const stat = toolName === 'MultiEdit' ? multiEditDiffstat(input) : editDiffstat(input);
      return [fileTouch(path, 'edit', `edited${formatDiffstat(stat)}`, stat)];
    }
    case 'Write': {
      const path = readString(input, 'file_path');
      if (!path) return [];
      // Claude Code's Write result says "File created successfully at: …" for a
      // new file and phrases an overwrite differently, so the word "created" is
      // what separates the two. Runtime-specific phrasing: a runtime that words
      // it differently degrades to `edit`, which is the safer of the two reads.
      const created = /created/i.test(part.result ?? '');
      return [fileTouch(path, created ? 'create' : 'edit', created ? 'created' : 'wrote')];
    }
    case 'Bash': {
      const command = readString(input, 'command');
      if (!command) return [];
      const touches: Touch[] = [
        {
          key: `run:${command}`,
          kind: 'command',
          label: command,
          fullTarget: command,
          verb: 'run',
          entry: 'ran',
        },
      ];
      for (const path of parseDeletedPaths(command)) {
        touches.push(fileTouch(path, 'delete', 'deleted'));
      }
      return touches;
    }
    case 'WebFetch': {
      const url = readString(input, 'url');
      if (!url) return [];
      return [
        {
          key: `url:${normalizeUrl(url)}`,
          kind: 'url',
          label: urlLabel(url),
          fullTarget: url,
          verb: 'fetch',
          entry: 'fetched',
        },
      ];
    }
    case 'WebSearch': {
      const query = readString(input, 'query');
      if (!query) return [];
      return [
        {
          key: `websearch:${query}`,
          kind: 'command',
          label: `🔍 ${query}`,
          fullTarget: query,
          verb: 'search',
          entry: 'searched the web',
        },
      ];
    }
    default:
      return [];
  }
}

/** Fold one touch into the roster, creating its chip or merging into the existing one. */
function fold(
  chips: Map<string, TouchChip>,
  touch: Touch,
  seq: number,
  live: boolean,
  error: boolean
): void {
  const existing = chips.get(touch.key);

  if (!existing) {
    chips.set(touch.key, {
      key: touch.key,
      kind: touch.kind,
      label: touch.label,
      fullTarget: touch.fullTarget,
      verb: touch.verb,
      live,
      error,
      touches: 1,
      additions: touch.additions,
      deletions: touch.deletions,
      firstSeq: seq,
      lastSeq: seq,
      history: [touch.entry],
    });
    return;
  }

  existing.touches += 1;
  existing.lastSeq = seq;
  existing.live = existing.live || live;
  existing.error = existing.error || error;
  existing.history.push(touch.entry);

  if (touch.additions !== undefined) {
    existing.additions = (existing.additions ?? 0) + touch.additions;
  }
  if (touch.deletions !== undefined) {
    existing.deletions = (existing.deletions ?? 0) + touch.deletions;
  }

  // The read→edit morph fires exactly once: by the time a second edit lands the
  // chip's verb is already `edit`, so this branch cannot be re-entered.
  if (existing.verb === 'read' && touch.verb === 'edit') {
    existing.upgraded = true;
  }
  if (VERB_RANK[touch.verb] > VERB_RANK[existing.verb]) {
    existing.verb = touch.verb;
  }
}

/**
 * Fold a message's parts into one chip per unique target.
 *
 * Returns chips in **first-touch order**. Callers that want the chronological
 * lens or a kind grouping sort the result themselves — the tray's order toggle
 * is a view, not a second derivation.
 *
 * @param parts - The assistant message's parts, in transcript order.
 * @returns The deduplicated roster of everything the turn touched.
 */
export function accumulateTouchChips(parts: MessagePart[]): TouchChip[] {
  const chips = new Map<string, TouchChip>();

  parts.forEach((part, seq) => {
    if (part.type !== 'tool_call') return;
    const live = part.status === 'pending' || part.status === 'running';
    const error = part.status === 'error';
    for (const touch of deriveTouches(part)) {
      fold(chips, touch, seq, live, error);
    }
  });

  // Map iteration is insertion-ordered, and a chip is inserted the first time
  // its target is touched — so this is already ascending `firstSeq`.
  return [...chips.values()];
}
