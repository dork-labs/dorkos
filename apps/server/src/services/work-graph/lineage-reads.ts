/**
 * The lineage query's batched reads (W3, DOR-4969): every read takes a whole
 * level of chats at once, so walking a tree costs a few queries per level,
 * never a few per chat. `./chat-lineage.ts` walks the tree with them.
 *
 * **What is shown (the one join).** {@link LineageReads.statesOf} is the only
 * place a reader learns whether a started chat may be shown, and how. The
 * run record answers first, where it can: a run that started proves the chat
 * ran, and that answer holds when a chat runs on another computer
 * (`specs/space-computer-contract/02-specification.md`), where this
 * computer's `session_metadata` no longer records it. The chat's binding in
 * `session_metadata` answers for chats older than the run record. A chat
 * with neither is shown from its last run: still launching (queued or
 * starting), or never started, with the run's reason. A chat with no binding
 * and no run is left out, unless the tree passes through it: then it is
 * shown as `unknown` (`./chat-lineage.ts`). This check reads no transcript,
 * unlike `sessionExists`.
 *
 * The binding read is `./reads/chat-bindings.ts`, the work graph's one reader
 * of `session_metadata`. When the work graph moves to the space store
 * (DOR-5139), it and the run read go over the contract instead of this
 * computer's tables.
 *
 * @module services/work-graph/lineage-reads
 */
import type { Db } from '@dorkos/db';
import type { SessionStartedByStore } from '../session/origin/session-started-by-store.js';
import type { RunStore, TurnRun } from '../runs/index.js';
import { REKEY_MAX_DEPTH, type WorkLinkStore } from './work-link-store.js';
import { boundChatIds } from './reads/chat-bindings.js';

/** How a chat came from the one above it: started by it, or carried on from it to another account. */
export type LineageVia = 'started' | 'carried';

/** What a reader may show of a chat in a lineage. */
export type LineageState =
  | {
      /** It ran: a run of it started, or it is bound to a runtime. It can be opened. */
      kind: 'chat';
    }
  | {
      /**
       * Only a start record proves it: no binding and no run, yet the tree
       * passes through it (it started a shown chat, or a record names it as a
       * shown chat's parent). It cannot be opened; a reader says so in words,
       * never as an id. A stray record and a real chat that ran unbound look
       * the same in the data, so both read this way.
       */
      kind: 'unknown';
    }
  | {
      /** It has not run yet, and its last run is still in line or starting. */
      kind: 'launching';
      /** That run. */
      runId: string;
      /** Where that run is: waiting its turn, or being handed to the runtime. */
      status: 'queued' | 'starting';
      /** The title its starter asked for, while it waits to take it, or `null`. */
      title: string | null;
    }
  | {
      /** It never ran: its last run ended before its turn started. */
      kind: 'never-started';
      /** That run. */
      runId: string;
      /** Why: the run's `cancelledBecause`, else its ending, else its status. */
      reason: string;
    };

/** The chat a chat hangs under, as the records name it. */
export interface LineageParent {
  /** The parent, by the id it has now. */
  chatId: string;
  /** How the child came from it. */
  via: LineageVia;
  /** When the start was recorded (ISO 8601): the order siblings list in. */
  at: string;
}

/** What {@link LineageReads} reads. */
export interface LineageReadsDeps {
  /** The DorkOS database: a chat's binding (`session_metadata`). */
  db: Db;
  /** The work graph's edges: `started` and `rekeyed_from`. */
  links: WorkLinkStore;
  /** `session_started_by`, when wired. */
  startedBy?: SessionStartedByStore;
  /** The run record, when wired. */
  runs?: Pick<RunStore, 'listForChats'>;
}

/** A chat ref for the edge store. */
const chat = (id: string) => ({ kind: 'chat' as const, id });

/** The lineage query's reads, each over a whole level of chats. */
export class LineageReads {
  /**
   * Build the reads over their stores.
   *
   * @param deps - The database, the edge store and, when wired, the parent rows and the run record.
   */
  constructor(private readonly deps: LineageReadsDeps) {}

  /**
   * Each chat's current id, through `rekeyed_from`.
   *
   * @param ids - Chat ids, current or retired.
   */
  current(ids: readonly string[]): Map<string, string> {
    return this.deps.links.resolveRekeys(ids);
  }

  /**
   * Each chat's ids: its current one first, then every older id it replaced
   * (bounded, cycle-safe; an id claimed by two chats stays with the first).
   *
   * @param ids - Current chat ids.
   * @returns Each id's ids, and which chat each id belongs to.
   */
  aliases(ids: readonly string[]): { of: Map<string, string[]>; owner: Map<string, string> } {
    const of = new Map(ids.map((id) => [id, [id]]));
    const owner = new Map(ids.map((id) => [id, id]));
    let open = [...ids];
    for (let step = 0; step < REKEY_MAX_DEPTH && open.length > 0; step += 1) {
      const next: string[] = [];
      for (const link of this.deps.links.fromMany(open.map(chat), 'rekeyed_from')) {
        const holder = owner.get(link.from.id);
        if (link.to.kind !== 'chat' || holder === undefined || owner.has(link.to.id)) continue;
        owner.set(link.to.id, holder);
        of.get(holder)!.push(link.to.id);
        next.push(link.to.id);
      }
      open = next;
    }
    return { of, owner };
  }

  /**
   * Every chat the records say these chats started or were carried to, by
   * current id, in no particular order. A candidate only: it hangs under the
   * chat {@link parentsOf} names.
   *
   * @param ids - Current chat ids.
   */
  candidatesUnder(ids: readonly string[]): string[] {
    const all = [...this.aliases(ids).of.values()].flat();
    const raw = this.deps.links
      .fromMany(all.map(chat), 'started')
      .flatMap((link) => (link.to.kind === 'chat' ? [link.to.id] : []));
    for (const row of this.deps.startedBy?.startsBy(all) ?? []) raw.push(row.sessionId);
    return [...new Set(this.current(raw).values())];
  }

  /**
   * The chat each chat hangs under: the one its `session_started_by` row
   * names, else the oldest `started` link into it. One answer, used both
   * walking down and walking up, so the two always agree.
   *
   * Siblings order on {@link LineageParent.at}: the row's time when there is a
   * row, else the link's. Both come from this server's clock, written in the
   * same synchronous step of the same start, so the two can be compared.
   *
   * @param ids - Current chat ids.
   * @returns Each chat's parent; a chat nothing started is absent.
   */
  parentsOf(ids: readonly string[]): Map<string, LineageParent> {
    const raw = new Map<string, LineageParent>();
    const rows = this.deps.startedBy?.getMany(ids) ?? new Map();
    const rest: string[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row?.kind === 'chat' && row.startedBySessionId !== null) {
        raw.set(id, {
          chatId: row.startedBySessionId,
          via: row.carried ? 'carried' : 'started',
          at: row.createdAt,
        });
      } else rest.push(id);
    }
    const { of, owner } = this.aliases(rest);
    const all = [...of.values()].flat();
    // Oldest first, so the first link into a chat is the one kept.
    for (const link of this.deps.links.toMany(all.map(chat), 'started')) {
      const child = owner.get(link.to.id);
      if (child === undefined || raw.has(child) || link.from.kind !== 'chat') continue;
      raw.set(child, { chatId: link.from.id, via: 'started', at: link.recordedAt });
    }
    const current = this.current([...raw.values()].map((parent) => parent.chatId));
    const parents = new Map<string, LineageParent>();
    for (const [id, parent] of raw) {
      const chatId = current.get(parent.chatId) ?? parent.chatId;
      // A chat's own id is never its parent, whatever a stray record says.
      if (chatId !== id) parents.set(id, { ...parent, chatId });
    }
    return parents;
  }

  /**
   * The join: what a reader may show of each chat, or `null` to leave it out.
   * See the module documentation for the order the answers are asked in.
   *
   * @param ids - Current chat ids.
   */
  statesOf(ids: readonly string[]): Map<string, LineageState | null> {
    const { of } = this.aliases(ids);
    const all = [...of.values()].flat();
    const runs = this.deps.runs?.listForChats(all) ?? new Map<string, TurnRun[]>();
    const bound = boundChatIds(this.deps.db, all);
    const rows = this.deps.startedBy?.getMany(ids) ?? new Map();
    const states = new Map<string, LineageState | null>();
    for (const id of ids) {
      const own = of
        .get(id)!
        .flatMap((alias) => runs.get(alias) ?? [])
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      if (own.some(ranTurn) || of.get(id)!.some((a) => bound.has(a))) {
        states.set(id, { kind: 'chat' });
        continue;
      }
      states.set(id, fromLastRun(own.at(-1), rows.get(id)?.title ?? null));
    }
    return states;
  }
}

/**
 * Whether a run's turn started. `started` and `running` always carry a
 * `startedAt`, and a pause that cuts a turn before the agent did anything
 * clears it as the run goes back in line, so the time alone could answer;
 * the two statuses are named too, so a run in either is never read as one
 * still launching.
 */
function ranTurn(run: TurnRun): boolean {
  return run.startedAt !== null || run.status === 'started' || run.status === 'running';
}

/**
 * What a chat that has not run is shown as, from its last run. Every status
 * left once {@link ranTurn} is false names itself: `queued` and `starting` are
 * the two a run holds before its turn starts, and the rest are endings.
 */
function fromLastRun(last: TurnRun | undefined, title: string | null): LineageState | null {
  if (last === undefined) return null;
  switch (last.status) {
    case 'queued':
    case 'starting':
      return { kind: 'launching', runId: last.id, status: last.status, title };
    case 'started':
    case 'running':
      return { kind: 'chat' };
    case 'ended':
    case 'settled':
    case 'cancelled':
    case 'superseded':
      return {
        kind: 'never-started',
        runId: last.id,
        reason: last.endingDetail.cancelledBecause ?? last.ending ?? last.status,
      };
  }
}
