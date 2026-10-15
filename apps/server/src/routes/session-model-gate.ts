import { creditsCapabilitiesFor } from '../services/core/cloud/credits-protocols.js';
/**
 * The model gate: whether a session's runtime can run the model a request
 * names. Shared by `PATCH /api/sessions/:id` (the model picker) and
 * `POST /api/sessions/:id/continue` (continuing a limited session on another
 * model), so both refuse exactly the same models.
 *
 * @module routes/session-model-gate
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { PermissionModeId } from '@dorkos/shared/types';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ModelOption } from '@dorkos/shared/types';
import { logger } from '../lib/logger.js';
import { judgeCreditsModel } from '../services/core/cloud/credits-models.js';
import { resolvedModelFor } from '../services/core/cloud/credits-model-gate.js';

/** What the model gate needs to know about who pays for the session. */
export interface ModelGateOptions {
  /**
   * The session runs (or will run) on DorkOS credits, so the model has to be
   * one credits serve on its runtime's protocol, whatever the runtime's own
   * catalog says.
   */
  onCredits?: boolean;
  /** Conversation whose frozen request format applies. */
  sessionId?: string;
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
 * A catalog only convicts when it is fit to — {@link catalogUnfitToConvict} is
 * that whole question, and both of its answers land here as an accepted write.
 *
 * Matching allows `resolvedModel` as well as `value` because claude-code's
 * catalog rows are ALIASES (`sonnet`, `opus`) naming the wire id they expand to;
 * a session that persisted the wire id must keep working.
 *
 * WRITE PATH ONLY: a session already persisted on a now-absent model still loads
 * and runs, and the picker surfaces it as unavailable so the person can choose.
 *
 * **On DorkOS credits, once the service says which protocols its models are
 * on, none of that degrading applies.** The catalog is the service's list of
 * what credits serve, filtered by the runtime's protocol, and it convicts: an
 * unlisted model is refused, and so is every model while the list cannot be
 * read (spec `dorkos-account-by-default` §1). A service that says nothing about
 * protocols leaves this gate exactly as it was.
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param model - The model id the request asks to store.
 * @param options - Whether the session runs on credits.
 */
export async function rejectUnknownModel(
  runtime: AgentRuntime,
  model: string,
  options: ModelGateOptions = {}
): Promise<string | null> {
  // On credits, once the service says which protocols its models are on, its
  // list is the catalog and it does not degrade: a model it does not list is
  // never stored, and neither is anything while the list cannot be read. A
  // service that says nothing leaves the runtime's own check below in charge.
  if (options.onCredits) {
    const verdict = await judgeCreditsModel(
      creditsCapabilitiesFor(runtime, options.sessionId),
      model,
      await resolvedModelFor(runtime, model)
    );
    if (verdict.judged) return verdict.refusal;
  }
  let offered: ModelOption[];
  try {
    offered = await runtime.getSupportedModels();
  } catch {
    logger.debug('[model gate] declined: the catalog probe threw', {
      runtime: runtime.type,
      model,
    });
    return null;
  }
  const unfit = catalogUnfitToConvict(offered);
  if (unfit) {
    logger.debug(`[model gate] declined: ${unfit}`, { runtime: runtime.type, model });
    return null;
  }
  if (offered.some((option) => option.value === model || option.resolvedModel === model)) {
    return null;
  }
  return `The ${runtime.type} runtime cannot run model '${model}'. Pick one from the model menu.`;
}

/**
 * Why this catalog has no standing to refuse a model, or `null` when it does.
 *
 * Absence from a catalog is only evidence against a model when the catalog is
 * both COMPLETE and CONFIRMED. Two states fail that, and they are the same
 * epistemic state wearing different clothes — no usable evidence — so the gate
 * declines in both rather than convicting on a guess. The string is the reason,
 * logged by {@link rejectUnknownModel}: the two declines are indistinguishable
 * from outside (each one accepts the write), so the reason is worth saying
 * rather than leaving the next person debugging a "why did this go through" to
 * re-derive it. At `debug`, which means DEV ONLY — the default level is `info`
 * in production, so this line is dropped there. That is the right trade for a
 * path whose outcome is a successful write: nothing is being diagnosed in
 * production from its absence, and an operator who needs it can raise the level.
 *
 * **Empty** is not a claim that the runtime has no models — it is what a runtime
 * returns when it cannot answer: an unreachable OpenCode sidecar, a claude-code
 * warm-up that timed out, `test-mode`, which has no catalog at all. Refusing on
 * an empty list would turn a probe failure into a locked picker. (A throwing
 * `getSupportedModels` is read the same way, at the call site.)
 *
 * **Unverified** is the same failure with rows in it. When OpenCode reports no
 * connected provider it still offers a menu — the models.dev universe, sorted
 * and cut to the highest-signal 200, every row marked `unverified` (DOR-1660).
 * That list is explicitly a guess, and the UI says so out loud on three surfaces
 * (`UnverifiedCatalogNotice`). An operator who supplied credentials through
 * provider env vars can genuinely run a model that sorted past the cut, and the
 * gate used to answer "the opencode runtime cannot run" it — DOR-1660's
 * complaint ("it offers models that cannot run") inverted at a new door.
 *
 * ## Why ANY unverified row is enough, not only an all-unverified list
 *
 * The flag describes the MENU, not the row: per its schema, an `unverified` row
 * "comes from a shortened, unconfirmed menu". One such row is therefore testimony
 * that a shortened menu fed this list, and a shortened menu's ABSENCES prove
 * nothing — which is the only thing the gate reads a catalog for. It is also the
 * definition every client surface already uses (`models.some((m) =>
 * m.unverified)` in `ModelRow`, `ModelSelectionList`, `AgentExecutionRows`), so
 * the server refuses exactly when the picker is not warning the person. Today's
 * only producer is all-or-nothing, so `some` and `every` agree on real data;
 * `some` is the reading that stays honest if a future producer mixes a confirmed
 * spine with guessed additions.
 *
 * @param offered - The catalog rows the runtime answered with.
 */
function catalogUnfitToConvict(offered: ModelOption[]): string | null {
  if (offered.length === 0) return 'the runtime offered no catalog';
  if (offered.some((option) => option.unverified)) {
    return 'the catalog is a shortened, unconfirmed menu';
  }
  return null;
}

/**
 * Check a requested permission mode against what the runtime declares it can
 * run, returning an operator-readable message when it cannot (or `null` when
 * the mode is fine).
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param permissionMode - The mode the request asks to store.
 */
export function rejectUndeclaredPermissionMode(
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
export function modelGateAuthority(
  owner: AgentRuntime,
  bound: boolean,
  hint: string | undefined
): AgentRuntime | null {
  if (bound) return owner;
  if (hint === undefined || !runtimeRegistry.has(hint)) return null;
  return runtimeRegistry.get(hint);
}
