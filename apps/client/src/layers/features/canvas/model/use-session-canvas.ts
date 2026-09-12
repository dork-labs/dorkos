/**
 * Bind the canvas slice to the session on screen, and carry a canvas that was
 * still in `localStorage` up to the server exactly once (spec
 * `canvas-agent-seat` §1.5).
 *
 * ## The import, and why it waits
 *
 * A brand-new session streams under the request UUID the client minted and is
 * renamed to the SDK's canonical id mid-first-turn. Importing under the
 * pre-rekey id would write rows into a scope that is about to be renamed — and,
 * worse, deleting the local entry at that moment would destroy the only copy if
 * the writes had not landed. So the import is gated on two facts:
 *
 * - **Canonical.** A session the client has never sent a message on is ALREADY
 *   canonical — it has no pre-rekey id to be confused by — so the common case
 *   waits for nothing. A session mid-first-turn is recognised by the URL still
 *   holding the id the client minted, and the rekey redirect moves the route to
 *   the canonical id, which re-runs this hook.
 * - **Confirmed.** The local entry is deleted only after every write returned.
 *   A failed or partial import leaves it exactly where it was and retries on the
 *   next hydrate.
 *
 * **Its idempotence is per DOCUMENT**, and its safety is the
 * confirm-before-delete. Each document in the entry is matched against the rows
 * the server already holds and only the unmatched ones are sent, so a second
 * device connecting after the first has imported writes nothing and a client
 * that crashed mid-import sends only the rest.
 *
 * It used to be all-or-nothing on "does the table hold anything", and that lost
 * data: an entry holding `[A, B]` whose write of B threw kept the entry for the
 * retry, exactly as designed — and the retry then saw the `A` it had just
 * written, took the already-filled branch, and deleted the entry. `B` was gone
 * from `localStorage` and had never reached the server. The spec's rule is
 * "delete the local entry only after every POST returned 201", and every means
 * every document rather than every attempt.
 *
 * @module features/canvas/model/use-session-canvas
 */
import { useEffect } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { canvasSourceKey } from '@dorkos/shared/canvas-source-key';
import { useAppStore, useTransport } from '@/layers/shared/model';

/** Where a session's canvas used to live, and the only thing that reads it now. */
const LEGACY_CANVAS_KEY = 'dorkos-canvas-sessions';

/**
 * How stale a retired entry may be before a hydrate drops it.
 *
 * Entries for sessions the person never opens again are swept on any hydrate,
 * so the retired map does not sit in `localStorage` for ever waiting for a
 * session nobody will reopen.
 *
 * **By AGE, not by count.** The first version of this swept everything past the
 * retired store's own 50-entry window — which that store enforced on every
 * write, so the map was never above it and the sweep returned immediately,
 * every time, for ever. Sixty days is the same judgement the retired LRU was
 * making, expressed in the one dimension the map can still be measured in.
 */
const RETIRED_ENTRY_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** One document as the retired `localStorage` map held it. */
interface LegacyDocument {
  content: UiCanvasContent;
  openedAt?: number;
}

/** One session's canvas as the retired `localStorage` map held it. */
interface LegacyEntry {
  documents?: LegacyDocument[];
  /** The single legacy shape, from before the canvas held more than one document. */
  content?: UiCanvasContent;
  accessedAt?: number;
}

/** Read the retired map, or `null` when there is none or it will not parse. */
function readLegacyMap(): Record<string, LegacyEntry> | null {
  try {
    const raw = localStorage.getItem(LEGACY_CANVAS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Record<string, LegacyEntry>;
  } catch {
    return null;
  }
}

/** Write the retired map back, or remove it when nothing is left. */
function writeLegacyMap(map: Record<string, LegacyEntry>): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(LEGACY_CANVAS_KEY);
    else localStorage.setItem(LEGACY_CANVAS_KEY, JSON.stringify(map));
  } catch {
    // A storage quota or a private window. Nothing here is worth a failure: the
    // canvas is already on the server, and the worst case is one stale key.
  }
}

/** The documents one legacy entry holds, oldest first, across both stored shapes. */
function documentsOf(entry: LegacyEntry): UiCanvasContent[] {
  if (Array.isArray(entry.documents)) {
    return [...entry.documents]
      .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0))
      .map((d) => d.content)
      .filter((content): content is UiCanvasContent => Boolean(content));
  }
  return entry.content ? [entry.content] : [];
}

/**
 * A content value as a comparable string, with object keys in a fixed order.
 *
 * Key ORDER is why this is not `JSON.stringify`: the two sides of the
 * comparison have been through different round trips — one out of
 * `localStorage`, one out of SQLite and back over HTTP — and a difference in
 * order would read as a different document. Getting that wrong in this
 * direction duplicates a tab; getting the opposite wrong loses one.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/**
 * Which of this entry's documents the server does not hold yet.
 *
 * **Two identities, because the table has two kinds of document.**
 *
 * - Content with a natural identity — a file path, a URL — carries a
 *   {@link canvasSourceKey}, and that is what the server dedupes on: a second
 *   open of the same file REFRESHES the row rather than adding one. So a local
 *   document whose key is already on the table is present, whatever its content
 *   says, and matching it does not consume the row (many locals can dedupe onto
 *   one).
 * - `json` and `widget` have no such key — the store treats every open of one
 *   as a fresh document — so they are matched by content, and each server row
 *   satisfies at most ONE of them. An entry holding the same widget twice
 *   really does want two rows.
 *
 * @param onServer - The rows the session's canvas already holds.
 * @param wanted - The entry's documents, oldest first.
 * @returns The subset still to be sent, in the order they were opened.
 */
function documentsNotYetOnTheServer(
  onServer: readonly { content: UiCanvasContent }[],
  wanted: readonly UiCanvasContent[]
): UiCanvasContent[] {
  const keysHeld = new Set<string>();
  const keylessHeld = new Map<string, number>();
  for (const row of onServer) {
    const key = canvasSourceKey(row.content);
    if (key !== null) {
      keysHeld.add(key);
      continue;
    }
    const serialized = stableJson(row.content);
    keylessHeld.set(serialized, (keylessHeld.get(serialized) ?? 0) + 1);
  }

  const missing: UiCanvasContent[] = [];
  for (const content of wanted) {
    const key = canvasSourceKey(content);
    if (key !== null) {
      if (!keysHeld.has(key)) missing.push(content);
      continue;
    }
    const serialized = stableJson(content);
    const held = keylessHeld.get(serialized) ?? 0;
    if (held > 0) keylessHeld.set(serialized, held - 1);
    else missing.push(content);
  }
  return missing;
}

/** Sessions this window has already decided about, so one mount imports once. */
const imported = new Set<string>();

/**
 * Reset the once-per-session latch.
 *
 * @internal Exported for testing only. A test that drives two mounts of one
 * session needs to be able to say which of them is the first.
 */
export function resetSessionCanvasImport(): void {
  imported.clear();
}

/**
 * Bind the canvas slice to a session, and run the one-time import.
 *
 * @param sessionId - The session on screen, or `null`/`undefined` when none is.
 * @param opts.canonical - Whether `sessionId` is the session's canonical id.
 *   Defaults to `true`, which is right for every session the client did not
 *   just mint; a composer that is still waiting for the 202 passes `false`.
 */
export function useSessionCanvas(
  sessionId: string | null | undefined,
  opts: { canonical?: boolean } = {}
): void {
  const transport = useTransport();
  const canonical = opts.canonical ?? true;

  useEffect(() => {
    if (!sessionId) return;
    // Bind first: the snapshot's hydration is guarded on the slice naming this
    // session, so a table that arrived before the bind would be dropped.
    useAppStore.getState().loadCanvasForSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !canonical || imported.has(sessionId)) return;
    const map = readLegacyMap();
    if (!map) return;
    const entry = map[sessionId];
    if (!entry) {
      // Nothing to import for THIS session, but the map may still be holding
      // entries for sessions nobody will reopen. Drop the ones that have gone
      // stale, so the retired key empties out and disappears on its own.
      sweepStaleEntries(map);
      return;
    }
    imported.add(sessionId);

    // **Deliberately not cancelled on unmount.** This is a migration, not a
    // subscription: an unmount halfway through would leave a table half written
    // — and React runs an effect, cleans it up and runs it again on every mount
    // in development, so a cancel-on-cleanup import never ran at all. The latch
    // above is what keeps it to once; nothing else needs to.
    void (async () => {
      try {
        const wanted = documentsOf(entry);
        const missing = documentsNotYetOnTheServer(
          await transport.listSessionCanvas(sessionId),
          wanted
        );
        if (missing.length === 0) {
          // Every document in this entry is already a row — put there by an
          // earlier import, by another device, or by a retry that got further
          // than it was told. Nothing to send, and the local copy is safe to
          // let go of.
          dropEntry(sessionId);
          return;
        }
        for (const content of missing) {
          await transport.openSessionCanvasDocument(sessionId, content);
        }
        // Only now: every write returned. A partial import keeps the entry and
        // retries on the next hydrate, because a half-written table plus a
        // deleted local copy is the one outcome with no way back.
        dropEntry(sessionId);
        // And put what was just written on screen. The cold snapshot that fills
        // this slice was taken BEFORE the import ran, and a session nobody has
        // sent a message on yet has no projector to publish a `canvas` event
        // through — so without this the documents would be on the server and
        // invisible until the next reload, which is the divergence this whole
        // move removes, arriving by a different route.
        useAppStore
          .getState()
          .hydrateCanvasFromSnapshot(sessionId, await transport.listSessionCanvas(sessionId));
      } catch {
        // Kept, deliberately. The next hydrate tries again, and the per-document
        // match above is what stops the retry from doubling what already landed
        // — and, just as importantly, from dropping what did not.
        imported.delete(sessionId);
      }
    })();
  }, [sessionId, canonical, transport]);
}

/** Remove one session's retired entry, leaving the rest of the map alone. */
function dropEntry(sessionId: string): void {
  const map = readLegacyMap();
  if (!map) return;
  const { [sessionId]: _imported, ...rest } = map;
  writeLegacyMap(rest);
}

/**
 * Drop retired entries nobody has opened in {@link RETIRED_ENTRY_MAX_AGE_MS}.
 *
 * An entry carrying no `accessedAt` is from the single-document shape that
 * predates the timestamp, and it is KEPT: it cannot be dated, and deleting
 * somebody's only copy of a canvas on a guess is the one failure direction with
 * no way back. Those go when their session is next opened and imported.
 *
 * There is no "except the session on screen" argument, because there is no such
 * case: this runs only on the branch where the map holds NO entry for it.
 *
 * @param map - The retired map, as read.
 */
function sweepStaleEntries(map: Record<string, LegacyEntry>): void {
  const cutoff = Date.now() - RETIRED_ENTRY_MAX_AGE_MS;
  const survivors = Object.entries(map).filter(
    ([, entry]) => entry.accessedAt === undefined || entry.accessedAt >= cutoff
  );
  if (survivors.length === Object.keys(map).length) return;
  writeLegacyMap(Object.fromEntries(survivors));
}
