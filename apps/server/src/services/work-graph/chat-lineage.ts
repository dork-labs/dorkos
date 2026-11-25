/**
 * The lineage query (W3, DOR-4969): a chat's ancestors, and its whole subtree
 * with each chat's depth, from the chats it started down to any depth.
 *
 * It reads two records of "this chat started that one" and merges them:
 *
 * - the work graph's `started` links (DOR-5263), which name the child by the
 *   id it was given before launch, so each is followed through `rekeyed_from`
 *   to the id the chat has now ({@link WorkLinkStore.resolveRekey});
 * - `session_started_by`, which every start since spec `flow-multiproject`
 *   wrote, so a chat started before DOR-5263 still has its parent. Its rows
 *   follow a re-key themselves.
 *
 * A carry to another account writes no `started` link: it is a move, not a
 * start. Its `session_started_by` row (`carried`) is what the query follows, so
 * everything the successor starts stays in the tree. The successor hangs under
 * the chat it continues, marked `via: 'carried'`.
 *
 * **The one join.** This is the only place a reader learns which of those
 * children to show, and how. A `started` link is written when the start is
 * recorded, and the table is append-only, so a start cancelled before its chat
 * ran keeps its link. Every child is joined against the chat and its run
 * record:
 *
 * - a child whose chat exists (bound to a runtime in `session_metadata`, the
 *   same test `sessionExists` makes first) is shown;
 * - else a child whose last run ended before it started is shown as never
 *   started, with the run's reason;
 * - else it is left out, with everything under it: never a bare id.
 *
 * The chat list's tree and the read tools (W4, W5) read through here and do
 * not repeat the join.
 *
 * Cycle-safe: a chat is visited once, so a loop in the records ends the walk,
 * and every walk is bounded by {@link LINEAGE_MAX_DEPTH}.
 *
 * @module services/work-graph/chat-lineage
 */
import { and, inArray, isNotNull, sessionMetadata, type Db } from '@dorkos/db';
import type { SessionStartedByStore } from '../session/origin/session-started-by-store.js';
import { RUN_ENDS, type RunStore, type TurnRun } from '../runs/index.js';
import { REKEY_MAX_DEPTH, type WorkLinkStore } from './work-link-store.js';

/** The deepest any lineage walk goes, up or down, whatever a caller asks. */
export const LINEAGE_MAX_DEPTH = 64;

/** How a chat came from the one above it: started by it, or carried on from it to another account. */
export type LineageVia = 'started' | 'carried';

/** What a reader may show of a chat in a lineage. */
export type LineageState =
  | { kind: 'chat' }
  | {
      kind: 'never-started';
      /** The run that ended before its turn started. */
      runId: string;
      /** Why: the run's `cancelledBecause`, else its ending, else its status. */
      reason: string;
    };

/** One chat above the asked one. */
export interface LineageAncestor {
  /** The chat, by the id it has now. */
  chatId: string;
  /** How many steps up: 1 is the chat that started (or was carried into) the asked one. */
  depth: number;
  /** How the chat one step below came from this one. */
  via: LineageVia;
  /** What a reader may show of it. */
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
}

/** What {@link ChatLineageReader} reads. */
export interface ChatLineageDeps {
  /** The DorkOS database: whether a chat exists (`session_metadata`). */
  db: Db;
  /** The work graph's edges: `started` and `rekeyed_from`. */
  links: WorkLinkStore;
  /** `session_started_by`, when wired. */
  startedBy?: SessionStartedByStore;
  /** The run record, when wired: why a chat that never ran did not. */
  runs?: Pick<RunStore, 'listForChat'>;
}

/** How far a lineage read goes. */
export interface ChatLineageOptions {
  /** How many levels of descendants: 1 for the chats it started itself. Default: all of them. */
  depth?: number;
}

/** One child of a chat, before the join. */
interface ChildEdge {
  chatId: string;
  via: LineageVia;
  /** When the start was recorded (ISO 8601), for oldest-first order. */
  at: string;
}

/** Reads a chat's lineage. See the module documentation. */
export class ChatLineageReader {
  /**
   * Build the reader over its stores.
   *
   * @param deps - The database, the edge store and, when wired, the parent rows and the run record.
   */
  constructor(private readonly deps: ChatLineageDeps) {}

  /**
   * A chat's ancestors and its subtree, with depth.
   *
   * @param chatId - The chat, by any id it has had.
   * @param opts - How many levels of descendants; all by default.
   * @returns The lineage, or `null` when the chat has neither a chat nor a run to show.
   */
  read(chatId: string, opts: ChatLineageOptions = {}): ChatLineage | null {
    const id = this.deps.links.resolveRekey(chatId);
    const state = this.stateOf(id);
    if (state === null) return null;
    const depth = Math.min(opts.depth ?? LINEAGE_MAX_DEPTH, LINEAGE_MAX_DEPTH);
    return {
      chatId: id,
      state,
      ancestors: this.ancestorsOf(id),
      descendants: this.descendantsOf(id, depth),
    };
  }

  /** The chats above `chatId`, nearest first, stopping at one that cannot be shown. */
  private ancestorsOf(chatId: string): LineageAncestor[] {
    const found: LineageAncestor[] = [];
    const seen = new Set([chatId]);
    let current = chatId;
    for (let depth = 1; depth <= LINEAGE_MAX_DEPTH; depth += 1) {
      const parent = this.parentOf(current);
      if (parent === null || seen.has(parent.chatId)) break;
      const state = this.stateOf(parent.chatId);
      if (state === null) break;
      seen.add(parent.chatId);
      found.push({ chatId: parent.chatId, depth, via: parent.via, state });
      current = parent.chatId;
    }
    return found;
  }

  /** The chats under `root`, depth first, down to `maxDepth` levels. */
  private descendantsOf(root: string, maxDepth: number): LineageDescendant[] {
    const found: LineageDescendant[] = [];
    const seen = new Set([root]);
    const visit = (parentId: string, depth: number): void => {
      if (depth > maxDepth) return;
      for (const child of this.childrenOf(parentId)) {
        if (seen.has(child.chatId)) continue;
        seen.add(child.chatId);
        const state = this.stateOf(child.chatId);
        if (state === null) continue;
        found.push({ chatId: child.chatId, parentId, depth, via: child.via, state });
        // A chat that never ran started nothing.
        if (state.kind === 'chat') visit(child.chatId, depth + 1);
      }
    };
    visit(root, 1);
    return found;
  }

  /** The chats one chat started or was carried to, by current id, oldest first. */
  private childrenOf(chatId: string): ChildEdge[] {
    const byId = new Map<string, ChildEdge>();
    const add = (edge: ChildEdge): void => {
      const known = byId.get(edge.chatId);
      if (known === undefined || edge.at < known.at) byId.set(edge.chatId, edge);
    };
    for (const alias of this.aliasesOf(chatId)) {
      for (const link of this.deps.links.from({ kind: 'chat', id: alias }, 'started')) {
        if (link.to.kind !== 'chat') continue;
        add({
          chatId: this.deps.links.resolveRekey(link.to.id),
          via: 'started',
          at: link.recordedAt,
        });
      }
    }
    const startedBy = this.deps.startedBy;
    if (startedBy) {
      const rows = startedBy.getMany(startedBy.childrenOf(chatId));
      for (const row of rows.values()) {
        add({
          chatId: this.deps.links.resolveRekey(row.sessionId),
          via: row.carried ? 'carried' : 'started',
          at: row.createdAt,
        });
      }
    }
    // A child's own id is never its parent, whatever a stray row says.
    byId.delete(chatId);
    return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  /** The chat that started `chatId` or was carried into it, by current id, or `null`. */
  private parentOf(chatId: string): { chatId: string; via: LineageVia } | null {
    const row = this.deps.startedBy?.get(chatId);
    if (row?.kind === 'chat' && row.startedBySessionId !== null) {
      return {
        chatId: this.deps.links.resolveRekey(row.startedBySessionId),
        via: row.carried ? 'carried' : 'started',
      };
    }
    for (const alias of this.aliasesOf(chatId)) {
      const link = this.deps.links.to({ kind: 'chat', id: alias }, 'started')[0];
      if (link?.from.kind === 'chat')
        return { chatId: this.deps.links.resolveRekey(link.from.id), via: 'started' };
    }
    return null;
  }

  /** `chatId` and every older id it replaced, through `rekeyed_from` (bounded, cycle-safe). */
  private aliasesOf(chatId: string): string[] {
    const aliases = [chatId];
    for (let i = 0; i < aliases.length && aliases.length <= REKEY_MAX_DEPTH; i += 1) {
      for (const link of this.deps.links.from({ kind: 'chat', id: aliases[i]! }, 'rekeyed_from')) {
        if (link.to.kind === 'chat' && !aliases.includes(link.to.id)) aliases.push(link.to.id);
      }
    }
    return aliases;
  }

  /** The join: what a reader may show of a chat, or `null` to leave it out. */
  private stateOf(chatId: string): LineageState | null {
    const ids = this.aliasesOf(chatId);
    const bound = this.deps.db
      .select({ sessionId: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(and(inArray(sessionMetadata.sessionId, ids), isNotNull(sessionMetadata.runtime)))
      .get();
    if (bound) return { kind: 'chat' };
    const run = this.lastRunOf(ids);
    if (run && RUN_ENDS.has(run.status) && run.startedAt === null) {
      return {
        kind: 'never-started',
        runId: run.id,
        reason: run.endingDetail.cancelledBecause ?? run.ending ?? run.status,
      };
    }
    return null;
  }

  /** The newest run kept under any of these ids. */
  private lastRunOf(ids: readonly string[]): TurnRun | undefined {
    const runs = this.deps.runs;
    if (!runs) return undefined;
    let last: TurnRun | undefined;
    for (const id of ids) {
      for (const run of runs.listForChat(id)) {
        if (last === undefined || run.createdAt >= last.createdAt) last = run;
      }
    }
    return last;
  }
}
