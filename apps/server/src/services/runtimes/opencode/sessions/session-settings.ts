/** Existing ordinary OpenCode settings hydration and per-turn precedence. */
import type { MessageOpts, SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { SessionSettings } from '@dorkos/shared/types';
import type { OpenCodeSessionPatch, OpenCodeSessionRegistry } from './session-registry.js';

/** Preserve the existing explicit/tracked/persisted/default precedence and absent fields. */
export function openCodeSettingsPatch(
  tracked: boolean,
  persisted: SessionSettings | null | undefined,
  explicit: OpenCodeSessionPatch
): OpenCodeSessionPatch {
  const permissionMode = tracked
    ? explicit.permissionMode
    : (explicit.permissionMode ?? persisted?.permissionMode ?? 'default');
  const model = explicit.model ?? persisted?.model;
  const fastMode = explicit.fastMode ?? persisted?.fastMode;
  return {
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(explicit.cwd !== undefined ? { cwd: explicit.cwd } : {}),
  };
}

/**
 * Register a session's settings, hydrating the durable row (ADR-0260) under
 * the caller's own fields when the runtime has no memory of the session.
 * Precedence: explicit → persisted, and for `permissionMode` alone a runtime
 * default beneath both — a session always runs under SOME mode, while an
 * unstated model or fastMode is honestly just absent (the sidecar's own
 * default model, no fast mode) rather than a value this could invent.
 *
 * The ONE hydration seam, shared by the two cold entry points that need it —
 * `OpenCodeRuntime.updateSession` and
 * {@link resolveOpenCodeTurnSettings} — because a session loses its
 * in-memory state on every restart and EITHER a message or a settings PATCH
 * can be the first thing to arrive afterwards. Registering only the fields a
 * caller happened to name would drop the row's siblings — a PATCH that picks
 * a model would reset an enforced `bypassPermissions` session to `default`
 * while the stored settings (and the app, reading them) kept showing the
 * operator's real choice (DOR-1152; the claude-code twin is DOR-1151).
 *
 * `OpenCodeRuntime.ensureSession` is a third cold path and deliberately
 * does NOT come through here: `SessionOpts.permissionMode` is REQUIRED by the
 * shared contract — "callers resolve the effective mode (per-send override →
 * persisted → runtime default) before creating" (`SessionOpts`,
 * `agent-runtime.ts`) — and its real callers do exactly that, the scheduler
 * from the task's own mode and the relay from the binding's, on an id it mints
 * one line earlier that no stored row can describe yet. Reading the store
 * there would re-derive an answer the caller had already given, or invent one
 * for a session that has no history.
 *
 * A session already tracked in memory reads nothing: its registration is the
 * live truth, and only the stated fields change.
 *
 * @param sessionId - DorkOS session id.
 * @param explicit - The fields this caller states, which outrank the stored ones.
 */
export async function registerOpenCodeWithPersisted(
  registry: OpenCodeSessionRegistry,
  settingsPort: SessionSettingsPort | undefined,
  sessionId: string,
  explicit: OpenCodeSessionPatch = {}
): Promise<void> {
  const tracked = registry.has(sessionId);
  const persisted = tracked ? null : await settingsPort?.getSessionSettings(sessionId);
  registry.register(sessionId, openCodeSettingsPatch(tracked, persisted, explicit));
}

/**
 * Effective settings for one turn: per-send override → tracked session →
 * persisted store (hydrated once for untracked sessions, e.g. resume after
 * a server restart) → runtime default.
 */
export async function resolveOpenCodeTurnSettings(
  registry: OpenCodeSessionRegistry,
  settingsPort: SessionSettingsPort | undefined,
  sessionId: string,
  opts?: MessageOpts
): Promise<SessionSettings> {
  if (!registry.has(sessionId)) {
    // Only the mode and cwd are stated here. A per-send `model`/`fastMode` is
    // a transient override for THIS turn (Tasks, relay) — it is applied to
    // the returned settings below and deliberately never tracked, so the
    // session keeps running on the operator's own choice afterwards.
    await registerOpenCodeWithPersisted(registry, settingsPort, sessionId, {
      permissionMode: opts?.permissionMode,
      cwd: opts?.cwd,
    });
  }
  const tracked = registry.get(sessionId)!;
  const model = opts?.model ?? tracked.model;
  const fastMode = opts?.fastMode ?? tracked.fastMode;
  return {
    // A chat that follows its agent up starts from the agent's level this turn
    // (DOR-3175); the tracked mode is left as it was.
    permissionMode: opts?.levelPermissionMode ?? opts?.permissionMode ?? tracked.permissionMode,
    ...(model !== undefined ? { model } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
}
