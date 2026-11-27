/**
 * Hold a confirm-first capability call for the "Confirm it's you" sheet
 * (ADR 261125-114705, decision 4). The capability mount calls this when
 * `registry.invoke` refuses a call with `ConfirmFirstRequired`.
 *
 * It reuses the step-up holds the account and front-door writes use, so the
 * call answers the same `428` and the app shows the same sheet:
 *
 * - **Bound to the browser that asked**: the hold records the asking sign-in,
 *   and only that sign-in may confirm it (`routes/step-up.ts`). A caller with
 *   no sign-in can't hold one once an owner exists.
 * - **Single use and short-lived**: the hold is taken before it commits, and
 *   dropped after `STEP_UP_TTL_MS` (`step-up-holds.ts`).
 * - **No agent path**: only the person's password, from the app's own page,
 *   commits it, and the registry runs the call only with the confirmation
 *   minted here, for that capability and that input, once.
 * - **Its declared bar, on both requests** (DOR-4978): `account-owner` runs
 *   `runAccountWrite` (the owner and front-door bars, and a relinked account
 *   needs a fresh ask); `front-door` runs `runFrontDoorWrite` (the owner, in
 *   person, through this computer's ingress). Each bar runs on the asking
 *   request and again on the confirming one, on its own, and a `front-door`
 *   confirm must come the same way (ingress kind) as its ask.
 * - **A caller bar, fresh on both** (DOR-4978, Security t1j 2026-11-27): a
 *   `front-door` hold on a capability behind `http.callerBar` keeps only the
 *   asking caller's kind tag ({@link HeldCaller}), never its pass. Its confirm
 *   runs, before anything about the hold, the caller bar afresh, the same-kind
 *   check, then the front-door bar and its ingress; a refusal reads as no
 *   hold and leaves it held. The call then runs with the confirm's own pass.
 *   So a confirm that came another way in answers `404 expired` here, where a
 *   front-door hold with no caller bar (#4526's MCP holds) answers `403`
 *   `CONFIRM_ANOTHER_WAY` after the password: behind a caller bar the
 *   check runs before anything about the hold, and Security's terms (t1j,
 *   2026-11-27) say such a refusal tells the caller nothing about it.
 * - **Audited without the input**: the hold and the confirm each leave a row
 *   naming the capability and its bar, and nothing it was sent.
 *
 * @module routes/capability-confirm-first
 */
import type { Context } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  personConfirmed,
  type ConfirmFirstBar,
  type ConfirmFirstRequired,
} from '../services/core/capabilities/index.js';
import { runAccountWrite } from './cloud-owner-bar.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** Why a confirm was refused before anything about its hold was looked at. */
type NotAdmitted = 'caller-bar' | 'caller-kind' | 'ingress' | 'front-door';

/** Record a confirm-first hold or confirm: the capability and its bar, never the input. */
function auditConfirmFirst(
  capabilityId: string,
  bar: ConfirmFirstBar,
  step: 'held' | 'confirmed',
  outcome?: number | NotAdmitted
): void {
  const notAdmitted = typeof outcome === 'string';
  const refused = notAdmitted || (outcome !== undefined && outcome >= 400);
  const summary =
    step === 'held'
      ? `Held ${capabilityId} until the owner confirms it’s them`
      : notAdmitted
        ? `Refused a confirm, still held: ${capabilityId}`
        : `${refused ? 'Confirmed, but nothing changed' : 'Confirmed and ran'}: ${capabilityId}`;
  recordAudit({
    action: `capability.confirm-first.${step}`,
    operation: 'modify',
    outcome: refused ? 'refused' : 'ok',
    ...(refused
      ? { error: notAdmitted ? `not-admitted-${outcome}` : `not-applied-${outcome}` }
      : {}),
    target: { type: 'capability', id: capabilityId },
    summary: `${summary} (bar: ${bar}).`,
    source: { surface: 'app' },
  });
}

/**
 * The asking caller of a held call behind a caller bar, as the hold keeps it:
 * a kind tag (`person` or a program behind the person bar; the owner behind
 * the account-decision bar, hashed) and the bar itself, never its pass.
 */
export interface HeldCaller {
  /** The asking request's kind tag. */
  readonly tag: string;
  /** Run the caller bar afresh on a request: its kind tag, or `undefined` when it refused. */
  readonly tagOf: (facts: RequestFacts) => string | undefined;
}

/**
 * The confirming request's own bars for a held call behind a caller bar, in
 * Security's order: the caller bar afresh, the same kind of caller (refused,
 * never relabelled), then the front-door bar and the ingress the ask came by.
 */
function admitConfirm(
  capabilityId: string,
  subject: string,
  caller: HeldCaller,
  askedVia: RequestFacts['ingress']
): (confirming: RequestFacts) => NotAdmitted | undefined {
  return (confirming) => {
    const tag = caller.tagOf(confirming);
    const why: NotAdmitted | undefined =
      tag === undefined
        ? 'caller-bar'
        : tag !== caller.tag
          ? 'caller-kind'
          : confirming.ingress !== askedVia
            ? 'ingress'
            : refuseFrontDoorChange(confirming, subject)
              ? 'front-door'
              : undefined;
    if (why) auditConfirmFirst(capabilityId, 'front-door', 'confirmed', why);
    return why;
  };
}

/**
 * Hold one refused call until the person confirms it.
 *
 * @param c - The request that asked.
 * @param capabilityId - The capability held.
 * @param held - The registry's refusal: the parsed input, the declaration and,
 *   for a `front-door` hold, the sheet the server built.
 * @param commit - Run the call again as the confirming request, with the
 *   person's confirmation.
 * @param caller - For a capability behind a caller bar, the asking caller's
 *   kind tag and the bar to run afresh on the confirm ({@link HeldCaller}).
 * @returns The `428` with the held action's id, or a refusal; with no owner
 *   account yet, the front-door bar alone, and the call's own answer.
 */
export async function holdConfirmFirst(
  c: Context<ApiEnv>,
  capabilityId: string,
  held: ConfirmFirstRequired,
  commit: (confirming: RequestFacts, confirmation: unknown) => Promise<Response>,
  caller?: HeldCaller
): Promise<Response> {
  const { hold, input, sheet } = held;
  // Set once the 428 is out, so a write that runs with no owner yet is no confirm.
  let asked = false;
  const action = {
    kind: hold.kind,
    run: (confirming: RequestFacts) =>
      commit(confirming, personConfirmed(capabilityId, input, sheet?.heldState)),
    onConfirmed: (status: number) => {
      if (asked) auditConfirmFirst(capabilityId, hold.bar, 'confirmed', status);
    },
  };
  let answer: Response;
  if (hold.bar === 'front-door') {
    // The registry builds it for every front-door hold; without one there is nothing to show.
    if (!sheet) throw new Error(`Capability "${capabilityId}" was held with no sheet.`);
    answer = await runFrontDoorWrite(c, {
      ...action,
      subject: hold.subject,
      bindIngress: true,
      ...(caller
        ? { admit: admitConfirm(capabilityId, hold.subject, caller, honoRequestFacts(c).ingress) }
        : {}),
      target: sheet.target,
      // Bound to what runs with each secret by name, never the input itself, and
      // to the sealed state the sheet was built from, so a resend after it moved holds afresh.
      input:
        sheet.heldState === undefined ? sheet.bound : { bound: sheet.bound, at: sheet.heldState },
      reason: sheet.reason,
      ...(sheet.notes ? { notes: sheet.notes } : {}),
      ...(sheet.warnings ? { warnings: sheet.warnings } : {}),
    });
  } else {
    answer = await runAccountWrite(c, {
      ...action,
      target: hold.target,
      input,
      reason: hold.reason,
    });
  }
  if (answer.status === 428) {
    asked = true;
    auditConfirmFirst(capabilityId, hold.bar, 'held');
  }
  return answer;
}
