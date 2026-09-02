import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  AUTONOMY_ACK_REQUIRED_CODE,
  hasStandingAutonomyAck,
} from '../services/core/approvals/autonomy-consent.js';
import { reportUsageEvent } from '../services/core/usage-reporter.js';
import {
  UpdateSessionRequestSchema,
  ForkSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitElicitationRequestSchema,
  ListSessionsQuerySchema,
  RecentSessionsQuerySchema,
  SessionDailyCountsQuerySchema,
} from '@dorkos/shared/schemas';
import type { ModelOption, PermissionMode, PermissionModeId } from '@dorkos/shared/types';
import type { AgentRuntime, PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { MeshCore } from '@dorkos/mesh';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import { isAutonomyStop, needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { readManifest } from '@dorkos/shared/manifest';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logError, logger } from '../lib/logger.js';
import { runInDispatch } from '../lib/dispatch-context.js';
import {
  recordDispatchEnd,
  recordDispatchStart,
} from '../services/observability/dispatch-buffers.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import {
  readCallerAuthority,
  requireOperatorCookieUnderLogin,
  type OperatorCookieRefusal,
} from '../lib/caller-authority.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { askEntitlement, type AskSubject } from '../services/session/asks/ask-entitlement.js';
import { getUserById, readOwnerAccount, type RequestUser } from '../services/core/auth/index.js';
import { resolveAnswererName } from '../services/identity/operator-profile.js';
import { configManager } from '../services/core/config-manager.js';
import type { RoomBindingsPort } from '../services/session/index.js';
import {
  aggregateSessionList,
  listRecentSessions,
  listPendingInteractionsAcrossSessions,
  countSessionsPerDay,
  getOrCreateProjector,
  persistenceModeFor,
  dispatchMessage,
  clearQueuedMessages,
  applySessionOriginOverlays,
  sessionOriginResolvers,
  overlayStoredSettings,
  callerNamedCwd,
  resolveSessionCwdOrDefault,
  resolveSessionCwdOrNull,
} from '../services/session/index.js';
import { sessionUiActionHandler } from './session-ui-action-handler.js';
import {
  sessionQueueListHandler,
  sessionQueueRemoveHandler,
  sessionQueueUpdateHandler,
} from './session-queue-handler.js';
import { sessionEventsHandler } from './session-events-handler.js';
import { sessionCommandIntentHandler } from './session-command-intent-handler.js';
import { sessionDevtoolsIngestHandler } from './session-devtools.js';
import { sessionAttachmentHandler } from './session-attachments-handler.js';
import { sessionMcpAppResourceHandler } from './session-mcp-app-resource-handler.js';
import path from 'node:path';
import { sanitizeWorkspaceKey } from '@dorkos/shared/workspace';
import { getWorkspaceManager } from '../services/workspace/index.js';
import { resolveSessionCwd } from '../services/workspace/resolve-session-cwd.js';
// A control request that outlived its bound is not a claude-code-only idea, but
// claude-code is the only runtime with one today, so the class still lives with
// its clock. A second runtime growing one is the signal to move it somewhere
// runtime-neutral rather than to import a second class here.
import { ControlRequestTimeoutError } from '../services/runtimes/claude-code/sessions/bounded-control.js';

const vaultRoot = DEFAULT_CWD;

const router = Router();

/**
 * What a caller is told when it tried to answer a prompt without being a person
 * signed in on this machine.
 *
 * Written for whoever ends up reading it, which is often an agent relaying it to
 * a person: it says WHERE the answer has to happen, not which header was
 * missing. A refusal that names a header reads as a hint about how to get around
 * it. The same reasoning, and nearly the same sentence, as the capability
 * approvals' `DECIDE_NEEDS_COCKPIT`.
 */
const ANSWERING_NEEDS_COCKPIT =
  'Answering an agent has to happen inside DorkOS, by a person who is signed in. ' +
  'A program holding an API key cannot answer for you. Open DorkOS and answer it there.';

/**
 * Refuse anything that is not a person in the cockpit answering for themselves.
 *
 * These six routes were protected by `sessionGate` alone, which was defensible
 * while the only way to reach them was the session you were looking at.
 * Broadcasting the Ask to every route makes them reachable from everywhere, and
 * DOR-609's lesson is that _who acted_ is not _who may_.
 *
 * **Fail-closed and structural.** An agent that presents its identity header can
 * never answer ANY prompt, its own included, because `readCallerAuthority`
 * reports `agentIdentityPresented` for a header that did not even resolve — a
 * revoked token still means a machine is calling. There is therefore no id to
 * compare and no way to spoof one: "the requester never self-approves" is a
 * property of what the path accepts, not a check it runs.
 *
 * Under login-on, a caller holding a per-user API key is refused too. An agent
 * legitimately holds one of the person's keys — it is how a Codex or OpenCode
 * agent reaches the operator surface at all — which is exactly the residual
 * DOR-474 closed for capability approvals and this closes for tool prompts.
 *
 * With login off `requireOperatorCookieUnderLogin` allows, because there is no
 * cookie for anyone to present. That is the named, documented residual, and it
 * is identical to the one capability approvals carry: see
 * `lib/caller-authority.ts`.
 *
 * Composed from shipped pieces, with no new predicate, so "who counts as a
 * person" cannot mean one thing at an approval and another at a tool prompt.
 *
 * ## Its relationship to `askEntitlement`
 *
 * `services/session/asks/ask-entitlement.ts` is the shared statement of who may
 * answer, and every surface that SHOWS an Ask reads it. This guard is not
 * changed to call it and is not given a second gate: under one account an
 * entitlement check behind this bar could never fail, and a check that cannot
 * discriminate is worse than none. What holds the two together instead is
 * `services/session/asks/__tests__/ask-answer-conformance.test.ts`, which drives
 * the same callers through both and fails if they disagree — so the day a
 * second person exists, one of them cannot quietly widen.
 *
 * @param req - The incoming request.
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns `undefined` when the caller may answer, or the refusal to answer with.
 */
function requirePersonToAnswer(req: Request, res: Response): OperatorCookieRefusal | undefined {
  const authority = resolveDecisionAuthority(readCallerAuthority(req, res));
  if (!authority.allowed) {
    return { status: authority.status, code: authority.code, error: authority.error };
  }
  const notAPerson = requireOperatorCookieUnderLogin(res, 'whether a tool runs');
  return notAPerson ? { ...notAPerson, error: ANSWERING_NEEDS_COCKPIT } : undefined;
}

/**
 * What to call whoever is answering, so the receipt in every OTHER window can
 * name them instead of saying only "Already answered at 2:01".
 *
 * Runs only after {@link requirePersonToAnswer} has already decided the caller
 * is a person, which is what makes the answer honest: this resolves a NAME, not
 * an identity, and would be a claim about who acted if anything else could get
 * this far.
 *
 * The name is read here rather than sent by the client for the same reason a
 * room's author is (`routes/room-caller.ts`): a caller that could name itself
 * could sign somebody else's decision. Under login-on that is the signed-in
 * account; with login off it is whoever owns this install, and on an install
 * with no accounts at all it is the name the person told DorkOS to call them.
 * When none of those exists there is nothing honest to print, and the receipt
 * falls back to the unnamed sentence.
 *
 * **This install has exactly one person in it** (ADR 260727-184933 D6), so the
 * name is that person's however they reached the cockpit. It becomes a real
 * lookup the day DorkOS has more than one, which is the same day the Ask needs
 * a per-caller entitlement filter.
 *
 * @param res - The response carrying `sessionGate`'s resolved user.
 * @returns The name to put on the receipt, or `undefined` when none is known or
 *   the lookup failed.
 */
function answeredBy(res: Response): string | undefined {
  const user = res.locals.user as RequestUser | undefined;
  try {
    return resolveAnswererName({
      account: () => (user ? getUserById(user.userId) : readOwnerAccount()),
      configDisplayName: () => configManager.get('profile')?.displayName ?? null,
    });
  } catch (err) {
    // Two disk reads for a cosmetic label sit inside the path that decides
    // whether a tool runs. A locked database or an unreadable config must cost
    // the receipt its name, never the person their answer, so the throw is
    // swallowed here rather than 500ing an approve.
    logger.warn('[POST /answer] could not resolve who is answering; the receipt goes unnamed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

// GET /api/sessions - List sessions aggregated across all registered runtimes
// (ADR-0310). Responds with the { sessions, warnings? } envelope rather than a
// bare array: aggregation degrades gracefully per runtime, and the in-band
// warnings[] must survive both transports (an HTTP header would be invisible
// to the Direct in-process transport). See SessionListResponseSchema.
router.get('/', async (req, res) => {
  const parsed = ListSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { limit, cwd, runtime: runtimeFilter } = parsed.data;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;
  if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
    return sendError(res, 400, `Unknown runtime: ${runtimeFilter}`, 'UNKNOWN_RUNTIME');
  }

  const projectDir = cwd || vaultRoot;
  const runtimes = runtimeFilter
    ? [runtimeRegistry.get(runtimeFilter)]
    : runtimeRegistry.listRuntimes();
  const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });

  const page = sessions.slice(0, limit);
  // Overlay persisted settings (ADR-0260) through the ONE shared resolver that
  // `GET /:id` also uses, so the two endpoints cannot report different modes
  // for one session (DOR-463).
  overlayStoredSettings(page, runtimeRegistry);
  // Overlay the origins no transcript can carry — the room binding and the Pulse
  // run (session-origin-legibility, team-room-home §D2.3). The ordering rule
  // lives in `applySessionOriginOverlays`, which the global session-list stream
  // applies too, so a room turn reads the same way whichever one a client heard
  // it from (DOR-1141).
  applySessionOriginOverlays(page, sessionOriginResolvers(req.app.locals));
  res.json(warnings.length > 0 ? { sessions: page, warnings } : { sessions: page });
});

// GET /api/sessions/recent - Most-recent sessions across ALL agents (DOR-329).
// MUST be registered before the `/:id` routes below, or Express 5 would capture
// `recent` as an `:id` param. Resolves agent project paths server-side via the
// mesh registry, then fans out via listRecentSessions (bounded concurrency,
// subtree cwd membership per DOR-203 + DOR-674, ADR-0310 per-runtime
// degradation).
router.get('/recent', async (req, res) => {
  const parsed = RecentSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { limit } = parsed.data;

  const meshCore = req.app.locals.meshCore as MeshCore | undefined;
  const agentPaths = meshCore ? meshCore.listWithPaths().map((a) => a.projectPath) : [];
  const runtimes = runtimeRegistry.listRuntimes();

  const { sessions, agentActivity, warnings } = await listRecentSessions({
    runtimes,
    agentPaths,
    limit,
  });
  // Same persisted-settings overlay as the other two session reads — a recent
  // session is the same session, so it must not report a different mode.
  overlayStoredSettings(sessions, runtimeRegistry);
  // The same origin overlays the list endpoint applies, in the same order — a
  // room turn is an engine run under a thread the reader can already see, and
  // the binding table is the only place that knows.
  applySessionOriginOverlays(sessions, sessionOriginResolvers(req.app.locals));
  res.json({ sessions, agentActivity, warnings });
});

// GET /api/sessions/daily-counts - Sessions started per day across ALL agents
// (DOR-1039). Same registration rule as `/recent` above: it MUST precede the
// `/:id` routes or Express 5 captures `daily-counts` as an `:id`. Backs the
// Activity tab's week line, which sits above a machine-wide feed and so must
// count at that same machine-wide SCOPE rather than one project's sessions.
router.get('/daily-counts', async (req, res) => {
  const parsed = SessionDailyCountsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { days } = parsed.data;

  const meshCore = req.app.locals.meshCore as MeshCore | undefined;
  const agentPaths = meshCore ? meshCore.listWithPaths().map((a) => a.projectPath) : [];

  const { dailyCounts, warnings } = await countSessionsPerDay({
    runtimes: runtimeRegistry.listRuntimes(),
    agentPaths,
    days,
  });
  res.json({ days, dailyCounts, warnings });
});

// GET /api/sessions/pending-interactions — every prompt anywhere on this
// machine that is waiting on a person (spec `unified-conversation` §3.3).
//
// MUST be registered before the `/:id` routes below, or Express 5 captures
// `pending-interactions` as an `:id` — the same trap `/recent` and
// `/daily-counts` document, and the reason this route is not `/:id/…`-shaped.
//
// The live stream carries transitions (`interaction_pending` /
// `interaction_resolved`), which is complete for a window that was open when
// each fired and empty for one that was not. This is what a window reads on
// mount so an Ask raised a minute ago shows up as fast as one raised now.
//
// AUTHORITY: `sessionGate`, and then `askEntitlement` per row. Reading that
// something needs a person is still not deciding it, and the header pill must
// count for a cockpit that has not yet proven itself for a decision — a caller
// holding one of the person's API keys sees every Ask here and still cannot
// answer one. What changed (DOR-1356) is that a caller which is not a person AT
// ALL gets nothing: an agent presenting `X-DorkOS-Agent` could otherwise list
// every pending shell command in every project on the machine. Deciding runs
// `requirePersonToAnswer` below, which `asks/ask-entitlement.ts` is bound to by
// a conformance test.
//
// An unentitled caller gets `200` with an empty array, never `403`. That is the
// rooms domain's own rule — "not a member answers exactly as no such room" — so
// the response never tells a machine that Asks exist.
router.get('/pending-interactions', (req, res) => {
  const bindings = req.app.locals.roomSessionBindings as RoomBindingsPort | undefined;
  const principal = readCallerPrincipal(req, res);
  const interactions = listPendingInteractionsAcrossSessions().flatMap((row) => {
    const binding = bindings?.bindingForSession(row.sessionId);
    // No `approvers`: nothing on a chat platform reaches this route, so a
    // `bridged` principal is unreachable here. See `AskSubject.approvers`.
    const subject: AskSubject = {
      sessionId: row.sessionId,
      ...(binding ? { roomId: binding.roomId } : {}),
    };
    if (askEntitlement(principal, subject) === 'none') return [];
    return [
      {
        sessionId: row.sessionId,
        cwd: row.cwd,
        interaction: row.interaction,
        ...(binding ? { roomId: binding.roomId, roomAuthorId: binding.authorId } : {}),
      },
    ];
  });
  // `warnings` is present in the schema and empty here. It exists because this
  // is the natural home for a future runtime that cannot answer the question,
  // and adding the field later would be a breaking response change.
  res.json({ interactions });
});

// GET /api/sessions/:id/runtime-type — Lightweight endpoint for clients that
// need only the runtime owner. Uses getSessionRuntimeType, which infers on a
// miss ('claude-code' for legacy sessions predating the table) and NEVER
// writes: a read path that back-filled would mint a ghost row for any id it
// was handed, and first-write-wins would make that guess the binding (DOR-812).
router.get('/:id/runtime-type', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
  const runtime = await runtimeRegistry.getSessionRuntimeType(sessionId);
  res.json({ runtime });
});

// GET /api/sessions/:id - Get session details
// Like `/:id/messages`, no `?cwd=` is required for a session the server can
// already place (DOR-1444): a window that opened the session URL without `&dir=`
// used to read the default project directory, which finds nothing — and, on a
// server whose default sits outside the configured boundary, threw rather than
// answering. Both now resolve through the same ladder.
router.get('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;
  if (!(await assertBoundary(cwdParam, res, { allowDorkHome: true }))) return;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const projectDir = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
  if (!projectDir) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  // A directory the caller never named is judged here — otherwise omitting
  // `?cwd=` would read a session that naming the same directory is refused for.
  if (
    !callerNamedCwd(cwdParam) &&
    !(await assertBoundary(projectDir, res, { allowDorkHome: true }))
  )
    return;
  const session = await runtime.getSession(projectDir, internalSessionId);
  if (!session) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  // Adapters tag `runtime` themselves (task 1.1); backstop sloppy ones so
  // the required field always reaches the wire.
  if (!session.runtime) session.runtime = runtime.type;
  // Overlay persisted settings (ADR-0260) so the toolbar reflects the operator's
  // chosen mode/model/etc., not just what the transcript recorded. Same shared
  // resolver (and therefore the same single key) as the list endpoint above —
  // including when this route is reached by a retired id, since the resolver
  // keys off the session it actually resolved, not the id asked for.
  overlayStoredSettings([session], runtimeRegistry);
  applySessionOriginOverlays([session], sessionOriginResolvers(req.app.locals));
  res.json(session);
});

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get('/:id/tasks', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res, { allowDorkHome: true }))) return;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  // Lenient rather than 404-capable: a task read that cannot place the session
  // already answers "no tasks" honestly, and the live binding is what makes the
  // no-`&dir=` window read the right transcript (DOR-1444).
  const cwd = resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
  // A directory the caller never named is judged here — otherwise omitting
  // `?cwd=` would read a session that naming the same directory is refused for.
  if (!callerNamedCwd(cwdParam) && !(await assertBoundary(cwd, res, { allowDorkHome: true })))
    return;

  const etag = await runtime.getSessionETag(cwd, internalSessionId);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  try {
    const tasks = await runtime.getSessionTasks(cwd, internalSessionId);
    res.json({ tasks });
  } catch {
    sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }
});

// GET /api/sessions/:id/messages - Get message history from SDK transcript.
// No `?cwd=` is required for a session the server can already place — see
// resolveSessionCwdOrNull. A session it genuinely cannot place answers 404 rather
// than an empty list, so "no messages yet" and "wrong/missing cwd" are never
// the same response (DOR-1322).
router.get('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res, { allowDorkHome: true }))) return;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  const cwd = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
  if (!cwd) {
    return sendError(
      res,
      404,
      "Could not determine this session's working directory. Pass ?cwd= with the session's project directory.",
      'SESSION_CWD_REQUIRED'
    );
  }
  // A directory the caller never named is judged here — otherwise omitting
  // `?cwd=` would read a session that naming the same directory is refused for.
  // DOR-1322 shipped without this and the gap was live until DOR-1444.
  if (!callerNamedCwd(cwdParam) && !(await assertBoundary(cwd, res, { allowDorkHome: true })))
    return;

  const etag = await runtime.getSessionETag(cwd, internalSessionId);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  const messages = await runtime.getMessageHistory(cwd, internalSessionId);
  // The ONE runtime-agnostic suppression seam for the auto-first-turn kickoff
  // (M4): whatever the runtime stored, the synthetic "introduce yourself"
  // record never leaves the server as a user message. Role-scoped (user only),
  // first-user-record-scoped, exact-envelope-shaped — see @dorkos/shared/kickoff.
  res.json({ messages: filterKickoffHistory(messages) });
});

/**
 * Check a requested permission mode against what the runtime declares it can
 * run, returning an operator-readable message when it cannot (or `null` when
 * the mode is fine).
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param permissionMode - The mode the request asks to store.
 */
function rejectUndeclaredPermissionMode(
  runtime: AgentRuntime,
  permissionMode: PermissionModeId
): string | null {
  const declared = runtime.getCapabilities().permissionModes;
  if (!declared.supported || declared.values.length === 0) {
    return `The ${runtime.type} runtime has no permission modes to choose from.`;
  }
  const ids = declared.values.map((descriptor) => descriptor.id);
  if (ids.includes(permissionMode)) return null;
  return `The ${runtime.type} runtime cannot run permission mode '${permissionMode}'. It supports: ${ids.join(', ')}.`;
}

/**
 * Check a requested model against the catalog its runtime offers, returning an
 * operator-readable message when the runtime cannot run it (or `null` when the
 * model is fine).
 *
 * The same argument as {@link rejectUndeclaredPermissionMode}: the wire carries
 * any string, and only the session's runtime can say whether the model id it was
 * handed is real. Persisting one it cannot run buys nothing — the turn fails
 * later with "That model isn't available", by which point the person has already
 * typed their message (DOR-1660).
 *
 * Which runtime that is, is {@link modelGateAuthority}'s question, and it is a
 * real one: an unbound session HAS no runtime, only an inference.
 *
 * ## It degrades, on purpose
 *
 * An EMPTY catalog is not a claim that the runtime has no models — it is what a
 * runtime returns when it cannot answer: an unreachable OpenCode sidecar, a
 * claude-code warm-up that timed out, `test-mode`, which has no catalog at all.
 * Refusing on an empty list would turn a probe failure into a locked picker. So
 * an empty catalog accepts anything — exactly the way the OpenCode projection
 * shows the full menu when its own probes fail — and a throwing
 * `getSupportedModels` is read the same way.
 *
 * Matching allows `resolvedModel` as well as `value` because claude-code's
 * catalog rows are ALIASES (`sonnet`, `opus`) naming the wire id they expand to;
 * a session that persisted the wire id must keep working.
 *
 * WRITE PATH ONLY: a session already persisted on a now-absent model still loads
 * and runs, and the picker surfaces it as unavailable so the person can choose.
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param model - The model id the request asks to store.
 */
async function rejectUnknownModel(runtime: AgentRuntime, model: string): Promise<string | null> {
  let offered: ModelOption[];
  try {
    offered = await runtime.getSupportedModels();
  } catch {
    return null;
  }
  if (offered.length === 0) return null;
  if (offered.some((option) => option.value === model || option.resolvedModel === model)) {
    return null;
  }
  return `The ${runtime.type} runtime cannot run model '${model}'. Pick one from the model menu.`;
}

/**
 * The runtime whose catalog may REFUSE this model write, or `null` when nothing
 * has the standing to refuse it.
 *
 * ## Why a gate has to ask this at all
 *
 * `resolveSessionRuntime` answers for every session id, bound or not — an
 * unbound one gets the legacy inference, `claude-code`, so that reads keep
 * working before the first turn. {@link rejectUnknownModel} was written on top
 * of that answer as if it were ownership, and it is not: a person who starts a
 * session, switches the chip to OpenCode and picks an OpenCode model was told
 * "the claude-code runtime cannot run" it, for a session claude-code did not own
 * and never would. The gate fired against a runtime nobody chose.
 *
 * So it asks in the order of who actually knows:
 *
 * - **Bound** → the owner. Ownership is a fact in `session_metadata`, the gate
 *   has full authority, and this is the case DOR-1660 was about.
 * - **Unbound, and the request names a registered runtime** → that one. Nothing
 *   here binds anything — the hint only says which catalog to judge against, and
 *   it is the catalog the person was picking from. Ownership is still the first
 *   turn's to write (ADR-0255).
 * - **Unbound, and nobody said** → `null`. The gate declines rather than guesses.
 *
 * That last rung is the same rule {@link rejectUnknownModel} already applies to
 * an empty catalog, one level up: evidence nobody has is not evidence against.
 * The cost of declining is a turn that fails honestly later; the cost of
 * guessing is a person locked out of a model that works.
 *
 * An unregistered hint is treated as no hint. A caller cannot conjure authority
 * out of a runtime this server does not have, and 400-ing on it would refuse a
 * settings write over a field that only ever narrows a check.
 *
 * @param owner - The runtime instance the session resolved to.
 * @param bound - Whether `owner` is the session's recorded owner or the inference.
 * @param hint - `body.runtime`: the runtime the caller believes will own this session.
 */
function modelGateAuthority(
  owner: AgentRuntime,
  bound: boolean,
  hint: string | undefined
): AgentRuntime | null {
  if (bound) return owner;
  if (hint === undefined || !runtimeRegistry.has(hint)) return null;
  return runtimeRegistry.get(hint);
}

/**
 * The mode as its runtime declared it, or `undefined` for an id this runtime
 * does not offer (which {@link rejectUndeclaredPermissionMode} has already
 * refused by the time the door reads it).
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param permissionMode - The mode the request asks to store.
 */
function declaredMode(
  runtime: AgentRuntime,
  permissionMode: PermissionModeId
): PermissionModeDescriptor | undefined {
  return runtime.getCapabilities().permissionModes.values.find((d) => d.id === permissionMode);
}

/**
 * What a caller refused by the consent door is told, in the words that are true
 * of the mode they asked for.
 *
 * Two sentences rather than one, because one would be false somewhere: the
 * autonomy stop is a position with a name a person recognises from the dial,
 * while a middle stop that never asks is a surprise about behaviour and has to
 * be described as one. Neither names the runtime's own spelling of the mode —
 * the product speaks in the dial's words.
 *
 * @param descriptor - The mode as its runtime declared it.
 */
function consentRequiredMessage(descriptor: PermissionModeDescriptor): string {
  return isAutonomyStop(descriptor)
    ? 'Turning on Full autonomy needs you to confirm what it means first.'
    : "This mode won't stop for approval on each action, so you need to confirm what it means first.";
}

// PATCH /api/sessions/:id - Update session settings
router.patch('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = UpdateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const {
    permissionMode: requestedMode,
    model,
    effort,
    fastMode,
    title,
    acknowledgedAutonomy,
    runtime: runtimeHint,
  } = parsed.data;
  // Fail-closed by construction: an unresolvable session throws here, before
  // any check below can be skipped and before anything is written.
  //
  // Routing and ownership come out of the SAME read, because they are different
  // questions with different answers: `runtime` is where this write goes, and
  // `bound` is whether anyone has actually said so or the registry inferred it.
  // A gate that conflates the two refuses requests on a guess — see
  // {@link modelGateAuthority}. Nothing here writes ownership: that is the first
  // turn's to establish (ADR-0255), and the `runtime` hint cannot bind.
  const { runtime, bound } = await runtimeRegistry.resolveForSessionWithOwnership(sessionId);
  // The wire carries any well-formed mode id, because a runtime names its own
  // modes (`PermissionModeIdSchema`). The session's runtime is the ONLY thing
  // that can say whether the id it was handed is real, so it is the authority
  // and this is the single place that asks it. Persisting an undeclared id
  // would make the settings overlay display a safety posture the runtime never
  // adopted — a codex session PATCHed to `auto` reads "Auto" everywhere while
  // it keeps running read-only. WRITE PATH ONLY: a session already persisted in
  // a now-undeclared mode still loads and runs.
  if (requestedMode !== undefined) {
    const modeError = rejectUndeclaredPermissionMode(runtime, requestedMode);
    if (modeError) return sendError(res, 400, modeError, 'UNSUPPORTED_PERMISSION_MODE');
    // ## THE CONSENT DOOR (spec `trust-dial`, decision 5, widened 2026-08-01)
    //
    // A mode that stops asking is the one change a person cannot walk back: by
    // the time they notice they did not mean it, it has already happened. Every
    // mode that still asks is one click and instantly reversible. So the ones
    // that stop asking ask first — and the asking is checked HERE, because a
    // gate that only exists in one client's dialog is not a gate. A second
    // cockpit tab, a script, or a keyboard arrow that selects on focus would
    // each walk straight past it.
    //
    // WHICH modes is {@link needsConsentRitual}'s answer, not this route's, and
    // it is deliberately wider than the Full-autonomy stop. Codex files a mode
    // at the MIDDLE stop that runs shell commands in the workspace and has no
    // way to pause and ask; gating the autonomy position alone let that in with
    // no ritual at all. The rule is semantic — never asks, can do more than read
    // — so a future runtime with the same shape is caught the day it declares
    // itself, without a server release and without its name appearing here.
    //
    // The request satisfies the door with `acknowledgedAutonomy: true`, or with
    // the standing record a person leaves behind by ticking "don't show this
    // again". Both are checked on EVERY gated PATCH: the checkbox trades a
    // repeated ritual for a recorded one, and never weakens the contract. ONE
    // record covers the whole door whatever mode opened it — what a person
    // acknowledged is that a mode will not stop to ask, which is the same fact
    // at either stop, and a second record would mean asking again about
    // something they have already been told.
    //
    // ### What this is not
    //
    // It is a consent ritual for a person, not a boundary against a caller. Any
    // program that can reach this route can send `acknowledgedAutonomy: true`
    // itself, and nothing here can tell it from the cockpit. What it buys is
    // that a person cannot arrive in a mode that never asks without having been
    // told what that means. The boundary for agent callers is separate work
    // (`agent-approval-settings`, DOR-501); do not describe this as covering it.
    //
    // ### Scope: this route is not the only way into a mode that never asks
    //
    // It gates the interactive CHANGE, and nothing else, so read the other ways
    // in as deliberately out of scope rather than as gaps nobody noticed:
    //
    // - **Relay bindings, task execution, room turns.** All create and drive
    //   sessions in-process via `ensureSession` and never reach this route. They
    //   keep their own, stricter gates — the bypass clamp on file-sourced
    //   schedules among them.
    // - **A runtime's own default.** A session is BORN at whatever mode its
    //   runtime declares as default, with no PATCH and therefore no door;
    //   `test-mode` is born at its autonomy stop, which is the entire point of
    //   that runtime. What keeps that honest is the separate invariant that no
    //   production runtime may default to a mode that never asks — asked through
    //   the SAME {@link needsConsentRitual} this door applies, so the two cannot
    //   drift apart and leave a mode that is refused here but shipped as a
    //   birthplace. Enforced per runtime by the conformance suite
    //   (`runtimeConformance`, waivable only with a written reason) and across
    //   the whole set by
    //   `services/runtimes/__tests__/permission-semantics.test.ts`. This door
    //   would be the wrong place for it: there is no request to refuse.
    // - **Obsidian.** `DirectTransport` calls `runtime.updateSession` in-process
    //   and bypasses this route entirely, so the embedded cockpit's dial is
    //   gated by its dialog alone. Pre-existing property of that seam, widened
    //   by nothing here; the checkbox is withheld there for a related reason
    //   (see `AutonomyConfirmDialog`).
    const descriptor = declaredMode(runtime, requestedMode);
    if (descriptor && needsConsentRitual(descriptor) && !acknowledgedAutonomy) {
      if (!hasStandingAutonomyAck()) {
        // 428, not 400. The body is well-formed and the mode is one this runtime
        // genuinely offers — nothing about the request is malformed, so calling
        // it a validation failure would be false. What is missing is a
        // precondition the caller can go and satisfy before retrying the
        // identical request, which is the one thing 428 says and no other 4xx
        // does: 403 would claim they may never do this, and 409 would claim
        // something changed underneath them.
        return sendError(res, 428, consentRequiredMessage(descriptor), AUTONOMY_ACK_REQUIRED_CODE);
      }
    }
  }
  // Same authority argument as the mode gate directly above, applied to the
  // model: only the runtime can say whether the id it was handed is real, and it
  // is asked HERE so every caller passes the same door.
  //
  // With one difference the mode gate does not need: WHICH runtime is asked.
  // Model ids are namespaced per runtime and overlap nowhere, so asking the
  // wrong one is a guaranteed refusal rather than a rare one — which is exactly
  // what shipped, and what {@link modelGateAuthority} exists to stop. The mode
  // gate above keeps asking `runtime` because every runtime here declares a
  // SUBSET of claude-code's mode ids, so the inference can only ever be too
  // permissive there, and the too-permissive direction is already caught where
  // the runtime finally becomes known (`RuntimeRegistry.claimedPermissionMode`
  // drops a mode the bound runtime does not declare). Narrowing it to the hint
  // would ADD refusals, not remove them, and that is a separate decision.
  if (model !== undefined) {
    const authority = modelGateAuthority(runtime, bound, runtimeHint);
    const modelError = authority ? await rejectUnknownModel(authority, model) : null;
    if (modelError) return sendError(res, 400, modelError, 'UNSUPPORTED_MODEL');
  }
  // Past the gate the id is one THIS runtime declares, so it is a real mode by
  // the only definition that matters. `PermissionMode` is the narrower name the
  // rest of the server still uses for the same thing (descriptors have always
  // typed their `id` as a plain `string`), and this is the single seam where
  // the two meet — the assertion is bounded by the check directly above it, and
  // nothing downstream re-derives meaning from the id anyway.
  const permissionMode = requestedMode as PermissionMode | undefined;
  // Translate client-facing session ID to backend-internal session ID (same as GET /:id).
  // After a session remap the client uses the SDK UUID directly; without this translation
  // runtime.updateSession would fail to find the session by client-facing ID.
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  // updateSession no longer throws on a live mode-switch failure (ADR-0261):
  // the chosen mode is persisted and applies on the next turn, so there is no
  // 422 path — a failed live switch is not a request error.
  const updated = await runtime.updateSession(internalSessionId, {
    permissionMode,
    model,
    effort,
    fastMode,
  });
  if (!updated.updated) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

  // Persist custom title to JSONL via SDK's renameSession()
  if (title) {
    await runtime.renameSession(internalSessionId, title, cwd);
  }

  const session = await runtime.getSession(cwd, internalSessionId);
  if (session) {
    session.permissionMode = permissionMode ?? session.permissionMode;
    session.model = model ?? session.model;
    if (effort) session.effort = effort;
    if (fastMode !== undefined) session.fastMode = fastMode;
    if (title) session.title = title;
    if (!session.runtime) session.runtime = runtime.type;
  }
  // The loose fallback is still Session-shaped on the wire, so it must carry
  // the required `runtime` field (task 1.1) — resolved from the owning runtime.
  const body = session ?? { id: sessionId, permissionMode, model, effort, runtime: runtime.type };
  // ## A tightening the running turn never confirmed is not a 200 (DOR-1435)
  //
  // Everything above is true of what DorkOS has STORED. When the runtime could
  // not tell the turn already running about a mode the person just tightened,
  // it is not true of what that turn will do — under a mode that never asks the
  // CLI skips its approval callback entirely, so nothing on this side can put
  // the prompts back for the reply already in flight. Answering `200
  // {permissionMode:'default'}` there states a safety posture the agent has not
  // adopted, which is the one direction this product must never be confidently
  // wrong in.
  //
  // `202`, because the request was accepted and the change IS saved — it simply
  // has not taken yet, which is exactly what 202 says and what a 4xx would deny.
  // The field is what a client acts on; the status is what makes a client that
  // reads neither at least not report certainty. LOOSENING stays a plain 200:
  // an unconfirmed one costs a few extra approval prompts for the rest of one
  // turn and corrects itself on the next.
  if (updated.permissionModePendingUntilNextTurn) {
    return res.status(202).json({ ...body, permissionModePendingUntilNextTurn: true });
  }
  res.json(body);
});

// POST /api/sessions/:id/fork - Fork a session
router.post('/:id/fork', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ForkSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  try {
    const forked = await runtime.forkSession(cwd, internalSessionId, parsed.data);
    if (!forked) return sendError(res, 404, 'Session not found or fork failed', 'FORK_FAILED');
    res.status(201).json(forked);
  } catch {
    sendError(res, 500, 'Fork failed', 'FORK_ERROR');
  }
});

// POST /api/sessions/:id/reload-plugins - Reload plugins from disk
router.post('/:id/reload-plugins', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.reloadPlugins) {
    return sendError(res, 501, 'Plugin reload not supported by this runtime', 'NOT_SUPPORTED');
  }

  try {
    const result = await runtime.reloadPlugins(sessionId);
    if (!result) {
      return sendError(
        res,
        409,
        'No active query — send a message first to establish a session',
        'NO_ACTIVE_QUERY'
      );
    }
    res.json(result);
  } catch (err) {
    // Told apart from a plain failure because the two are different facts, and
    // the difference is the whole of what the caller can do next (DOR-1301). A
    // reload the agent never confirmed may still have happened — it was written
    // to a process that stopped answering, not refused — so the honest answer is
    // "no confirmation", not "failed".
    if (err instanceof ControlRequestTimeoutError) {
      return sendError(
        res,
        504,
        "The agent didn't confirm the plugin reload in time — it may still apply; try again if the new plugin doesn't appear",
        'RELOAD_TIMEOUT'
      );
    }
    sendError(res, 500, 'Plugin reload failed', 'RELOAD_ERROR');
  }
});

/**
 * Choose the runtime type for a newly-created session.
 *
 * Priority: explicit `body.runtime` hint > agent-manifest `runtime` field
 * (read from `<cwd>/.dork/agent.json`) > server default runtime type.
 *
 * Subsequent `POST /:id/messages` calls for the same `sessionId` do NOT
 * re-run this — `persistSessionRuntime` is first-write-wins, so the row
 * set by the first call is authoritative.
 *
 * The runtime is chosen FIRST because the other two execution defaults hang off
 * it: which model and effort a new session starts with is a per-runtime question
 * (`services/session/resolve-session-defaults.ts`), answered against the runtime
 * this returns, and seeded onto the same first write.
 */
async function resolveRuntimeTypeForNewSession(opts: {
  runtimeHint?: string;
  agentPath?: string;
  cwd?: string;
}): Promise<string> {
  if (opts.runtimeHint) return opts.runtimeHint;

  // Look for an agent manifest in the provided agentPath or cwd. Fall back
  // silently when no manifest exists or the read fails — a missing manifest
  // is not an error on the hot path.
  const manifestDir = opts.agentPath ?? opts.cwd;
  if (manifestDir) {
    try {
      const manifest = await readManifest(manifestDir);
      // The manifest names a runtime PREFERENCE — honor it only when that
      // runtime is registered in this process. Unlike the explicit body hint
      // (which 400s when unknown), an unregistered manifest runtime soft-falls
      // back to the default: the test-mode server (DORKOS_TEST_RUNTIME=true)
      // registers ONLY 'test-mode' while every manifest on disk says
      // 'claude-code' (the AgentRuntime enum has no test-mode member), so
      // without this guard no agent-seeded session can ever start there.
      if (manifest?.runtime) {
        if (runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
        logger.info('[POST /messages] manifest runtime not registered; using default', {
          manifestRuntime: manifest.runtime,
          defaultRuntime: runtimeRegistry.getDefaultType(),
          manifestDir,
        });
      }
    } catch {
      // Fall through to default
    }
  }

  return runtimeRegistry.getDefaultType();
}

// POST /api/sessions/:id/messages — Accept a message (trigger-only, ADR-0264;
// accept-only, spec `persistent-session-runtime` §3.3).
//
// This endpoint NO LONGER streams tokens in-band, and no longer waits for the
// session to be free. It validates and hands the message to the dispatcher,
// which either starts the turn now or puts it on the session's durable queue,
// then answers `202 Accepted` with the canonical session id, the message id, the
// delivery outcome and the queue position. Everything after that — the turn
// starting, its tokens, its end — arrives on `GET /:id/events`, the single
// delivery path.
//
// **There is no `409` here.** A busy session used to refuse a second window;
// now it queues, and the person can edit or remove what is waiting through the
// queue routes below. The write-lock still exists — it is the mutex one turn
// window holds, and its inactivity TTL still reclaims a turn that went dark
// (DOR-782) — but it is no longer an answer this route can give. The lock is
// bound to the turn's real duration and released on completion AND on error; a
// detached failure is surfaced INTO the projector so `/events` consumers see it.
// See `services/session/message-dispatcher.ts` and `trigger-turn.ts` for the
// orchestration and the lock/error invariants.
router.post('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const {
    content,
    cwd,
    context,
    runtime: runtimeHint,
    account: accountHintRaw,
    agentPath,
    workspaceKey,
    workspaceProvider,
    seedContext,
    disposition,
  } = parsed.data;

  // Opt-in workspace binding (DOR-84). When a workspaceKey is supplied, the
  // server provisions-or-reuses the managed workspace from the source repo
  // (`cwd`) and runs the turn with `cwd = workspace.path` + its port block.
  // Additive + resilient: with no key (or a disabled/failing manager) the turn
  // proceeds with the original cwd, byte-for-byte unchanged.
  let effectiveCwd = cwd;
  if (workspaceKey) {
    try {
      const source = cwd ?? DEFAULT_CWD;
      const projectKey = sanitizeWorkspaceKey(path.basename(source));
      const workspace = await getWorkspaceManager().ensure({
        projectKey,
        key: workspaceKey,
        source,
        provider: workspaceProvider,
      });
      effectiveCwd = workspace.path;
      logger.info('[POST /messages] bound to workspace', {
        sessionId,
        workspaceKey,
        path: workspace.path,
      });
    } catch (err) {
      logger.warn('[POST /messages] workspace binding skipped', {
        sessionId,
        workspaceKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    // No unit-of-work key, so ask the precedence chain where this turn belongs
    // (`services/workspace/resolve-session-cwd.ts`). `workspaceKey` above keeps
    // its precedence deliberately: it is a per-turn statement about this piece
    // of work, which is strictly more specific than a standing per-agent
    // preference.
    //
    // The `default` rung is translated back into saying NOTHING, and that is
    // load-bearing rather than fussy. Every runtime already falls back to
    // `DEFAULT_CWD` on an absent cwd, so the turn runs in the same directory
    // either way — but `effectiveCwd` is also what stamps `projector.cwd`
    // below, overwriting whatever an `/events` subscribe put there. A turn that
    // has no opinion about its directory must not acquire one here.
    const resolved = await resolveSessionCwd({ cwd, agentPath, sessionId });
    if (resolved.rung !== 'default') effectiveCwd = resolved.cwd;
  }

  // First-message binding: choose + persist the runtime BEFORE resolving.
  // `persistSessionRuntime` binds a session that has none — including one whose
  // row a pre-launch settings change already created — and leaves an
  // already-bound session completely alone, so a later call passing a different
  // (or no) hint changes nothing. The first message wins.
  const runtimeType = await resolveRuntimeTypeForNewSession({ runtimeHint, agentPath, cwd });
  if (!runtimeRegistry.has(runtimeType)) {
    return sendError(res, 400, `Unknown runtime: ${runtimeType}`, 'UNKNOWN_RUNTIME');
  }
  // The registry seeds this session's model, effort and trust stop from the
  // server defaults if this call is what BINDS it — see `resolveSessionDefaults`
  // — filling only what nobody chose, and re-checking a mode chosen before the
  // runtime was known against what this one declares. Nothing is written for a
  // session that is already bound, so a running conversation keeps whatever it
  // is running with.
  //
  // `interactive: true` is what unlocks the trust stop, and this route is where
  // that claim is true: a message posted to `/api/sessions/:id/messages` came
  // from a person at a cockpit holding the session's event stream open. Rooms,
  // tasks and bindings never pass through here.
  const isNewSession = await runtimeRegistry.persistSessionRuntime(
    sessionId,
    runtimeType,
    agentPath,
    { interactive: true }
  );
  // Fire the anonymous `session_created` usage event exactly once, on the write
  // that binds the session (no-op unless usage telemetry is on).
  if (isNewSession)
    reportUsageEvent({ event: 'session_created', properties: { runtime: runtimeType } });

  // The billing-account launch hint, on exactly the `runtime` hint's lifecycle
  // (ADR 260821-205323, mirroring ADR-0255). It is honored only on the send that
  // CREATED this session, and only for claude-code — after launch the account is
  // a fact on disk that nothing can move (ADR 260801-204127), and no other
  // runtime has accounts at all. Anything else is ignored out loud rather than
  // silently, because the person who picked it believed it would apply.
  //
  // Whether the id NAMES a registered account is deliberately not asked here:
  // the resolver falls through an unknown id to the next rung so a launch never
  // fails over a billing setting, and a 400 here would be exactly that failure.
  let accountHint: string | undefined;
  if (accountHintRaw !== undefined) {
    if (isNewSession && runtimeType === 'claude-code') {
      accountHint = accountHintRaw;
    } else {
      logger.warn('[POST /messages] ignoring account hint', {
        sessionId,
        account: accountHintRaw,
        runtime: runtimeType,
        reason: isNewSession ? 'runtime has no accounts' : 'session already launched',
      });
    }
  }

  // Read X-Client-Id header, or generate UUID if missing
  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  const runtime = await runtimeRegistry.resolveForSession(sessionId);

  // One id for this whole dispatch, minted BEFORE the trigger so the line that
  // announces it already carries it and a reader can start there.
  const dispatchId = newDispatchId();
  logger.info('[POST /messages] trigger', { sessionId, contentLength: content.length, dispatchId });
  recordDispatchStart({ dispatchId, origin: 'session', sessionId });

  // The POST body's cwd is operator-chosen and authoritative — overwrite any
  // earlier stamp from a subscribe-path default (an /events connect without
  // ?cwd falls back to the workspace root, which would otherwise pin this
  // session's liveness to the wrong agent first-writer-wins).
  // Persist the completed-turn stream (DOR-189) so it survives a server
  // restart: everything for a log-backed runtime, and for the rest the narrow
  // record its own transcript cannot answer for — including the permission
  // decisions this turn was gated on. Enabling here — before the turn is fed —
  // guarantees the turn_end flush regardless of whether an /events subscribe
  // has already minted (and persistence-enabled) the projector.
  const projector = getOrCreateProjector(sessionId, effectiveCwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  if (effectiveCwd !== undefined) projector.cwd = effectiveCwd;

  // Trigger the detached turn. The projector is keyed by the client-facing id
  // (stable across the new-session remap, since the projector registry and
  // `/events` both resolve by it); the canonical id is captured for the body.
  //
  // **The scope wraps `dispatchMessage`, and that placement is the whole phase.**
  // The dispatcher CONSTRUCTS the detached generator chain and then awaits only
  // the canonical-id race, so entering the dispatch here binds the context to
  // the chain itself — an async generator created inside an ALS scope keeps
  // that scope for its whole life. The turn therefore stays correlated long
  // after this `await` resolves and the 202 has been sent (ADR-0264's `void
  // turn;`). A scope placed around the awaited race INSIDE the dispatcher would
  // expire at the 202 and correlate nothing; see
  // `__tests__/sessions-dispatch-correlation.test.ts`, which fails if it moves.
  const result = await runInDispatch({ dispatchId, origin: 'session' }, () =>
    dispatchMessage({
      sessionId,
      clientId,
      content,
      cwd: effectiveCwd,
      context,
      // Background this turn's opener attached to it. It rides the neutral
      // context bag, never `content`: the prompt stays the person's message
      // byte for byte, and the seed is stripped from every rendered transcript.
      ...(seedContext ? { seedContext } : {}),
      // Only ever set on the session-creating claude-code send (see above).
      ...(accountHint ? { accountHint } : {}),
      // Absent means `queue`, which is also what every disposition resolves to
      // until the native rungs land (P4). The receipt says which it was.
      ...(disposition ? { disposition } : {}),
      projector,
      runtime,
      onError: (err) => {
        logger.warn('[POST /messages] detached turn error', {
          sessionId,
          ...logError(err),
        });
      },
      // The 202 has long since gone out by the time this fires. It is the only
      // moment the server learns how a detached turn ended, which is exactly
      // what the debug buffer is asked for during an incident.
      onSettled: (outcome) =>
        recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered'),
    })
  );

  if (result.queued) {
    logger.info('[POST /messages] queued behind the running turn', {
      sessionId,
      dispatchId,
      messageId: result.outcome.messageId,
      queuePosition: result.queuePosition,
    });
  }

  res.status(202).json({
    sessionId: result.canonicalId,
    messageId: result.outcome.messageId,
    outcome: result.outcome,
    queuePosition: result.queuePosition,
  });
});

// GET|PATCH|DELETE /api/sessions/:id/queue — the messages waiting on a session.
// Handlers live in `session-queue-handler.ts` so this file stays under the size
// rule. The queue is per SESSION: any window may edit or remove any message on
// it, whichever window typed it. See the handler's module doc.
router.get('/:id/queue', sessionQueueListHandler);
router.patch('/:id/queue/:messageId', sessionQueueUpdateHandler);
router.delete('/:id/queue/:messageId', sessionQueueRemoveHandler);

// POST /api/sessions/:id/approve - Approve pending tool call
//
// The answer guard runs first on all six of these routes. See
// {@link requirePersonToAnswer}: the Ask is now reachable from every route in
// the cockpit, so who may answer it is a property of the endpoint rather than of
// where the card happened to be drawn.
router.post('/:id/approve', async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, alwaysAllow } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const approved = runtime.approveTool(sessionId, toolCallId, true, {
    alwaysAllow,
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!approved) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/deny - Deny pending tool call
router.post('/:id/deny', async (req, res) => {
  // Guarded for the same reason as approve, not as a symmetry: an agent that can
  // deny can suppress a person's decision and bury the card that would have told
  // them. Same argument the capability approvals' deny route makes.
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, reason } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  // A blank field is not a reason. Normalising here keeps every runtime and the
  // receipt copy from having to re-decide what an empty string means.
  const denyReason = reason?.trim() ? reason.trim() : undefined;
  const answeredByName = answeredBy(res);
  const denied = runtime.approveTool(sessionId, toolCallId, false, {
    denyReason,
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!denied) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/batch-approve - Approve multiple pending tool calls
router.post('/:id/batch-approve', async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, true, {
      ...(answeredByName ? { answeredBy: answeredByName } : {}),
    }),
  }));
  res.json({ results });
});

// POST /api/sessions/:id/batch-deny - Deny multiple pending tool calls
//
// Carries no reason, and the UI offers no field for one: "Deny all" answers a
// stack of unrelated asks at once, so a single sentence would be attached to
// requests it was never about. Each refusal therefore reports honestly that
// nobody explained it, and the transcript receipts say so.
router.post('/:id/batch-deny', async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, false, {
      ...(answeredByName ? { answeredBy: answeredByName } : {}),
    }),
  }));
  res.json({ results });
});

// POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion
router.post('/:id/submit-answers', async (req, res) => {
  // A question is answered by a person too. The three kinds of prompt share one
  // bar, because they are one object to whoever is being asked.
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitAnswersRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, answers } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const ok = runtime.submitAnswers(sessionId, toolCallId, answers, {
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending question', 'NO_PENDING_QUESTION');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/ui-action — Generative-UI widget interactivity channel
// (spec gen-ui-tier1 §3). The handler lives in `session-ui-action-handler.ts`
// so this route file stays under the file-size rule, mirroring `/:id/events`.
// Semantics: fresh turn via the dispatcher, 202, turn streams over /events. A
// session still PRODUCING a turn answers 409 SESSION_LOCKED here — unlike
// /messages, which now queues: a widget action is answered by the turn it was
// clicked in, so running it against whatever a later turn leaves behind is not
// the same action. A click after that turn ENDED is accepted, even while the
// runtime finishes closing the stream (DOR-1239). See the handler's module doc.
router.post('/:id/ui-action', sessionUiActionHandler);

// POST /api/sessions/:id/command-intents/:intent — Runtime-fulfilled command
// intent (currently `compact`), DOR-109. The handler lives in
// `session-command-intent-handler.ts` to keep this file under the size rule.
// Semantics: capability-gated (unsupported runtime → honest 422, adapter never
// called), else drives runtime.executeCommandIntent through the durable
// projector (trigger-only, 202; delivery over /events, e.g. compact_boundary);
// busy → 409 SESSION_LOCKED — see the handler's module doc.
router.post('/:id/command-intents/:intent', sessionCommandIntentHandler);

// POST /api/sessions/:id/devtools/ingest — DevTools bridge capture sink (DOR-213).
// Session-gated (credentialed same-origin client call), Zod-validated, batch-capped.
// The handler lives in `session-devtools.ts` to keep this file under the size rule.
router.post('/:id/devtools/ingest', sessionDevtoolsIngestHandler);

/**
 * GET /:id/attachments/:file — an image this session's turn produced.
 *
 * The handler lives in `session-attachments-handler.ts`, same reason as above.
 * `:file` is `<attachmentId>.<ext>`, exactly the URL the attachment store
 * answered — the message part carries that URL verbatim rather than rebuilding
 * it, which is what keeps the store a real seam.
 */
router.get('/:id/attachments/:file', sessionAttachmentHandler);

// POST /api/sessions/:id/mcp-app/resource — Read a ui:// MCP App resource
// (SEP-1865) for client rendering. The handler lives in
// `session-mcp-app-resource-handler.ts`; config stays server-side (ADR
// 260708-141143). See the handler's module doc.
router.post('/:id/mcp-app/resource', sessionMcpAppResourceHandler);

// POST /api/sessions/:id/submit-elicitation - Submit response to MCP elicitation
router.post('/:id/submit-elicitation', async (req, res) => {
  const refusal = requirePersonToAnswer(req, res);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitElicitationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { interactionId, action, content } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const answeredByName = answeredBy(res);
  const ok = runtime.submitElicitation(sessionId, interactionId, action, content, {
    ...(answeredByName ? { answeredBy: answeredByName } : {}),
  });
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending elicitation', 'NO_PENDING_ELICITATION');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/tasks/:taskId/stop - Stop a running background task
router.post('/:id/tasks/:taskId/stop', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  // Express 5 typings widen route params to string | string[]; a multi-value
  // taskId can only come from a malformed path, so reject it as invalid.
  const taskId = typeof req.params.taskId === 'string' ? req.params.taskId : undefined;
  if (!taskId) return sendError(res, 400, 'Invalid task ID', 'INVALID_TASK_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  try {
    const stopped = await runtime.stopTask(sessionId, taskId);
    if (!stopped) {
      if (runtime.hasSession(sessionId)) {
        return sendError(res, 409, 'Task not found or already stopped', 'TASK_NOT_RUNNING');
      }
      return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
    }
    res.json({ success: true, taskId });
  } catch (_err) {
    return sendError(res, 500, 'Failed to stop task', 'STOP_TASK_ERROR');
  }
});

// POST /api/sessions/:id/interrupt - Interrupt the active query
router.post('/:id/interrupt', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  // Stop means stop everything queued (spec `persistent-session-runtime` §3.5,
  // D4). The DorkOS queue is emptied FIRST — synchronously, with no await
  // between it and the interrupt — so the turn ending here cannot let the pump
  // release the head of the queue on its way out. The removed messages ride
  // back on the response: nothing a person typed is destroyed by a Stop, it
  // returns to their composer. The narrower promise of exactly WHAT the runtime
  // cancelled (the CLI's own in-flight queue via `cancel_queued`) is owned by
  // the `runtime-interrupt-receipts` spec (D7) and not redefined here; until it
  // lands `interruptQuery` stays a bare boolean and the client says "stop
  // requested" rather than "stopped".
  const cancelledQueued = clearQueuedMessages(sessionId);
  try {
    const interrupted = await runtime.interruptQuery(sessionId);
    // Best-effort: ok:false when the query already finished is expected (race
    // between natural completion and the interrupt arriving). Not an error.
    res.json({ ok: interrupted, cancelledQueued });
  } catch (err) {
    // The interrupt is best-effort, but the queue clear that ran just above is
    // NOT — those rows are already gone. Failing the request here would drop
    // `cancelledQueued`, and the client's best-effort `stop()` would hand the
    // person back nothing: they pressed Stop, confirmed "put N back", and the
    // words would be lost. So a thrown interrupt reports `ok: false` and still
    // returns the cleared messages, keeping the "nothing typed is destroyed"
    // promise. The failure is logged rather than swallowed.
    logger.warn('[POST /interrupt] interrupt threw; queue was still cleared', {
      sessionId,
      ...logError(err),
    });
    res.json({ ok: false, cancelledQueued });
  }
});

// GET /api/sessions/:id/events - Always-on durable SSE stream (snapshot → replay → live).
//
// The single delivery path for session state (spec chat-stream-reconnection,
// Design B.3, ADR-0264/ADR-0266). Always on — NO `enableCrossClientSync` gate,
// no feature flag. Express 5 forwards rejections that escape the handler's own
// pre-flush guard to the error middleware natively: pre-flush they get a JSON
// error response, post-flush Express destroys the socket — the correct SSE
// failure mode (see the `res.headersSent` guard in error-handler.ts).
//
// The SAME path is also served over a WebSocket, by `session-events-socket.ts`
// through the upgrade router, and that is what the cockpit connects to (ADR
// 260805-041016). This SSE route stays because it is the public integration
// contract (`docs/integrations/sse-protocol.mdx`). Both share their sequencing
// — see `services/session/session-stream-delivery.ts`.
router.get('/:id/events', sessionEventsHandler);

export default router;
