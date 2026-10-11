import { readOriginalClaudeSessionQueryView } from '../claude-code-runtime.js';
import path from 'path';
import type { Session, SessionListWarning, HistoryMessage, TaskItem } from '@dorkos/shared/types';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type {
  SessionSnapshot,
  SessionEvent,
  SessionListEvent,
} from '@dorkos/shared/session-stream';
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import type { SessionStateProjector } from '../../../session/index.js';
import type { TranscriptImageRef } from '../sessions/transcript-parser.js';
import { attachTranscriptImages } from '../media-capture.js';
import { watchSessionList } from '../sessions/session-list-watcher.js';
import { isCreditsClaudeRoot } from '../credits-root.js';
import { predictLaunchBillsPerToken, readPerTokenSignals } from '../messaging/per-token-billing.js';
import {
  getOrCreateProjector,
  streamGenerationOf,
} from '../../../session/session-state-projector.js';
import { overlayApprovalReceipts } from '../../../session/overlays/approval-receipt-overlay.js';
import { overlayModelSubstitutions } from '../../../session/overlays/model-substitution-overlay.js';
import { overlayAgentCompactions } from '../../../session/overlays/agent-compaction-overlay.js';
import { overlayPermissionDenials } from '../../../session/overlays/permission-denial-overlay.js';
import { logger } from '../../../../lib/logger.js';

/** Original live collaborators and callback reads, reachable only through the actual runtime's private query key. */
export interface OriginalClaudeSessionQueries {
  readonly transcriptReader: TranscriptReader;
  readonly sessionStore: SessionStore;
  readonly cwd: string;
  readonly attachments: SessionAttachmentStore | null;
  readonly getInternalSessionId: (sessionId: string) => string | undefined;
  readonly resolveLiveProjector: (sessionId: string) => SessionStateProjector | undefined;
  readonly getMessageHistory: (projectDir: string, sessionId: string) => Promise<HistoryMessage[]>;
  readonly streamProjector: (ctx: SessionOpts, sessionId: string) => SessionStateProjector;
}

const originalQueryFreeze = Object.freeze;
const originalQueryGet = WeakMap.prototype.get;
const originalQuerySet = WeakMap.prototype.set;
const originalQueryApply = Reflect.apply;

/** Allocate unrelated read/register custody; operations always resolve the original root's instance. */
export function createIsolatedClaudeSessionQueryCustody() {
  const contexts = new WeakMap<object, Readonly<OriginalClaudeSessionQueries>>();
  function read(key: object): Readonly<OriginalClaudeSessionQueries> {
    const own = originalQueryApply(originalQueryGet, contexts, [key]) as
      Readonly<OriginalClaudeSessionQueries> | undefined;
    if (!own) throw new Error('Original Claude session query is unavailable.');
    return own;
  }
  function register(key: object, context: Readonly<OriginalClaudeSessionQueries>): void {
    originalQueryApply(originalQuerySet, contexts, [key, context]);
  }
  return originalQueryFreeze({ register, read });
}

/** Execute the original listSessions query only after the actual runtime private-key lookup. */
export async function listSessions(ownerKey: object, projectDir: string): Promise<Session[]> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.listSessions(projectDir);
}

/** Execute the original listSessionsWithWarnings query only after the actual runtime private-key lookup. */
export async function listSessionsWithWarnings(
  ownerKey: object,
  projectDir: string
): Promise<{ sessions: Session[]; warnings: SessionListWarning[] }> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.listSessionsAcrossAccounts(projectDir);
}

/** Execute the original findSession query only after the actual runtime private-key lookup. */
export async function findSession(ownerKey: object, sessionId: string): Promise<Session | null> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.findSession(sessionId);
}

/** Execute the original getSession query only after the actual runtime private-key lookup. */
export async function getSession(
  ownerKey: object,
  projectDir: string,
  sessionId: string
): Promise<Session | null> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.getSession(projectDir, sessionId);
}

/** Execute the original sessionBillsPerToken query only after the actual runtime private-key lookup. */
export async function sessionBillsPerToken(ownerKey: object, sessionId: string): Promise<boolean> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  const session = facet.sessionStore.findSession(sessionId);
  if (session?.launchedPerToken !== undefined) return session.launchedPerToken;
  if (session?.lastSubscriptionUsage?.kind === 'subscription') return false;
  const root = session?.accountRoot;
  return predictLaunchBillsPerToken(
    readPerTokenSignals(root !== undefined && isCreditsClaudeRoot(root))
  );
}

/** Execute the original readContextUsage query only after the actual runtime private-key lookup. */
export async function readContextUsage(
  ownerKey: object,
  sessionId: string,
  cwd: string | undefined
): Promise<{ contextTokens: number; contextMaxTokens: number } | null> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  try {
    const projectDir = cwd ?? facet.sessionStore.findSession(sessionId)?.cwd ?? facet.cwd;
    const historyId = facet.getInternalSessionId(sessionId) ?? sessionId;
    const session = await facet.transcriptReader.getSession(projectDir, historyId);
    if (!session?.contextTokens) return null;
    return { contextTokens: session.contextTokens, contextMaxTokens: 0 };
  } catch {
    return null;
  }
}

/** Execute the original getMessageHistory query only after the actual runtime private-key lookup. */
export async function getMessageHistory(
  ownerKey: object,
  projectDir: string,
  sessionId: string
): Promise<HistoryMessage[]> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  const images: TranscriptImageRef[] = [];
  const messages = await facet.transcriptReader.readTranscript(projectDir, sessionId, images);
  // The same seam, for the same reason: the reader stays a JSONL parser, and
  // what DorkOS did with the bytes a tool returned is overlaid back here.
  // Re-materializing is idempotent — the attachment id is derived from the
  // tool call, so reopening a transcript finds the first read's file instead
  // of writing a second copy (`media-capture.ts`).
  //
  // **Idempotent only because both paths key storage on the CANONICAL id.**
  // `sessionId` here is already canonical: both callers translate first
  // (`getSessionSnapshot`'s `historyId`, and `GET /:id/messages`'s
  // `internalSessionId`), because the transcript on disk is named by it. The
  // live path had to be taught to match — it stores under
  // `session.sdkSessionId`, not the id its turn was asked with, which on a new
  // session's first turn is a different string. Keyed on the request id, this
  // call looked in a directory the live turn never wrote to and produced a
  // second copy at a second URL (DOR-1664 review).
  //
  // claude-code is the only runtime that can hit this, and both halves of the
  // reason are here: it is the only one that RENAMES a session mid-turn
  // (`getInternalSessionId` returns undefined for codex and opencode), and the
  // only one that rebuilds history by re-parsing a transcript rather than
  // replaying recorded `image_attachment` events, which carry their URL
  // (`services/session/event-log-history.ts`).
  await attachTranscriptImages(facet.attachments, sessionId, messages, images);
  // And the third pass, for the refusals nobody was asked about (DOR-795): a
  // BACKGROUNDED subagent's denied tool call is written into the child's
  // transcript, not this one, so without this the conversation comes back
  // showing an agent that stopped making progress for no stated reason.
  // And the fourth, for turns that ran on another model than the session
  // names because DorkOS credits do not cover it (DOR-2636): the transcript
  // names the model that ran and never the one it replaced.
  // And the fifth, for summaries the agent asked for itself (DOR-2732): the
  // transcript records that the conversation was summarized, never who asked.
  return overlayAgentCompactions(
    sessionId,
    overlayModelSubstitutions(
      sessionId,
      overlayPermissionDenials(sessionId, overlayApprovalReceipts(sessionId, messages))
    )
  );
}

/** Execute the original getSessionSnapshot query only after the actual runtime private-key lookup. */
export async function getSessionSnapshot(
  ownerKey: object,
  ctx: SessionOpts,
  sessionId: string
): Promise<SessionSnapshot> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  const projectDir = ctx.cwd ?? facet.cwd;
  const historyId = facet.getInternalSessionId(sessionId) ?? sessionId;
  const projector =
    facet.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, projectDir);
  return projector.buildSnapshot(() => facet.getMessageHistory(projectDir, historyId));
}

/** Execute the original subscribeSession query only after the actual runtime private-key lookup. */
export function subscribeSession(
  ownerKey: object,
  ctx: SessionOpts,
  sessionId: string,
  sinceCursor?: number,
  signal?: AbortSignal
): AsyncIterable<SessionEvent> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.streamProjector(ctx, sessionId).subscribe(sinceCursor, signal);
}

/** Execute the original streamGeneration query only after the actual runtime private-key lookup. */
export function streamGeneration(ownerKey: object, _ctx: SessionOpts, sessionId: string): string {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return streamGenerationOf(facet.resolveLiveProjector(sessionId));
}

/** Execute the original streamProjector query only after the actual runtime private-key lookup. */
export function streamProjector(
  ownerKey: object,
  ctx: SessionOpts,
  sessionId: string
): SessionStateProjector {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return (
    facet.resolveLiveProjector(sessionId) ?? getOrCreateProjector(sessionId, ctx.cwd ?? facet.cwd)
  );
}

/** Execute the original subscribeSessionList query only after the actual runtime private-key lookup. */
export function subscribeSessionList(
  ownerKey: object,
  _ctx: SessionOpts
): AsyncIterable<SessionListEvent> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return watchSessionList(facet.transcriptReader);
}

/** Execute the original getSessionTasks query only after the actual runtime private-key lookup. */
export async function getSessionTasks(
  ownerKey: object,
  projectDir: string,
  sessionId: string
): Promise<TaskItem[]> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.readTasks(projectDir, sessionId);
}

/** Execute the original getSessionETag query only after the actual runtime private-key lookup. */
export async function getSessionETag(
  ownerKey: object,
  projectDir: string,
  sessionId: string
): Promise<string | null> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.getTranscriptETag(projectDir, sessionId);
}

/** Execute the original getSessionCwd query only after the actual runtime private-key lookup. */
export function getSessionCwd(ownerKey: object, sessionId: string): string | undefined {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.sessionStore.findSession(sessionId)?.cwd;
}

/** Execute the original getSessionAccount query only after the actual runtime private-key lookup. */
export function getSessionAccount(ownerKey: object, sessionId: string): string | undefined {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  const session = facet.sessionStore.findSession(sessionId);
  const root = session?.launchedAccountRoot ?? session?.accountRoot;
  return root === undefined ? undefined : path.resolve(root);
}

/** Execute the original getLastMessageIds query only after the actual runtime private-key lookup. */
export async function getLastMessageIds(
  ownerKey: object,
  sessionId: string
): Promise<{ user: string; assistant: string } | null> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  try {
    const session = facet.sessionStore.findSession(sessionId);
    const projectDir = session?.cwd ?? facet.cwd;
    const messages = await facet.transcriptReader.readTranscript(projectDir, sessionId);
    if (!messages.length) return null;

    let lastUser: string | null = null;
    let lastAssistant: string | null = null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!lastAssistant && m.role === 'assistant') lastAssistant = m.id;
      if (!lastUser && m.role === 'user') lastUser = m.id;
      if (lastUser && lastAssistant) break;
    }

    if (!lastUser || !lastAssistant) return null;
    return { user: lastUser, assistant: lastAssistant };
  } catch (err) {
    logger.warn('[getLastMessageIds] failed to read transcript', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Execute the original readFromOffset query only after the actual runtime private-key lookup. */
export async function readFromOffset(
  ownerKey: object,
  projectDir: string,
  sessionId: string,
  offset: number
): Promise<{ content: string; newOffset: number }> {
  const facet = readOriginalClaudeSessionQueryView(ownerKey);
  return facet.transcriptReader.readFromOffset(projectDir, sessionId, offset);
}
