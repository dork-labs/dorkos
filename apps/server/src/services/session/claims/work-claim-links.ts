/**
 * The port a claim's history is written through (DOR-4972). Every claim and
 * every end of one is also an edge in the work graph (`claims`, `released`),
 * so "who worked on DOR-1234, when" is a query. The lock stays `work_claims`.
 *
 * The claim service calls the recorder inside its own transaction, with the
 * transaction, so the edge lands with the lock change or not at all. The
 * recorder is set at the composition root (`startup/steps/work-graph.ts`), so
 * this domain imports nothing from the work graph (the `work-graph/stay-out`
 * rule). Recording never decides the claim: the service catches and logs
 * anything the recorder throws.
 *
 * @module services/session/claims/work-claim-links
 */
import type { DbTransaction } from '@dorkos/db';

/**
 * What wrote a change, a closed list: the claim tool, `session_start`'s claim
 * for the chat it starts, the release tool, the lapse sweep, a hand-over from
 * one chat to another, and the session-end cleanup of a chat that never started.
 */
export type WorkClaimWriter =
  'claim-tool' | 'session-start' | 'release-tool' | 'lapse-sweep' | 'hand-over' | 'session-end';

/** One change to who holds a claim. */
export interface WorkClaimChange {
  /** A chat took the claim, or a chat's claim ended. */
  transition: 'claimed' | 'released';
  /** The agent whose chats share the claim. */
  agentId: string;
  /** The chat whose claim began or ended. */
  sessionId: string;
  /** The normalised key. Only a ticket or pull request key becomes an edge. */
  key: string;
  /** When it happened (ISO 8601), from the lock: never the time the edge is written. */
  at: string;
  /** What wrote it. */
  writer: WorkClaimWriter;
  /** The chat whose action it was, or `null` for the server's own bookkeeping. */
  recordingChatId: string | null;
}

/** Records one change, inside the claim's transaction. */
export type WorkClaimRecorder = (tx: DbTransaction, change: WorkClaimChange) => void;

let recorder: WorkClaimRecorder | null = null;

/**
 * Set the recorder the claim service writes each change through.
 *
 * @param next - The recorder.
 * @returns A function that removes it, if it is still the one set.
 */
export function setWorkClaimRecorder(next: WorkClaimRecorder): () => void {
  recorder = next;
  return () => {
    if (recorder === next) recorder = null;
  };
}

/** The recorder set at startup, or `null` when none is. */
export function workClaimRecorder(): WorkClaimRecorder | null {
  return recorder;
}
