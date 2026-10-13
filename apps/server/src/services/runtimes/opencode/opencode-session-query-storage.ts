import { readOriginalOpenCodeRuntimeView } from './opencode-runtime.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { Session, HistoryMessage, TaskItem } from '@dorkos/shared/types';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import {
  getOrCreateProjector,
  peekProjector,
  streamGenerationOf,
} from '../../session/session-state-projector.js';
import { readLogBackedHistory } from '../../session/log-backed-history.js';
import { SessionDiscoveryUnavailableError } from '../../session/resolution/session-lookup-error.js';
import { overlayRecordedHistory } from '../../session/overlays/recorded-history.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logger, logError } from '../../../lib/logger.js';
import { mapOpenCodeTodos } from './events/session-event-mapper.js';
import { isDerivedOpenCodeSessionId, unwrap } from './sessions/session-mapper.js';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';

/**
 * @inheritdoc
 *
 * The sidecar's listing (via the mapper — fast `[]` on a cold sidecar) is
 * the source of truth, unioned with tracked-but-unlisted sessions (created
 * while the sidecar was cold, or still binding). Listed sessions hardcode
 * `permissionMode: 'default'` (OpenCode has no per-session mode), so the
 * DorkOS-tracked settings are overlaid; restart-persisted settings are
 * overlaid one layer up from `session_metadata` (ADR-0260).
 *
 * The sidecar is asked in the CANONICAL spelling of the directory, because
 * that is the spelling it stored (DOR-695 — see {@link canonicalDirectory}).
 * The registry is asked in the spelling the caller used, and reconciles the
 * two itself: it holds the cwd whoever created each session used, which is
 * its own third spelling of the same folder.
 */
export async function listSessions(runtimeOwner: object, projectDir: string): Promise<Session[]> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const listed = await facet.mapper.listSessions(canonicalDirectory(projectDir));
  const byId = new Map(listed.map((session) => [session.id, session]));
  for (const tracked of facet.registry.list(projectDir)) {
    if (!byId.has(tracked.id)) byId.set(tracked.id, tracked);
  }
  const sessions = [...byId.values()];
  for (const session of sessions) facet.overlayTrackedSettings(session);
  return sessions;
}

/**
 * @inheritdoc
 *
 * The cheap path reads the sidecar listing + tracked registry. On a miss
 * with a KNOWN durable binding (post-restart, cold sidecar — `listSessions`
 * never boots), falls through to the mapper's targeted single-session read,
 * which boots the sidecar: a bookmarked id must resolve after a restart
 * instead of 404ing until something else warms the sidecar (DOR-251).
 */
export async function findSession(
  runtimeOwner: object,
  sessionId: string
): Promise<Session | null> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  return facet.mapper.findSession(DEFAULT_CWD, sessionId);
}

/** Run the original guarded getSession operation. */
export async function getSession(
  runtimeOwner: object,
  projectDir: string,
  sessionId: string
): Promise<Session | null> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const sessions = await facet.listSessions(projectDir);
  const listed = sessions.find((session) => session.id === sessionId);
  if (listed) return listed;
  const session = await facet.mapper.getSession(canonicalDirectory(projectDir), sessionId);
  if (session) facet.overlayTrackedSettings(session);
  return session;
}

/**
 * @inheritdoc
 *
 * OpenCode's store is durable — history comes from the sidecar through the
 * mapper (booting it when needed), so revisits survive both DorkOS and
 * sidecar restarts. A known native conversation reports unavailable when
 * its store cannot be read; a partial EventLog cannot stand in for its
 * transcript. Only an unbound draft may use the DorkOS-owned event stream.
 */
export async function getMessageHistory(
  runtimeOwner: object,
  projectDir: string,
  sessionId: string
): Promise<HistoryMessage[]> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  try {
    // The sidecar's store names the model that ran and never one DorkOS
    // credits put in place of the session's (DOR-2636), so that notice is
    // put back from the durable event record, as for Claude Code.
    // Its store keeps no compaction row at all, so a summary the agent asked
    // for (DOR-2732) is drawn back from the same record.
    return overlayRecordedHistory(
      sessionId,
      await facet.mapper.getMessageHistory(canonicalDirectory(projectDir), sessionId)
    );
  } catch (err) {
    if (
      facet.mapper.getOpenCodeSessionId(sessionId) !== undefined ||
      isDerivedOpenCodeSessionId(sessionId)
    ) {
      throw new SessionDiscoveryUnavailableError(facet.type);
    }
    logger.debug(
      '[OpenCodeRuntime] native history read failed — serving durable EventLog fallback',
      logError(err)
    );
    return readLogBackedHistory(sessionId);
  }
}

/**
 * @inheritdoc
 *
 * Completed `messages` load from the durable native store (same source as
 * `getMessageHistory`, with its EventLog fallback); the live turn, status,
 * pending interactions, and cursor come from the projector — the pattern
 * ADR-0263 prescribes for adapters that own a real history source.
 */
export async function getSessionSnapshot(
  runtimeOwner: object,
  ctx: SessionOpts,
  sessionId: string
): Promise<SessionSnapshot> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const projector = getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' });
  return projector.buildSnapshot(() => facet.getMessageHistory(ctx.cwd ?? DEFAULT_CWD, sessionId));
}

/**
 * @inheritdoc
 *
 * Delegates to the projector's resumable seq'd stream — the SAME projector
 * the trigger path feeds, so `/events` serves an OpenCode turn through
 * exactly the code path the Claude adapter uses.
 */
export function subscribeSession(
  runtimeOwner: object,
  ctx: SessionOpts,
  sessionId: string,
  sinceCursor?: number,
  signal?: AbortSignal
): AsyncIterable<SessionEvent> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return getOrCreateProjector(sessionId, ctx.cwd, { persist: 'history' }).subscribe(
    sinceCursor,
    signal
  );
}

/**
 * @inheritdoc
 *
 * The registry answers directly here: OpenCode keys its projectors by the
 * DorkOS session id and holds no second id to resolve through, so this reads
 * the same entry {@link subscribeSession} binds to. Peek-only — asking which
 * counter serves a session must not mint one, and the fresh projector a
 * subsequent subscribe would mint refuses every cursor above 0 anyway.
 */
export function streamGeneration(
  runtimeOwner: object,
  _ctx: SessionOpts,
  sessionId: string
): string {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return streamGenerationOf(peekProjector(sessionId));
}

/**
 * @inheritdoc
 *
 * Emits the tracked-session inventory then live upserts (create, rename,
 * message activity through DorkOS). Sessions created outside DorkOS (the
 * OpenCode TUI) surface through `listSessions`; watching the sidecar's
 * `session.created/updated` global events for true external discovery is a
 * flagged follow-up. `session_status` liveness fans out runtime-neutrally
 * from the projector via the session-list broadcaster.
 */
export function subscribeSessionList(
  runtimeOwner: object,
  _ctx: SessionOpts
): AsyncIterable<SessionListEvent> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  return facet.registry.subscribe();
}

/**
 * @inheritdoc
 *
 * Reads the sidecar's own todo store (`GET /session/{id}/todo` — the same
 * Todo shape `todo.updated` streams). Peek-only: a cold sidecar has no live
 * session whose tasks could be non-empty.
 */
export async function getSessionTasks(
  runtimeOwner: object,
  _projectDir: string,
  sessionId: string
): Promise<TaskItem[]> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const ocSessionId = facet.mapper.getOpenCodeSessionId(sessionId);
  const client = facet.provider.peekClient();
  if (!ocSessionId || !client) return [];
  try {
    const todos = unwrap(await client.session.todo({ path: { id: ocSessionId } }), 'session.todo');
    return mapOpenCodeTodos(todos);
  } catch (err) {
    logger.debug('[OpenCodeRuntime] todo read failed', logError(err));
    return [];
  }
}

/** Run the original guarded getSessionETag operation. */
export async function getSessionETag(runtimeOwner: object): Promise<string | null> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return null;
}

/** Run the original guarded getLastMessageIds operation. */
export async function getLastMessageIds(
  runtimeOwner: object
): Promise<{ user: string; assistant: string } | null> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return null;
}

/** No byte-addressable transcript exists — OpenCode's store is opaque (ADR-0308). */
export async function readFromOffset(
  runtimeOwner: object
): Promise<{ content: string; newOffset: number }> {
  readOriginalOpenCodeRuntimeView(runtimeOwner);
  return { content: '', newOffset: 0 };
}

/**
 * The OpenCode session bound to a DorkOS session, creating one when needed.
 * Concurrent callers (an eager `ensureSession` bind racing the first
 * `sendMessage`) share one in-flight creation, so a session can never bind
 * to two OpenCode sessions.
 */
export function resolveOpenCodeSession(
  runtimeOwner: object,
  sessionId: string,
  cwd: string,
  title?: string
): Promise<string> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const existing = facet.mapper.getOpenCodeSessionId(sessionId);
  if (existing !== undefined) return Promise.resolve(existing);
  const inflight = facet.binding.get(sessionId);
  if (inflight) return inflight;
  const creating = facet.mapper
    .ensureSession(sessionId, {
      cwd: canonicalDirectory(cwd),
      ...(title !== undefined ? { title } : {}),
    })
    .finally(() => {
      if (facet.binding.get(sessionId) === creating) facet.binding.delete(sessionId);
    });
  facet.binding.set(sessionId, creating);
  return creating;
}

/**
 * The directory AS STORED BY OPENCODE for a session — the demux key half
 * that must never be substituted with the DorkOS cwd (strict string
 * equality; trailing-slash or symlink drift would silently drop every
 * event). Read once via `session.get` and cached; failure is loud — a turn
 * without a trustworthy demux key must not run.
 */
export async function resolveSessionDirectory(
  runtimeOwner: object,
  client: OpencodeClient,
  ocSessionId: string
): Promise<string> {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const cached = facet.directoryByOcId.get(ocSessionId);
  if (cached !== undefined) return cached;
  const session = unwrap(await client.session.get({ path: { id: ocSessionId } }), 'session.get');
  facet.directoryByOcId.set(ocSessionId, session.directory);
  return session.directory;
}

/**
 * Overlay DorkOS-tracked settings onto a listed session — OpenCode has no
 * per-session permission mode, so the mapper hardcodes `'default'` and the
 * tracked value (kept current by `updateSession`) wins.
 */
export function overlayTrackedSettings(runtimeOwner: object, session: Session): void {
  const facet = readOriginalOpenCodeRuntimeView(runtimeOwner);
  const tracked = facet.registry.get(session.id);
  if (!tracked) return;
  session.permissionMode = tracked.permissionMode;
  if (tracked.model !== undefined) session.model = tracked.model;
  if (tracked.fastMode !== undefined) session.fastMode = tracked.fastMode;
}
