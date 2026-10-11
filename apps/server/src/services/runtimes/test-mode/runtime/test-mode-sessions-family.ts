import { readOriginalTestModeSessionsView } from '../test-mode-runtime.js';
import type {
  SessionOpts,
  SseResponse,
  McpAppServerConnection,
  SessionUpdateResult,
} from '@dorkos/shared/agent-runtime';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { Session, HistoryMessage, SessionSettings } from '@dorkos/shared/types';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import {
  disposeProjector,
  getOrCreateProjector,
  getSessionEventStore,
  peekProjector,
  streamGenerationOf,
} from '../../../session/session-state-projector.js';
import { logger } from '../../../../lib/logger.js';
import { reconstructHistoryFromEvents } from '../../../session/event-log-history.js';
import { readLogBackedHistory } from '../../../session/log-backed-history.js';
import { heldProcesses } from '../held-process.js';
import type { TestModeScenarioSessionView } from './test-mode-scenario-session-types.js';

/** Allocate a separate private family; actual registration remains root lexical. */
export function createIsolatedTestModeSessions() {
  const views = new WeakMap<object, TestModeScenarioSessionView>();
  const get = WeakMap.prototype.get,
    set = WeakMap.prototype.set,
    apply = Reflect.apply;
  function read(owner: object): TestModeScenarioSessionView {
    const view = apply(get, views, [owner]);
    if (!view) throw new Error('Original TestMode Sessions owner required.');
    return view;
  }
  return {
    register(owner: object, view: TestModeScenarioSessionView): void {
      apply(set, views, [owner, view]);
    },
    read,
  };
}

/** Track the original session options in the constructor-owned registry. Requires the original private owner before effects. */
export function ensureSession(owner: object, sessionId: string, opts: SessionOpts): void {
  const view = readOriginalTestModeSessionsView(owner);
  view.registry.register(sessionId, {
    permissionMode: opts.permissionMode,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
}
/** Read original tracked-session membership. Requires the original private owner before effects. */
export function hasSession(owner: object, sessionId: string): boolean {
  const view = readOriginalTestModeSessionsView(owner);
  return view.registry.has(sessionId);
}
/** Read the original per-session count of open scenario turns. Requires the original private owner before effects. */
export function isTurnOpen(owner: object, sessionId: string): boolean {
  const view = readOriginalTestModeSessionsView(owner);
  return (view.openTurns.get(sessionId) ?? 0) > 0;
}
/** Reset held processes, original rename data, projectors and durable tracked sessions. Requires the original private owner before effects. */
export function resetTrackedSessions(owner: object): void {
  const view = readOriginalTestModeSessionsView(owner);
  heldProcesses.reset();
  // Declared first-turn renames go too: a session id reused after a reset must
  // not inherit a rename the previous test asked for.
  view.declaredCanonicalIds.clear();
  view.originalNativeCanonicalAliases.clear();
  const store = getSessionEventStore();
  for (const sessionId of view.registry.ids()) {
    disposeProjector(sessionId);
    try {
      store?.deleteSession(sessionId);
    } catch (error) {
      // Warn-and-swallow (the flushTurn pattern): one session's failed durable
      // delete must not abort the loop and leave later projectors un-disposed.
      logger.warn('[TestModeRuntime] durable session delete failed during reset', {
        sessionId,
        error,
      });
    }
  }
  view.registry.reset();
}
/** Save original settings before applying tracked permission and model changes. Requires the original private owner before effects. */
export async function updateSession(
  owner: object,
  sessionId: string,
  opts: SessionSettings
): Promise<SessionUpdateResult> {
  const view = readOriginalTestModeSessionsView(owner);
  await view.settingsPort?.saveSessionSettings(sessionId, opts);
  return {
    updated: view.registry.applySettings(sessionId, {
      ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
    }),
  };
}
/** Read original managed MCP injection data and synthesize the existing credential status. Requires the original private owner before effects. */
export function getMcpStatus(owner: object, cwd: string): McpServerEntry[] | null {
  const view = readOriginalTestModeSessionsView(owner);
  const servers = view.managedMcp?.injectableServersForCwd(cwd);
  if (!servers) return null;
  return Object.entries(servers).map(([name, connection]) => ({
    name,
    type: connection.transport,
    status: mcpStatusFor(connection),
    scope: 'managed',
  }));
}
/** Read the original named injectable managed MCP connection. Requires the original private owner before effects. */
export function getMcpServerConfig(
  owner: object,
  cwd: string,
  serverName: string
): McpAppServerConnection | null {
  const view = readOriginalTestModeSessionsView(owner);
  return view.managedMcp?.injectableServersForCwd(cwd)[serverName] ?? null;
}
/** List the original tracked sessions for the requested project. Requires the original private owner before effects. */
export async function listSessions(owner: object, projectDir: string): Promise<Session[]> {
  const view = readOriginalTestModeSessionsView(owner);
  return view.registry.list(projectDir);
}
/** Read the original tracked session by its id. Requires the original private owner before effects. */
export async function getSession(
  owner: object,
  _projectDir: string,
  id: string
): Promise<Session | null> {
  const view = readOriginalTestModeSessionsView(owner);
  return view.registry.get(id);
}
/** Find the original tracked session by its id. Requires the original private owner before effects. */
export async function findSession(owner: object, id: string): Promise<Session | null> {
  const view = readOriginalTestModeSessionsView(owner);
  return view.registry.get(id);
}
/** Read the original log-backed session history. Requires the original private owner before effects. */
export async function getMessageHistory(
  owner: object,
  _projectDir: string,
  id: string
): Promise<HistoryMessage[]> {
  readOriginalTestModeSessionsView(owner);
  return readLogBackedHistory(id);
}
/** Rename the original tracked session. Requires the original private owner before effects. */
export async function renameSession(
  owner: object,
  sessionId: string,
  title: string
): Promise<void> {
  const view = readOriginalTestModeSessionsView(owner);
  view.registry.rename(sessionId, title);
}
/** Record the original first-turn canonical-id declaration as DATA. Requires the original private owner before effects. */
export function declareCanonicalSessionId(
  owner: object,
  sessionId: string,
  canonicalId: string
): void {
  const view = readOriginalTestModeSessionsView(owner);
  if (sessionId === canonicalId) return;
  view.declaredCanonicalIds.set(sessionId, { canonicalId, revealed: false });
}
/** Reveal one original canonical-id declaration and rekey the tracked session. Requires the original private owner before effects. */
export function revealCanonicalSessionId(owner: object, sessionId: string): void {
  const view = readOriginalTestModeSessionsView(owner);
  const declared = view.declaredCanonicalIds.get(sessionId);
  if (!declared || declared.revealed) return;
  declared.revealed = true;
  view.registry.rekey(sessionId, declared.canonicalId);
}
/** Read only an already-revealed original canonical-id declaration. Requires the original private owner before effects. */
export function getInternalSessionId(owner: object, id: string): string | undefined {
  const view = readOriginalTestModeSessionsView(owner);
  const declared = view.declaredCanonicalIds.get(id);
  return declared?.revealed === true ? declared.canonicalId : undefined;
}
/** Acquire the original native session lock only in the recognized constructor lane. Requires the original private owner before effects. */
export function acquireLock(
  owner: object,
  id: string,
  clientId: string,
  res: SseResponse,
  token?: symbol
): boolean {
  const view = readOriginalTestModeSessionsView(owner);
  return view.custody.testModeNativeConstructors.has(view.runtime)
    ? view.nativeLocks.acquireLock(id, clientId, res, token)
    : true;
}
/** Release the original native session lock only in the recognized constructor lane. Requires the original private owner before effects. */
export function releaseLock(owner: object, id: string, clientId: string, token?: symbol): void {
  const view = readOriginalTestModeSessionsView(owner);
  if (view.custody.testModeNativeConstructors.has(view.runtime))
    view.nativeLocks.releaseLock(id, clientId, token);
}
/** Read the original recognized native session lock state. Requires the original private owner before effects. */
export function isLocked(owner: object, id: string, clientId?: string): boolean {
  const view = readOriginalTestModeSessionsView(owner);
  return view.custody.testModeNativeConstructors.has(view.runtime)
    ? view.nativeLocks.isLocked(id, clientId)
    : false;
}
/** Read the original recognized native session lock attribution. Requires the original private owner before effects. */
export function getLockInfo(
  owner: object,
  id: string
): { clientId: string; acquiredAt: number } | null {
  const view = readOriginalTestModeSessionsView(owner);
  return view.custody.testModeNativeConstructors.has(view.runtime)
    ? view.nativeLocks.getLockInfo(id)
    : null;
}
/** Build the original persisted projector snapshot from reconstructed event history. Requires the original private owner before effects. */
export async function getSessionSnapshot(
  owner: object,
  ctx: SessionOpts,
  sessionId: string
): Promise<SessionSnapshot> {
  readOriginalTestModeSessionsView(owner);
  const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
  return projector.buildSnapshot(() =>
    Promise.resolve(reconstructHistoryFromEvents(projector.replayFrom(0)))
  );
}
/** Return the original projector subscription with its unchanged cursor and abort signal. Requires the original private owner before effects. */
export function subscribeSession(
  owner: object,
  ctx: SessionOpts,
  sessionId: string,
  sinceCursor?: number,
  signal?: AbortSignal
): AsyncIterable<SessionEvent> {
  readOriginalTestModeSessionsView(owner);
  return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
    sinceCursor,
    signal
  );
}
/** Read the original projector stream generation. Requires the original private owner before effects. */
export function streamGeneration(owner: object, _ctx: SessionOpts, sessionId: string): string {
  readOriginalTestModeSessionsView(owner);
  return streamGenerationOf(peekProjector(sessionId));
}
/** Return the original tracked session-list subscription. Requires the original private owner before effects. */
export function subscribeSessionList(
  owner: object,
  _ctx: SessionOpts
): AsyncIterable<SessionListEvent> {
  const view = readOriginalTestModeSessionsView(owner);
  return view.registry.subscribe();
}

/**
 * The synthesized MCP status for one injected managed server: http/sse reads
 * `connected` once a bearer is injected (OAuth signed in) and `needs-auth`
 * otherwise; stdio needs no token and is always `connected`. See
 * {@link TestModeRuntime.getMcpStatus}.
 *
 * @param connection - The injected connection from the managed-server resolver.
 */
function mcpStatusFor(connection: McpAppServerConnection): McpServerEntry['status'] {
  if (connection.transport === 'stdio') return 'connected';
  return hasBearerHeader(connection.headers) ? 'connected' : 'needs-auth';
}

/**
 * Whether a header map carries a non-empty `Authorization: Bearer` (case-insensitive key).
 *
 * "Non-empty" means the TOKEN, not the header: a bare `'Bearer '` passes
 * `startsWith` and would otherwise report a server as connected on a header
 * carrying no credential at all. Not reachable through the injection path today
 * — the OAuth engine injects a token or no header — but the docblock said
 * non-empty and the check did not, and the next caller reads the docblock.
 */
function hasBearerHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  const prefix = 'Bearer ';
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === 'authorization' &&
      value.startsWith(prefix) &&
      value.length > prefix.length
  );
}
