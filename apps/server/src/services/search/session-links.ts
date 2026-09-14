/**
 * Turning a hit's container back into the DorkOS session that opens it
 * (message-search spec Amendment 14, DOR-2020).
 *
 * ## The gap this closes
 *
 * `origin_key` is the id of the store that OWNS the transcript, and that is
 * correct: it is what discovery finds, what the frontier is keyed by, and what a
 * projection composes without asking DorkOS anything. But it is not what the app
 * opens a conversation by. DorkOS gives every session a UUID of its own and each
 * runtime keeps a durable map from it to whatever the runtime calls the same
 * conversation — `codex_threads` for Codex (ADR-0309), `opencode_sessions` for
 * OpenCode (ADR-0308). Claude Code needs no map, because DorkOS reads the SDK's
 * own transcript store and uses the SDK's own session id.
 *
 * So a hit answering with its container opened the right conversation on exactly
 * one of the three runtimes, and led nowhere on the other two — a search box that
 * finds a Codex message and cannot show it to you.
 *
 * ## Resolved when the hit is served, never stored on the row
 *
 * The binding lives in the same SQLite file as the index, so this is one small
 * lookup over at most `limit` containers — the same shape, and the same
 * reasoning, as the container-path lookup beside it in `search-service.ts`.
 *
 * **Storing the resolved id on the index row instead would go stale, and stale
 * here is invisible.** A rollout file exists before its `codex_threads` row is
 * written, and an OpenCode conversation adopted from the TUI is bound the first
 * time DorkOS lists it — both are bindings that appear AFTER the messages they
 * describe were indexed. A copy taken at index time would record "no session"
 * and keep saying it until something happened to make that container change,
 * which for a finished conversation is never. Reading the binding at serve time
 * cannot be behind it, and needs no rebuild of the index to start being right.
 *
 * ## An allowlist, so a new source is unopenable rather than wrong
 *
 * A source this module has never heard of resolves to nothing, and its hits are
 * shown without a link. That is the direction a default has to fail in: guessing
 * that some future source's container is a session id is how this bug happened
 * in the first place.
 *
 * @module server/services/search/session-links
 */
import { codexThreads, opencodeSessions, inArray, type Db } from '@dorkos/db';
import { claudeCodeSource, codexSource, openCodeSource } from './registry.js';

/**
 * The composite key a container is looked up by, source first.
 *
 * Joined on a NUL, written as an ESCAPE rather than pasted in as a byte — a raw
 * one in the source makes git treat this whole file as binary and stop diffing
 * it. It is the right separator because `origin_key` is opaque and may hold
 * anything a projection composes, and NUL is the one character it cannot.
 *
 * @param sourceId - Which source the container belongs to.
 * @param originKey - The container id within it.
 * @returns The map key both per-hit lookups share.
 */
export function containerKey(sourceId: string, originKey: string): string {
  return `${sourceId}\u0000${originKey}`;
}

/** One container a hit landed in. */
export interface HitContainer {
  /** Which source it came from. */
  sourceId: string;
  /** The opaque container id the projection composed. */
  originKey: string;
}

/**
 * The DorkOS session each container opens, for the containers that have one.
 *
 * @param db - The database holding both the index and the runtime bindings.
 * @param containers - The containers the hits landed in. Duplicates are fine.
 * @returns `containerKey(sourceId, originKey)` to DorkOS session id. A container
 *   with no session behind it — a room, a conversation held with a runtime's own
 *   command-line tool that DorkOS never ran, a source this module does not know
 *   — is simply absent, which the caller reports as "cannot be opened" rather
 *   than as an error.
 */
export function resolveSessionIds(
  db: Db,
  containers: readonly HitContainer[]
): Map<string, string> {
  const sessions = new Map<string, string>();
  if (containers.length === 0) return sessions;

  const bySource = new Map<string, Set<string>>();
  for (const container of containers) {
    const keys = bySource.get(container.sourceId);
    if (keys) keys.add(container.originKey);
    else bySource.set(container.sourceId, new Set([container.originKey]));
  }

  // Claude Code needs no lookup: DorkOS reads the SDK's own transcript store, so
  // the id the index holds IS the id the session route resolves. Recorded here
  // as a mapping rather than left implicit, because "the two ids are the same
  // string" is a fact about that runtime and not a property of containers.
  for (const originKey of bySource.get(claudeCodeSource.id) ?? []) {
    sessions.set(containerKey(claudeCodeSource.id, originKey), originKey);
  }

  const codexKeys = bySource.get(codexSource.id);
  if (codexKeys !== undefined && codexKeys.size > 0) {
    const rows = db
      .select({ sessionId: codexThreads.sessionId, threadId: codexThreads.threadId })
      .from(codexThreads)
      .where(inArray(codexThreads.threadId, [...codexKeys]))
      .all();
    for (const row of rows) {
      sessions.set(containerKey(codexSource.id, row.threadId), row.sessionId);
    }
  }

  const openCodeKeys = bySource.get(openCodeSource.id);
  if (openCodeKeys !== undefined && openCodeKeys.size > 0) {
    const rows = db
      .select({ sessionId: opencodeSessions.sessionId, ocSessionId: opencodeSessions.ocSessionId })
      .from(opencodeSessions)
      .where(inArray(opencodeSessions.ocSessionId, [...openCodeKeys]))
      .all();
    for (const row of rows) {
      sessions.set(containerKey(openCodeSource.id, row.ocSessionId), row.sessionId);
    }
  }

  return sessions;
}
