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
 * **Its idempotence rests on the emptiness check**, and its safety on the
 * confirm-before-delete. A session whose server table already holds anything is
 * never re-seeded, so a second device connecting after the first has imported
 * adds nothing — and a client that crashed mid-import does not double, because
 * the documents it already sent make the table non-empty.
 *
 * @module features/canvas/model/use-session-canvas
 */
import { useEffect } from 'react';
import type { UiCanvasContent } from '@dorkos/shared/types';
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
        const existing = await transport.listSessionCanvas(sessionId);
        if (existing.length > 0) {
          // The table is already filled — by an earlier import, by another
          // device, or by this session's own agent. Never re-seeded, which is
          // what makes a second device add nothing.
          dropEntry(sessionId);
          return;
        }
        for (const content of documentsOf(entry)) {
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
        // Kept, deliberately. The next hydrate tries again, and the emptiness
        // check above is what stops the retry from doubling anything.
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
