/**
 * The lineage query (W3, DOR-4969): a chat's ancestors, and its whole subtree
 * with each chat's depth, from the chats it started down to any depth.
 *
 * It reads two records of "this chat started that one" and merges them:
 *
 * - the work graph's `started` links (DOR-5263), which name the child by the
 *   id it was given before launch, so each is followed through `rekeyed_from`
 *   to the id the chat has now;
 * - `session_started_by`, which every start since spec `flow-multiproject`
 *   wrote, so a chat started before DOR-5263 still has its parent. Its rows
 *   follow a re-key themselves.
 *
 * A carry to another account writes no `started` link: it is a move, not a
 * start. Its `session_started_by` row (`carried`) is what the query follows, so
 * everything the successor starts stays in the tree. The successor hangs under
 * the chat it continues, marked `via: 'carried'`.
 *
 * **The one join.** This query is the only place a reader learns which started
 * chats to show, and how (`./lineage-reads.ts`, `statesOf`). The chat list's
 * tree and the read tools (W4, W5) read through here and do not repeat it. A
 * chat is shown when it ran, when it is still launching, or when it never
 * started but has a run that says why; a chat with neither a binding nor any
 * run is left out, never shown as a bare id. The one exception is a chat the
 * tree passes through: one with a shown child below the asked chat, or a
 * parent above it. With neither a binding nor any run, it is shown as
 * `unknown` (it cannot be opened), and the walk goes on through it, up and
 * down alike. A chat the join can place keeps its real state.
 *
 * A chat on another computer (`specs/space-computer-contract`) is not
 * recorded in this computer's `session_metadata`, so the join asks the run
 * record first. When the work graph moves to the space store (DOR-5139), its
 * binding and run reads go over the contract.
 *
 * **Bounded.** Each level of the tree is read in a few batched queries,
 * whatever its width. A walk visits a chat once, so a loop in the records
 * ends it. It goes at most {@link LINEAGE_MAX_DEPTH} levels and visits at
 * most {@link LINEAGE_MAX_VISITED} chats, and an answer holds at most
 * {@link LINEAGE_MAX_CHATS} shown chats. `truncated` says when a bound left
 * chats out. A read for one reader (`readable`, the W4 tree) leaves out the
 * chats that reader may not read before it counts, keeping one only as a
 * joint above a chat it may read, so the cap and `truncated` say nothing of
 * the rest.
 *
 * @module services/work-graph/chat-lineage
 */
import {
  LineageReads,
  type LineageReadsDeps,
  type LineageState,
  type LineageVia,
} from './lineage-reads.js';

export type { LineageState, LineageVia } from './lineage-reads.js';

/** The deepest any lineage walk goes, up or down, whatever a caller asks. */
export const LINEAGE_MAX_DEPTH = 64;

/**
 * The most shown chats one answer holds below the asked chat. Only shown
 * chats count: one left out takes no place. A capped answer keeps the
 * shallowest levels first and, within a level, the oldest starts first, so a
 * kept chat's parent is always kept too; `truncated` is then true.
 */
export const LINEAGE_MAX_CHATS = 500;

/**
 * The most chats one read walks below the asked chat, shown or not: the cost
 * bound, so one call can never hold the event loop for long. Left-out chats
 * are rare (a start cancelled before it ran), so a walk this long nearly
 * always fills {@link LINEAGE_MAX_CHATS}; when it stops first, `truncated`
 * is true.
 */
export const LINEAGE_MAX_VISITED = 4 * LINEAGE_MAX_CHATS;

/** One chat above the asked one. */
export interface LineageAncestor {
  /** The chat, by the id it has now. */
  chatId: string;
  /** How many steps up: 1 is the chat that started (or was carried into) the asked one. */
  depth: number;
  /** How the chat one step below came from this one. */
  via: LineageVia;
  /** What a reader may show of it: its real state, or `unknown` when only a start record proves it. */
  state: LineageState;
}

/** One chat below the asked one. */
export interface LineageDescendant {
  /** The chat, by the id it has now. */
  chatId: string;
  /** The chat it hangs under, by the id that chat has now. */
  parentId: string;
  /** How many steps down: 1 is a chat the asked one started or was carried to. */
  depth: number;
  /** How it came from its parent. */
  via: LineageVia;
  /** What a reader may show of it. */
  state: LineageState;
}

/** A chat's place in the tree of chats that started each other. */
export interface ChatLineage {
  /** The asked chat, by the id it has now. */
  chatId: string;
  /** What a reader may show of the asked chat. */
  state: LineageState;
  /** Nearest first, up to the chat nothing started. */
  ancestors: LineageAncestor[];
  /** Depth first: each chat followed by its own subtree, siblings oldest first. */
  descendants: LineageDescendant[];
  /**
   * True when a bound left chats out: more than {@link LINEAGE_MAX_CHATS}
   * were shown, or {@link LINEAGE_MAX_DEPTH} or {@link LINEAGE_MAX_VISITED}
   * stopped the walk down with chats left to visit. Never for a depth the
   * caller asked.
   */
  truncated: boolean;
}

/** What {@link ChatLineageReader} reads. */
export type ChatLineageDeps = LineageReadsDeps;

/** How far a lineage read goes, and for whom. */
export interface ChatLineageOptions {
  /** How many levels of descendants: 1 for the chats it started itself. Default: all of them. */
  depth?: number;
  /**
   * The chats among these the reader may read. Given, a chat below the asked
   * one that the reader may not read is kept only when one it may read hangs
   * below it (a joint), and the cap and `truncated` count only the chats kept,
   * so neither says anything of the ones left out (Security, DOR-4970). Left
   * out, every chat counts as readable: the answer is the unfiltered one.
   */
  readable?: (chatIds: readonly string[]) => ReadonlySet<string>;
}

/** One chat found walking down, before the join. */
interface Visited {
  chatId: string;
  parentId: string;
  depth: number;
  via: LineageVia;
  at: string;
}

/** A chat the tree passes through that only a start record proves. */
const UNKNOWN: LineageState = { kind: 'unknown' };

/** Reads a chat's lineage. See the module documentation. */
export class ChatLineageReader {
  private readonly reads: LineageReads;

  /**
   * Build the reader over its stores.
   *
   * @param deps - The database, the edge store and, when wired, the parent rows and the run record.
   */
  constructor(deps: ChatLineageDeps) {
    this.reads = new LineageReads(deps);
  }

  /**
   * A chat's ancestors and its subtree, with depth.
   *
   * @param chatId - The chat, by any id it has had.
   * @param opts - How many levels of descendants (all by default), and for whom.
   * @returns The lineage, or `null` when the chat has neither a binding nor a
   *   run, and nothing it started is shown.
   */
  read(chatId: string, opts: ChatLineageOptions = {}): ChatLineage | null {
    const id = this.reads.current([chatId]).get(chatId) ?? chatId;
    const { visited, states, stopped, open } = this.walkDown(
      id,
      opts.depth ?? Infinity,
      opts.readable
    );
    // Children before parents: a chat the join leaves out, with a shown child, is
    // unknown; one the reader may not read is kept only with a shown child.
    const shown = new Map<string, LineageState>();
    const hasShownChild = new Set<string>();
    for (const chat of [...visited].reverse()) {
      const state =
        states.get(chat.chatId) ?? (hasShownChild.has(chat.chatId) ? UNKNOWN : undefined);
      if (!state) continue;
      if (open && !open.has(chat.chatId) && !hasShownChild.has(chat.chatId)) continue;
      shown.set(chat.chatId, state);
      hasShownChild.add(chat.parentId);
    }
    const state = this.reads.statesOf([id]).get(id) ?? (hasShownChild.has(id) ? UNKNOWN : null);
    if (!state) return null;
    // `visited` is shallowest first and oldest first within a level, so the
    // first shown chats in it are the ones a capped answer keeps, and a kept
    // chat's parent (shown, one level up) is always among them.
    const kept = new Map(
      visited
        .filter((chat) => shown.has(chat.chatId))
        .slice(0, LINEAGE_MAX_CHATS)
        .map((chat) => [chat.chatId, shown.get(chat.chatId)!])
    );
    return {
      chatId: id,
      state,
      ancestors: this.walkUp(id),
      descendants: depthFirst(id, visited, kept),
      truncated: stopped || kept.size < shown.size,
    };
  }

  /**
   * Every chat under `root`, level by level, each under the parent the records
   * name, with what the join says of it. It stops early, `stopped`, at a bound
   * with chats left to visit: {@link LINEAGE_MAX_DEPTH},
   * {@link LINEAGE_MAX_VISITED}, or once every level but the last one walked
   * already holds {@link LINEAGE_MAX_CHATS} shown chats between them, so
   * nothing deeper could take a place. That last level is still walked, so its
   * shown chats can show the hidden ones above them. With `readable`, only the
   * chats the reader may read count toward that, and `open` holds them.
   */
  private walkDown(
    root: string,
    asked: number,
    readable: ChatLineageOptions['readable']
  ): {
    visited: Visited[];
    states: Map<string, LineageState | null>;
    stopped: boolean;
    open: Set<string> | null;
  } {
    const visited: Visited[] = [];
    const states = new Map<string, LineageState | null>();
    const open = readable ? new Set<string>() : null;
    const seen = new Set([root]);
    let frontier = [root];
    let shownAbove = 0;
    let shownInLast = 0;
    const done = (stopped: boolean) => ({ visited, states, stopped, open });
    for (let depth = 1; frontier.length > 0 && depth <= asked; depth += 1) {
      const inFrontier = new Set(frontier);
      const candidates = this.reads.candidatesUnder(frontier).filter((id) => !seen.has(id));
      const parents = this.reads.parentsOf(candidates);
      const level = candidates
        .flatMap((chatId) => {
          const parent = parents.get(chatId);
          // Hung only under the parent the records name, as `walkUp` reads it.
          return parent && inFrontier.has(parent.chatId)
            ? [{ chatId, parentId: parent.chatId, depth, via: parent.via, at: parent.at }]
            : [];
        })
        .sort(byStart);
      if (level.length === 0) break;
      if (depth > LINEAGE_MAX_DEPTH || shownAbove >= LINEAGE_MAX_CHATS) return done(true);
      const taken = level.slice(0, LINEAGE_MAX_VISITED - visited.length);
      const joined = this.reads.statesOf(taken.map((chat) => chat.chatId));
      const openHere = readable?.(taken.map((chat) => chat.chatId));
      for (const id of openHere ?? []) open?.add(id);
      for (const chat of taken) {
        seen.add(chat.chatId);
        visited.push(chat);
        states.set(chat.chatId, joined.get(chat.chatId) ?? null);
      }
      shownAbove += shownInLast;
      shownInLast = taken.filter(
        (chat) => joined.get(chat.chatId) && (!openHere || openHere.has(chat.chatId))
      ).length;
      if (taken.length < level.length) return done(true);
      frontier = taken.map((chat) => chat.chatId);
    }
    return done(false);
  }

  /**
   * The chats above `chatId`, nearest first, each with the state the join
   * gives it. A parent with neither a binding nor any run is `unknown`, and
   * the walk goes on through it.
   */
  private walkUp(chatId: string): LineageAncestor[] {
    const found: LineageAncestor[] = [];
    const seen = new Set([chatId]);
    let current = chatId;
    for (let depth = 1; depth <= LINEAGE_MAX_DEPTH; depth += 1) {
      const parent = this.reads.parentsOf([current]).get(current);
      if (parent === undefined || seen.has(parent.chatId)) break;
      seen.add(parent.chatId);
      const state = this.reads.statesOf([parent.chatId]).get(parent.chatId) ?? UNKNOWN;
      found.push({ chatId: parent.chatId, depth, via: parent.via, state });
      current = parent.chatId;
    }
    return found;
  }
}

/** Siblings oldest first, by when each start was recorded; ties by id. */
function byStart(a: { at: string; chatId: string }, b: { at: string; chatId: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}

/** The shown chats under `root`, each followed by its own subtree. */
function depthFirst(
  root: string,
  visited: readonly Visited[],
  shown: ReadonlyMap<string, LineageState>
): LineageDescendant[] {
  const children = new Map<string, Visited[]>();
  for (const chat of visited) {
    if (!shown.has(chat.chatId)) continue;
    children.set(chat.parentId, [...(children.get(chat.parentId) ?? []), chat]);
  }
  const out: LineageDescendant[] = [];
  const visit = (parentId: string): void => {
    for (const chat of children.get(parentId) ?? []) {
      const { chatId, depth, via } = chat;
      out.push({ chatId, parentId, depth, via, state: shown.get(chatId)! });
      visit(chatId);
    }
  };
  visit(root);
  return out;
}
