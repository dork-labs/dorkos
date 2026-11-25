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
 * run is left out, never shown as a bare id. A chat with a shown child is
 * shown too: it started that child, so it ran, whatever the join could find.
 * Every ancestor of a shown chat is shown for the same reason.
 *
 * A chat on another computer (`specs/space-computer-contract`) is not
 * recorded in this computer's `session_metadata`, so the join asks the run
 * record first. When the work graph moves to the space store (DOR-5139), its
 * binding and run reads go over the contract.
 *
 * **Bounded.** Each level of the tree is read in a few batched queries,
 * whatever its width. A walk visits a chat once, so a loop in the records
 * ends it; it goes at most {@link LINEAGE_MAX_DEPTH} levels and visits at
 * most {@link LINEAGE_MAX_CHATS} chats, and says when a bound stopped it.
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
 * The most chats one lineage read visits below the asked chat. A tree wider
 * or deeper than this is cut off there, oldest first, and the answer says so
 * (`truncated`), so one call can never hold the event loop for long.
 */
export const LINEAGE_MAX_CHATS = 500;

/** One chat above the asked one. */
export interface LineageAncestor {
  /** The chat, by the id it has now. */
  chatId: string;
  /** How many steps up: 1 is the chat that started (or was carried into) the asked one. */
  depth: number;
  /** How the chat one step below came from this one. */
  via: LineageVia;
  /** What a reader may show of it: always a chat, since it started one that is shown. */
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
   * True when {@link LINEAGE_MAX_CHATS} or {@link LINEAGE_MAX_DEPTH} stopped
   * the walk down with chats left to visit; never for a depth the caller asked.
   */
  truncated: boolean;
}

/** What {@link ChatLineageReader} reads. */
export type ChatLineageDeps = LineageReadsDeps;

/** How far a lineage read goes. */
export interface ChatLineageOptions {
  /** How many levels of descendants: 1 for the chats it started itself. Default: all of them. */
  depth?: number;
}

/** One chat found walking down, before the join. */
interface Visited {
  chatId: string;
  parentId: string;
  depth: number;
  via: LineageVia;
  at: string;
}

const SHOWN_CHAT: LineageState = { kind: 'chat' };

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
   * @param opts - How many levels of descendants; all by default.
   * @returns The lineage, or `null` when the chat has neither a binding nor a
   *   run, and nothing it started is shown.
   */
  read(chatId: string, opts: ChatLineageOptions = {}): ChatLineage | null {
    const id = this.reads.current([chatId]).get(chatId) ?? chatId;
    const { visited, truncated } = this.walkDown(id, opts.depth ?? Infinity);
    const states = this.reads.statesOf([id, ...visited.map((chat) => chat.chatId)]);
    // Children before parents: a chat with a shown child is shown as a chat.
    const shown = new Map<string, LineageState>();
    const hasShownChild = new Set<string>();
    for (const chat of [...visited].reverse()) {
      const state = hasShownChild.has(chat.chatId) ? SHOWN_CHAT : states.get(chat.chatId);
      if (!state) continue;
      shown.set(chat.chatId, state);
      hasShownChild.add(chat.parentId);
    }
    const state = hasShownChild.has(id) ? SHOWN_CHAT : states.get(id);
    if (!state) return null;
    return {
      chatId: id,
      state,
      ancestors: this.walkUp(id),
      descendants: depthFirst(id, visited, shown),
      truncated,
    };
  }

  /** Every chat under `root`, level by level, each under the parent the records name. */
  private walkDown(root: string, asked: number): { visited: Visited[]; truncated: boolean } {
    const visited: Visited[] = [];
    const seen = new Set([root]);
    let frontier = [root];
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
      if (level.length > 0 && depth > LINEAGE_MAX_DEPTH) return { visited, truncated: true };
      for (const chat of level) {
        if (visited.length >= LINEAGE_MAX_CHATS) return { visited, truncated: true };
        seen.add(chat.chatId);
        visited.push(chat);
      }
      frontier = level.map((chat) => chat.chatId);
    }
    return { visited, truncated: false };
  }

  /** The chats above `chatId`, nearest first. */
  private walkUp(chatId: string): LineageAncestor[] {
    const found: LineageAncestor[] = [];
    const seen = new Set([chatId]);
    let current = chatId;
    for (let depth = 1; depth <= LINEAGE_MAX_DEPTH; depth += 1) {
      const parent = this.reads.parentsOf([current]).get(current);
      if (parent === undefined || seen.has(parent.chatId)) break;
      seen.add(parent.chatId);
      // It started (or was carried into) a shown chat, so it ran.
      found.push({ chatId: parent.chatId, depth, via: parent.via, state: SHOWN_CHAT });
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
