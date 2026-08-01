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
  commandLabel,
  editDiffstat,
  formatDiffstat,
  grepHits,
  multiEditDiffstat,
  normalizePath,
  normalizeUrl,
  parseDeletedPaths,
  parseToolInput,
  pathsAlias,
  readString,
  urlLabel,
  writtenLines,
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
  /** Short display name: basename, domain, or a command's first line, truncated. */
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
  /**
   * Lines this target gained. Edits contribute what they changed; a file that
   * was created contributes its whole length, because all of it is new. Absent
   * when nothing reported a count.
   */
  additions?: number;
  /**
   * Lines this target lost, across every edit to it. Absent when nothing
   * reported a count — a created file has additions and no deletions, which is
   * why the two are counted separately rather than as one diffstat.
   */
  deletions?: number;
  /**
   * Matches found across every search of this target (the `N hits` badge).
   * Absent when no result could be read confidently.
   */
  hits?: number;
  /**
   * Set when the target names a set of files rather than one — a glob pattern.
   * A pattern has nothing single to open, so its chip is a record instead of a
   * control. An explicit flag rather than a guess at the string: `index.ts` is
   * a valid glob and a valid path, and only the tool that produced it knows
   * which one it meant.
   */
  pattern?: boolean;
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
  /** Lines this one touch added, when it reported a count. */
  additions?: number;
  /** Lines this one touch removed, when it reported a count. */
  deletions?: number;
  /** Matches this one search found, when its result could be read. */
  hits?: number;
  /** Whether this touch named a set of files rather than one. */
  pattern?: boolean;
}

/** `1 hit` / `14 hits` — the badge text, the spoken one, and the history line, from one place. */
export function hitsLabel(hits: number): string {
  return hits === 1 ? '1 hit' : `${hits} hits`;
}

/**
 * Shell metacharacters that make a word name a SET of files rather than one.
 *
 * `rm build/*.js` deleted whatever the glob matched, and nobody on this side
 * knows what that was — so the chip is a record of the command, not a link to a
 * file called `*.js`. `~` and `$` are here for the same reason: the shell
 * expanded them, and this did not.
 */
const GLOB_CHARS = /[*?[\]~$]/;

/**
 * Build a file touch from a path, with the label and key every file chip shares.
 *
 * The counts are partial because a create has additions and nothing else: the
 * chip shows `+86` rather than `+86 −0`, and a zero it never measured is not a
 * number it should print.
 *
 * A `pattern` touch names a set, so it is labelled with the whole pattern: the
 * basename of `build/*.js` is `*.js`, which reads as a file nobody has.
 */
function fileTouch(
  path: string,
  verb: TouchChipVerb,
  entry: string,
  stat?: Partial<Diffstat>,
  pattern?: boolean
): Touch {
  const target = normalizePath(path);
  return {
    key: `file:${target}`,
    kind: 'file',
    label: pattern === true ? target : basename(target),
    fullTarget: target,
    verb,
    entry,
    additions: stat?.additions,
    deletions: stat?.deletions,
    pattern: pattern === true ? true : undefined,
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
          pattern: true,
        },
      ];
    }
    case 'Grep': {
      const pattern = readString(input, 'pattern');
      if (!pattern) return [];
      // A grep that failed found nothing it can report — whatever text came
      // back is an error message, and counting its lines would badge the chip
      // with a number of matches that never existed.
      const hits = part.status === 'error' ? undefined : grepHits(part.result);
      return [
        {
          key: `grep:${pattern}`,
          kind: 'command',
          label: `"${pattern}"`,
          fullTarget: pattern,
          verb: 'search',
          entry: hits === undefined ? 'searched' : `searched (${hitsLabel(hits)})`,
          hits,
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
      if (!created) return [fileTouch(path, 'edit', 'wrote')];

      // Every line of a new file is a new line, so a create carries additions
      // and no deletions — `✚ name +86`, the settled form the design asks for.
      const content = readString(input, 'content');
      const stat = content === undefined ? undefined : { additions: writtenLines(content) };
      return [fileTouch(path, 'create', `created${stat ? ` +${stat.additions}` : ''}`, stat)];
    }
    case 'Bash': {
      const command = readString(input, 'command');
      if (!command) return [];
      const touches: Touch[] = [
        {
          // The whole command is the identity — two `pnpm test` runs are the
          // same command however long the script after them is — while the
          // label is only as much of it as a pill can carry.
          key: `run:${command}`,
          kind: 'command',
          label: commandLabel(command),
          fullTarget: command,
          verb: 'run',
          entry: 'ran',
        },
      ];
      for (const path of parseDeletedPaths(command)) {
        touches.push(fileTouch(path, 'delete', 'deleted', undefined, GLOB_CHARS.test(path)));
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
          // No glyph in the label: the chip renders the verb's own 🔍 beside it,
          // and two magnifiers on one pill read as a rendering bug.
          label: query,
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

/**
 * The chip a touch belongs to, which is not always the chip its own key names.
 *
 * Tools name a file by its full path and shells name it by where they are, so
 * one file arrives under two spellings in a single turn: `Read /repo/src/old.ts`
 * then `rm src/old.ts`. Folding those into two chips leaves a live link to a
 * file that is gone sitting next to its own tombstone. Patterns are excluded —
 * a glob names a set, and a set that ends in the same word as a file is still
 * not that file.
 */
function resolveKey(chips: Map<string, TouchChip>, touch: Touch): string {
  if (touch.kind !== 'file' || touch.pattern === true || chips.has(touch.key)) return touch.key;
  for (const chip of chips.values()) {
    if (chip.kind !== 'file' || chip.pattern === true) continue;
    if (pathsAlias(chip.fullTarget, touch.fullTarget)) return chip.key;
  }
  return touch.key;
}

/** Fold one touch into the roster, creating its chip or merging into the existing one. */
function fold(
  chips: Map<string, TouchChip>,
  touch: Touch,
  seq: number,
  live: boolean,
  error: boolean
): void {
  const key = resolveKey(chips, touch);
  const existing = chips.get(key);

  if (!existing) {
    chips.set(key, {
      key,
      kind: touch.kind,
      label: touch.label,
      fullTarget: touch.fullTarget,
      verb: touch.verb,
      live,
      error,
      touches: 1,
      additions: touch.additions,
      deletions: touch.deletions,
      hits: touch.hits,
      pattern: touch.pattern,
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
  // Hits accumulate like every other counter here. Two searches for one pattern
  // are usually two different searches — the same words asked of a different
  // directory — so their matches add up rather than replacing each other.
  if (touch.hits !== undefined) {
    existing.hits = (existing.hits ?? 0) + touch.hits;
  }
  // A target something reached by an exact path is a real file, whatever a glob
  // called it: one concrete touch is enough to make the chip openable again.
  if (!touch.pattern) {
    existing.pattern = undefined;
  }

  // The absolute spelling wins. A chip first seen as `src/a.ts` and later read
  // as `/repo/src/a.ts` is one file, and the full path is the one the canvas can
  // actually open — the key stays put so nothing above has to be re-sorted.
  if (
    existing.kind === 'file' &&
    existing.pattern !== true &&
    touch.fullTarget.startsWith('/') &&
    !existing.fullTarget.startsWith('/')
  ) {
    existing.fullTarget = touch.fullTarget;
    existing.label = basename(touch.fullTarget);
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

/** What a part parsed to last time, and the three fields that would change the answer. */
interface CachedTouches {
  /** The tool input this was parsed from. */
  input: string | undefined;
  /** The result text this was parsed from. */
  result: string | undefined;
  /** The status this was parsed under. */
  status: string | undefined;
  /** What it parsed to. Never mutated by the fold, so it is safe to hand out again. */
  touches: Touch[];
}

/**
 * Parsed touches, remembered per part.
 *
 * The fold is pure and runs on every render, and a render happens on every
 * stream frame — including each text delta, which changes nothing about any tool
 * call. Without this, a turn that wrote a 600-line file re-ran `JSON.parse` over
 * that file's whole content for every word the model then said.
 *
 * Keyed on the part OBJECT, which survives the array copies the stream makes,
 * and validated against the three fields a parse reads: parts are mutated in
 * place as a tool streams its input and lands its result, so object identity
 * alone would serve a chip parsed from half an input.
 *
 * A `WeakMap` so a closed session's parts are collectable.
 */
const TOUCH_CACHE = new WeakMap<Extract<MessagePart, { type: 'tool_call' }>, CachedTouches>();

/** The touches a part contributes, parsed once per distinct state of that part. */
function cachedTouches(part: Extract<MessagePart, { type: 'tool_call' }>): Touch[] {
  const cached = TOUCH_CACHE.get(part);
  if (
    cached &&
    cached.input === part.input &&
    cached.result === part.result &&
    cached.status === part.status
  ) {
    return cached.touches;
  }
  const touches = deriveTouches(part);
  TOUCH_CACHE.set(part, {
    input: part.input,
    result: part.result,
    status: part.status,
    touches,
  });
  return touches;
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
    for (const touch of cachedTouches(part)) {
      fold(chips, touch, seq, live, error);
    }
  });

  // Map iteration is insertion-ordered, and a chip is inserted the first time
  // its target is touched — so this is already ascending `firstSeq`.
  return [...chips.values()];
}
