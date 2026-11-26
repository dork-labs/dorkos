/** Explicit session settings and title route. */
import { UpdateSessionRequestSchema } from '@dorkos/shared/schemas';
import type { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { personOnlyModeChange } from '../http/person-session-refusal.js';
import { problem, readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { boundaryRefusal, parseSessionId } from '../lib/route-utils.js';
import { sessionRunsOnCredits } from '../services/core/cloud/credits-model-gate.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  runPreparedDraftSettingsMutation,
  runPreparedSettingsMutation,
} from '../services/core/runtime-seam/prepared-settings-write.js';
import {
  modelGateAuthority,
  rejectUndeclaredPermissionMode,
  rejectUnknownModel,
  sessionModeAuthority,
} from './session-model-gate.js';
import {
  isPersonChatWriteRefusal,
  observePersonChat,
  preparePersonChat,
  personChatMissing,
} from './session-person-birth.js';
import {
  invalidSessionId,
  notePersonMode,
  sessionNotFound,
  wifiModeRaiseReply,
} from './session-route-replies.js';
import type { SessionLocationStore } from '../services/core/runtime-seam/session-location-store.js';
import type { SessionRouteDeps } from './sessions.js';

const PREPARED_SETTINGS_RUNTIMES = new Set([
  'claude-code',
  'opencode',
  'codex',
  'doe',
  'test-mode',
  'test-mode-b',
]);

/**
 * Mount PATCH behind the session router's existing read guard.
 *
 * @param router - The guarded session router.
 * @param deps - The session's live registration lookup.
 * @param personBirth - The saved folders and person allocations, when mounted.
 */
export function mountSessionSettingsPatch(
  router: Hono<ApiEnv>,
  deps: Pick<SessionRouteDeps, 'personBirth' | 'meshCore'>,
  personBirth?: SessionLocationStore
): void {
  // PATCH /api/sessions/:id - Update session settings
  router.patch('/:id', personOnlyModeChange(), async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const cwdParam = readQuery(c).cwd;
    const requestedCwd = typeof cwdParam === 'string' ? cwdParam : undefined;
    const parsed = UpdateSessionRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error);
    }
    const {
      permissionMode: requestedMode,
      model,
      effort,
      fastMode,
      title,
      runtime: runtimeHint,
      account: accountHint,
    } = parsed.data;
    const store = personBirth ?? deps.personBirth;
    const source = store && observePersonChat(store, sessionId);
    const prepared =
      store && source
        ? await preparePersonChat(
            store,
            sessionId,
            honoRequestFacts(c),
            source,
            deps.meshCore,
            requestedCwd
          )
        : undefined;
    if (prepared && 'refusal' in prepared) return sendProblem(c, prepared.refusal.body);
    const cwd = prepared?.cwd ?? (requestedCwd || DEFAULT_CWD);
    // The registration establishes who owns the draft. The normal folder
    // boundary still governs the effective place named for the settings read.
    if (prepared?.registeredAgentPath) {
      const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
      if (outside) return sendProblem(c, outside);
    }

    // Fail-closed by construction: an unresolvable session throws here, before
    // any check below can be skipped and before anything is written.
    //
    // Routing and ownership come out of the SAME read, because they are different
    // questions with different answers: `runtime` is where this write goes, and
    // `bound` is whether anyone has actually said so or the registry inferred it.
    // A gate that conflates the two refuses requests on a guess — see
    // {@link modelGateAuthority}. Nothing here writes ownership: that is the first
    // turn's to establish (ADR-0255), and the `runtime` hint cannot bind.
    const { runtime, bound } = await runtimeRegistry.resolveForSessionWithOwnership(sessionId, {
      allowUnbound: true,
    });
    // The wire carries any well-formed mode id, because a runtime names its own
    // modes (`PermissionModeIdSchema`). The session's runtime is the ONLY thing
    // that can say whether the id it was handed is real, so it is the authority
    // and this is the single place that asks it. Persisting an undeclared id
    // would make the settings overlay display a safety posture the runtime never
    // adopted — a codex session PATCHed to `auto` reads "Auto" everywhere while
    // it keeps running read-only. WRITE PATH ONLY: a session already persisted in
    // a now-undeclared mode still loads and runs.
    //
    // Asked of the runtime the session will run on: its bound one, else the one
    // the request names, else the inferred one. Asking the inferred claude-code
    // for a chat headed to Codex accepted `plan`, which Codex does not have, and
    // the turn then ran at the agent's level (DOR-4411).
    const modeRuntime = sessionModeAuthority(runtime, bound, runtimeHint);
    const modeError = requestedMode && rejectUndeclaredPermissionMode(modeRuntime, requestedMode);
    if (modeError) return problem(c, 'invalid_request', { detail: modeError });
    // From Wi-Fi a chat's mode may go down, never up (DOR-3037), judged by the same runtime.
    const raise = await wifiModeRaiseReply(c, modeRuntime, sessionId, requestedMode);
    if (raise) return raise;
    // Same authority argument as the mode gate directly above, applied to the
    // model: only the runtime can say whether the id it was handed is real, and it
    // is asked HERE so every caller passes the same door.
    //
    // With one difference the mode gate does not need: WHICH runtime is asked.
    // Model ids are namespaced per runtime and overlap nowhere, so asking the
    // wrong one is a guaranteed refusal rather than a rare one — which is exactly
    // what shipped, and what {@link modelGateAuthority} exists to stop. The mode
    // gate above asks the same authority, falling back to `runtime` when the
    // session is unbound and names no runtime: there the inference can only be
    // too permissive, and the turn backstop (`clampModeToCeiling`) runs an
    // undeclared mode at the runtime's strictest, never the agent's level.
    //
    // Which MENU is the other half of the question. A session on DorkOS credits
    // may run only what credits serve on its runtime's protocol, so it is judged
    // against the service's list rather than the runtime's own (DOR-2636), and
    // that check does not degrade: nothing is stored while the list is
    // unreadable. Whether the session is on credits is the same answer its launch
    // reaches (`sessionRunsOnCredits`).
    if (model !== undefined) {
      const authority = modelGateAuthority(runtime, bound, runtimeHint);
      const onCredits = authority
        ? await sessionRunsOnCredits(authority, sessionId, {
            accountHint,
            cwd: prepared?.cwd ?? requestedCwd,
          })
        : false;
      const modelError = authority
        ? await rejectUnknownModel(authority, model, { onCredits, sessionId })
        : null;
      if (modelError) return problem(c, 'invalid_request', { detail: modelError });
    }
    // Past the gate the id is one THIS runtime declares, so it is a real mode by
    // the only definition that matters — and it travels on as the runtime-declared
    // id it is, all the way into the settings store. No narrowing happens here
    // (DOR-885): each adapter reconciles the id with its own vocabulary at its own
    // edge, which is the only place that can (`requestedMode` from here on).
    // Translate client-facing session ID to backend-internal session ID (same as GET /:id).
    // After a session remap the client uses the SDK UUID directly; without this translation
    // runtime.updateSession would fail to find the session by client-facing ID.
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    // updateSession no longer throws on a live mode-switch failure (ADR-0261):
    // the chosen mode is persisted and applies on the next turn, so there is no
    // 422 path — a failed live switch is not a request error.
    if (prepared && (bound || internalSessionId !== sessionId))
      return sendProblem(c, personChatMissing.body);
    const hasSettings =
      requestedMode !== undefined ||
      model !== undefined ||
      fastMode !== undefined ||
      (runtime.type !== 'opencode' && effort !== undefined);
    if (prepared && hasSettings && !PREPARED_SETTINGS_RUNTIMES.has(runtime.type))
      return sendProblem(c, personChatMissing.body);
    const update = () =>
      runtime.updateSession(internalSessionId, {
        permissionMode: requestedMode,
        model,
        effort,
        fastMode,
      });
    const updated = await (async () => {
      if (!prepared || !hasSettings) return update();
      try {
        return 'birth' in prepared.binding
          ? await runPreparedSettingsMutation(sessionId, prepared.binding.birth, update)
          : await runPreparedDraftSettingsMutation(sessionId, prepared.binding.draft, update);
      } catch (error) {
        if (isPersonChatWriteRefusal(error))
          return { updated: false, permissionModePendingUntilNextTurn: false };
        throw error;
      }
    })();
    if (!updated.updated) return sessionNotFound(c);
    notePersonMode(sessionId, requestedMode);

    if (!prepared) {
      const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
      if (outside) return sendProblem(c, outside);
    }

    // Persist custom title to JSONL via SDK's renameSession()
    if (title) {
      await runtime.renameSession(internalSessionId, title, cwd);
    }

    const session = await runtime.getSession(cwd, internalSessionId);
    if (session) {
      session.permissionMode = requestedMode ?? session.permissionMode;
      session.model = model ?? session.model;
      if (effort) session.effort = effort;
      if (fastMode !== undefined) session.fastMode = fastMode;
      if (title) session.title = title;
      if (!session.runtime) session.runtime = runtime.type;
    }
    // The loose fallback is still Session-shaped on the wire, so it must carry
    // the required `runtime` field (task 1.1) — resolved from the owning runtime.
    const loose = session ?? {
      id: sessionId,
      permissionMode: requestedMode,
      model,
      effort,
      runtime: runtime.type,
    };
    // ## Say when the runtime is a guess (DOR-1693)
    //
    // On a session nobody owns, `runtime` is the legacy inference —
    // `claude-code`, so that reads keep working before anything is recorded — and
    // it goes out in the same field, with the same shape, as a real binding. A
    // caller cannot tell them apart, and it can flatly contradict the `runtime`
    // hint that same request just sent. `bound` is already in hand from the
    // resolve above; throwing it away here is what made the answer an inference
    // wearing the costume of a fact.
    //
    // Unowned is not the same as new. `persistSessionRuntime` is called from the
    // interactive POST /messages path and nowhere else, so a scheduled run or a
    // room turn can go many turns with no row at all — this flag says a runtime
    // was guessed, never how much the session has done.
    //
    // A separate optional flag rather than omitting `runtime` or echoing the
    // hint: both of those change what an existing client reads, and one of them
    // would have this route report a binding the first turn has not written yet
    // (ADR-0255). This adds a field and moves nothing.
    const body = bound ? loose : { ...loose, runtimeUnbound: true as const };
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
      return c.json({ ...body, permissionModePendingUntilNextTurn: true }, 202);
    }
    return c.json(body);
  });
}
