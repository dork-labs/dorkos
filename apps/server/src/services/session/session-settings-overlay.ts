/**
 * The one way a session's persisted settings (ADR-0260) are projected onto a
 * runtime-derived `Session` for DISPLAY.
 *
 * Scope, stated precisely: every path that hands a `Session` to a client goes
 * through here — `GET /api/sessions`, `GET /api/sessions/:id`,
 * `GET /api/sessions/recent`, and the `session_upserted` fan-out in
 * {@link SessionListBroadcaster}. It is NOT the only reader of the store: each
 * runtime hydrates its own in-memory session from `SessionSettingsPort` for
 * ENFORCEMENT (see `session-store.ts`), and the `/events` handler reads a single
 * value for its `SessionOpts` ctx via {@link resolveSettingsKey}. Those read the
 * same rows under the same key; they just do not produce a `Session`.
 *
 * `permissionMode`, `model`, `effort`, and `fastMode` are operator choices; the
 * `session_metadata` store is their source of truth and the runtime-derived
 * session (SDK JSONL for claude-code, SDK threads for codex, the sidecar store
 * for opencode — ADR-0310) is the fallback for sessions with no stored row.
 *
 * The key matters as much as the value. A runtime may hold an ALIAS for a
 * session: claude-code keys its in-memory session by the id DorkOS minted but
 * tracks the canonical id the SDK assigned, so `getInternalSessionId` maps one
 * to the other. Every write goes through `PATCH /api/sessions/:id`, which
 * persists under the CANONICAL id — so every read must look there too. Reading
 * under the raw id instead silently misses the row the operator just wrote and
 * falls back to the transcript, which is how `GET /api/sessions` and
 * `GET /api/sessions/:id` came to report different permission modes for one
 * session (DOR-463). `getInternalSessionId` is idempotent on a canonical id, so
 * resolving through it on every path converges all of them on one key.
 *
 * ONE key, not a list of candidates. A row can never be stranded under a
 * retired id, because the runtime moves it the moment it rebinds the session
 * (`rekeySessionSettings`, DOR-493) — so no reader has to guess which id an
 * operator's choice was written under, and no two readers can pick differently.
 *
 * @module services/session/session-settings-overlay
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Session, SessionSettings } from '@dorkos/shared/types';

/** The one runtime capability this module needs: a session's id alias. */
type SessionIdAliasing = Pick<AgentRuntime, 'getInternalSessionId'>;

/**
 * The registry capabilities the overlay needs. `RuntimeRegistry` satisfies this
 * structurally — the narrow port keeps `services/session` free of a dependency
 * on the core registry singleton (mirrors `SessionSettingsPort`, ADR-0260).
 */
export interface SessionSettingsOverlayPort {
  /** Batch-read persisted settings; sessions without a row are absent. */
  getSessionSettingsMany(ids: string[]): Map<string, SessionSettings>;
  /** Whether a runtime type is registered on this server. */
  has(type: string): boolean;
  /** Get a registered runtime by type. */
  get(type: string): SessionIdAliasing;
}

/**
 * The id a session's persisted settings are stored under: the runtime's
 * canonical id when it holds an alias, else the id as given.
 *
 * This is the same translation `PATCH /api/sessions/:id` applies before
 * writing, which is what makes it the correct key to read by.
 *
 * @param sessionId - Client-facing session id
 * @param runtime - The runtime that owns the session, or undefined when it
 *   cannot be resolved (an unregistered runtime tag — the id is then its own key)
 */
export function resolveSettingsKey(
  sessionId: string,
  runtime: SessionIdAliasing | undefined
): string {
  return runtime?.getInternalSessionId(sessionId) ?? sessionId;
}

/**
 * Apply persisted settings over a transcript-derived session so the store is
 * the single source of truth for display — keeping the session-list badge, the
 * in-session toolbar, and runtime enforcement in sync. Store wins;
 * runtime-derived values remain the fallback for sessions with no stored row.
 *
 * @param target - The session object to mutate in place
 * @param stored - Persisted settings (only defined fields are applied)
 */
export function applyStoredSettings(target: Session, stored: SessionSettings): void {
  if (stored.permissionMode !== undefined) target.permissionMode = stored.permissionMode;
  if (stored.model !== undefined) target.model = stored.model;
  if (stored.effort !== undefined) target.effort = stored.effort;
  if (stored.fastMode !== undefined) target.fastMode = stored.fastMode;
}

/** The one store key for a session: its owning runtime's canonical id. */
function settingsKeyFor(session: Session, port: SessionSettingsOverlayPort): string {
  const type = session.runtime;
  const runtime = type !== undefined && port.has(type) ? port.get(type) : undefined;
  return resolveSettingsKey(session.id, runtime);
}

/**
 * Overlay persisted settings onto every session in `sessions`, in place.
 *
 * One batch query for the whole set — no N+1 — keyed per session via that
 * session's own owning runtime (`Session.runtime`, which aggregation
 * guarantees). Used by every path that hands a `Session` to a client, so no two
 * of them can drift.
 *
 * @param sessions - Runtime-derived sessions to overlay, mutated in place
 * @param port - Settings store + runtime lookup
 */
export function overlayStoredSettings(sessions: Session[], port: SessionSettingsOverlayPort): void {
  if (sessions.length === 0) return;
  const keys = sessions.map((session) => settingsKeyFor(session, port));
  const stored = port.getSessionSettingsMany([...new Set(keys)]);
  sessions.forEach((session, i) => {
    const settings = stored.get(keys[i]!);
    if (settings) applyStoredSettings(session, settings);
  });
}
