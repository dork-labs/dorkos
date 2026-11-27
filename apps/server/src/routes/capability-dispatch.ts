/**
 * Run one capability for one HTTP request, and answer with its result or its
 * refusal (ADR 261123-170830).
 *
 * Every HTTP door onto a capability comes through here: the generic invoke
 * endpoint (`POST /api/capabilities/{id}/invoke`, `routes/capabilities-invoke.ts`)
 * and each capability's own REST path (`capability-http.ts`). So a
 * caller meets the same gate, the same Wi-Fi rule, the same approval header and
 * the same statuses whichever door it used.
 *
 * ## What it answers
 *
 * | Outcome | Status |
 * | --- | --- |
 * | The capability ran | the route's success status (`200` unless declared) |
 * | A person must approve first | `202`, the approval payload (not an error) |
 * | A declared precheck found its part of DorkOS not started (`http.precheck`) | `503` problem, first |
 * | A caller that is not a person called a person-only capability (`http.audience: 'person'`) | `403` problem, `person_only` (from `registry.invoke`) |
 * | The account-decision bar refused (`http.callerBar: 'account-decision'`) | its `403`/`401` problem, before the input is read |
 * | The person bar refused (`http.callerBar: 'person'`) | its `403` problem, before the input is read |
 * | The gate refused for good | `403` problem, {@link gateRefusalProblem} |
 * | A network sign-in asked for an `act` or `destructive` one that declares no network mode (`wifi`) | `403` problem, `not_from_wifi` |
 * | The input failed the capability's schema | `400` problem, `invalid_request` |
 * | The capability refused (`CapabilityToolError`) | problem, {@link toolRefusalProblem} |
 * | Unknown id | `404` problem, `unknown_capability` |
 * | A stopped extension's tool, or the server still starting | `503` problem, `temporarily_unavailable` |
 * | Anything else | `500` problem, `internal_error` |
 *
 * Every refusal is a problem document (ADR 261123-170831) whose `detail` is a
 * fixed sentence: never an exception's text, a path or a handler's own words.
 *
 * @module routes/capability-dispatch
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  EXTENSION_TOOL_UNAVAILABLE_MESSAGE,
  isExtensionCapabilityId,
  type HttpPrecheck,
  type HttpSuccessStatus,
  type HttpSurface,
} from '@dorkos/shared/capabilities';
import type { Problem } from '@dorkos/shared/problem';

import {
  APPROVAL_TOKEN_HEADER,
  CapabilityGateRefusal,
  CapabilityToolError,
  ConfirmFirstRequired,
  personCaller,
  type CapabilityRegistry,
  type CapabilityRequestFacts,
} from '../services/core/capabilities/index.js';
import { isFromWifi, WIFI_ACTION_REFUSAL } from '../services/core/auth/sessions/wifi-level.js';
import { deviceIdOf } from '../services/core/auth/sessions/signed-in-devices.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, problemBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import {
  clearsTheAgentBar,
  frontDoorRefusal,
  presentsProgram,
  presentsProgramCredential,
  readCallerAuthority,
  refuseFrontDoorChange,
  refuseUnlessAccountOwner,
} from '../lib/caller-authority.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { heldWifiOwner, personProof } from '../services/todos/caller.js';
import type { RequestFacts } from '../http/request-facts.js';
import { gateResponse, loggableRefusal, toolRefusalProblem } from './capability-refusals.js';
import { holdConfirmFirst } from './capability-confirm-first.js';
import { requestAbortSignal } from './connector-owner-boundary.js';
import { isDocOperatorAccount } from '../services/canvas/doc-channel/doc-source-policy.js';
import { problemRefusalUnlessOwner } from './cloud-owner-bar.js';
import { CONFIRM_ANOTHER_WAY, frontDoorProblem } from './front-door-step-up.js';
import {
  accountDecisionBar,
  accountDecisionSentence,
  type AccountDecisionPolicy,
} from '../lib/http/account-decision-bar.js';
import {
  accountDecisionPassed,
  personBarPassed,
  type AccountDecisionPass,
  type PersonBarPass,
} from '../services/core/capabilities/context/owner-authority.js';
import { assessPerson } from '../lib/http/person-bar.js';

/** What a request answers while boot has not handed the registry over. */
const STILL_STARTING = 'DorkOS is still starting. Try again in a moment.';

/** What an id no capability has answers. */
const UNKNOWN_CAPABILITY = 'No action has that id. List them with `dorkos capabilities`.';

/**
 * The capabilities whose call stops when its client goes away, as their hand
 * routes did (`requestAbortSignal`): the live request's signal reaches the
 * handler as `context.signal`. A held call's commit gets none, as the hand
 * route's closure over the asking request never fired once that request ended.
 */
const FOLLOWS_CLIENT: ReadonlySet<string> = new Set(['connectors.answer_agent_request']);

/** What a commit answers when its confirmation was not for the call it ran. */
const CONFIRMED_ANOTHER_CALL = 'That confirmation was for a different request. Confirm this one.';

/** What an unexpected failure answers; the error itself goes to the log. */
const CAPABILITY_FAILED = 'DorkOS hit an error running that action. Try again.';

/** How one request reaches one capability. */
export interface CapabilityDispatch {
  /** The composed registry, or `undefined` while the server is still starting. */
  registry: CapabilityRegistry | undefined;
  /** The capability id. */
  id: string;
  /** The capability's raw input, before its schema parses it. */
  input: unknown;
  /** The status a success answers with. Defaults to `200`. */
  success?: HttpSuccessStatus;
  /**
   * Set by the capability's own REST path (`capability-http.ts`), never by
   * `POST /api/capabilities/{id}/invoke`: only this door mints the person proof
   * for every `observe` call, which lets the person's own read pass an area
   * Blocked for agents (DOR-4978).
   */
  rest?: true;
  /** What the doors run before a capability that declares a bar or a precheck. */
  ports?: CapabilityDoorPorts;
}

/**
 * What the HTTP doors run for a capability before its handler, injected at the
 * composition root (`http/hono-api.ts`), the same on the REST path and on
 * `/invoke`.
 */
export interface CapabilityDoorPorts {
  /**
   * The account-decision bar's policy, for a capability that declares
   * `http.callerBar: 'account-decision'`. Absent, no proof is minted and the
   * registry refuses such a capability `person_only`.
   */
  accountDecision?: AccountDecisionPolicy;
  /** Each declared precheck (`http.precheck`): its `503` problem, or `undefined` to go on. */
  prechecks?: Partial<Record<HttpPrecheck, () => Problem | undefined>>;
}

/**
 * Invoke one capability as the request's caller and answer with the outcome.
 *
 * The caller's agent identity, whether a machine presented one at all, the
 * signed-in person and the `X-DorkOS-Approval` retry token are read from the
 * request; the tier and permission gate runs inside `registry.invoke`. No
 * caller is ever marked trusted here, even a signed-in owner: these are the
 * generic actuation doors, and the cost of gating them is one Allow click for a
 * person running a destructive capability from a shell.
 *
 * @param c - The request.
 * @param dispatch - What to run; see {@link CapabilityDispatch}.
 * @returns The response.
 */
export async function dispatchCapability(
  c: Context<ApiEnv>,
  dispatch: CapabilityDispatch
): Promise<Response> {
  const { registry, id, input } = dispatch;
  if (!registry) {
    return problem(c, 'temporarily_unavailable', { detail: STILL_STARTING });
  }
  const capability = registry.get(id);
  if (!capability && isExtensionCapabilityId(id)) {
    return problem(c, 'temporarily_unavailable', { detail: EXTENSION_TOOL_UNAVAILABLE_MESSAGE });
  }
  if (!capability) {
    return problem(c, 'unknown_capability', { detail: UNKNOWN_CAPABILITY });
  }

  const http = capability.surfaces.http;
  // A declared precheck answers first, as the hand group's middleware did.
  const unavailable = http?.precheck && dispatch.ports?.prechecks?.[http.precheck]?.();
  if (unavailable) return sendProblem(c, unavailable);

  const facts = honoRequestFacts(c);
  // The caller bar, before the input is read (DOR-4978): the same function the
  // hand routes run, so the order, codes and step-up note match.
  const bar = http ? callerBarOf(http, dispatch.ports?.accountDecision) : undefined;
  const asked = bar?.(facts);
  if (asked && !asked.ok) return sendProblem(c, asked.problem);
  // A front-door confirm-first capability runs its bar first, as its hand route
  // did, so a person not allowed to change it hears why before anything else.
  // A program or an agent is left to `registry.invoke`, which answers `person_only`.
  // Behind a caller bar it runs where those hand routes ran it: at the hold.
  const hold = capability.confirmFirst;
  if (hold?.bar === 'front-door' && !bar && !presentsProgram(facts)) {
    const refusal = refuseFrontDoorChange(facts, hold.subject);
    if (refusal) return frontDoorProblem(c, refusal);
  }
  // A Wi-Fi sign-in reads through capabilities, but acts at the computer
  // (DOR-2969): an `act` or `destructive` one is refused before it runs,
  // unless it declares a network mode (ADR 261125-114705, decision 3): it only
  // lowers an agent's power (`lowers-power`, a pause), or it is a person's own
  // write (`person-held`), which only a person reaches (`audience: 'person'`,
  // asserted at compose) and which the request facts below hold to the Wi-Fi
  // hold: a held device never proves the owner, and is named as held. The
  // person bar does not depend on this line: `registry.invoke` re-checks the
  // audience on every call, whatever door or network it came through.
  if (isFromWifi(facts) && capability.tier !== 'observe' && capability.wifi === undefined) {
    return problem(c, 'not_from_wifi', { detail: WIFI_ACTION_REFUSAL });
  }

  // An account-owner confirm-first capability runs the account owner bar first,
  // held or not, as the account writes always did (ADR 261125-114705, decision 4).
  if (hold?.bar === 'account-owner') {
    const refusal = problemRefusalUnlessOwner(facts, hold.accountOwner);
    if (refusal) return sendProblem(c, refusal);
  }
  return invokeAs(
    c,
    registry,
    {
      id,
      input,
      success: dispatch.success ?? 200,
      ...(dispatch.rest ? { rest: true } : {}),
      ...(asked?.ok ? asked.passes : {}),
      ...(bar && asked?.ok ? { bar: { check: bar, tag: asked.tag } } : {}),
    },
    facts
  );
}

/** The passes a caller bar mints, as `registry.invoke` takes them. */
interface CallerBarPasses {
  accountDecision?: AccountDecisionPass;
  personBar?: PersonBarPass;
}

/**
 * What a caller bar decided for one request: its pass and the caller's kind
 * tag, or its refusal. The tag is all a held call keeps (DOR-4978, Security
 * t1j): `person` or `program` behind the person bar, the owner (hashed) behind
 * the account-decision bar.
 */
type CallerBarOutcome =
  | { readonly ok: true; readonly tag: string; readonly passes: CallerBarPasses }
  | { readonly ok: false; readonly problem: Problem };

/** A capability's caller bar, run in full on whichever request it is handed. */
type CallerBarCheck = (facts: RequestFacts) => CallerBarOutcome;

/**
 * The caller bar a capability declares (`http.callerBar`), or `undefined`
 * when it declares none, or the account-decision bar's policy was not handed
 * over (the registry then refuses it `person_only`).
 *
 * @param http - The capability's HTTP surface.
 * @param policy - The account-decision bar's policy, if handed over.
 */
function callerBarOf(
  http: HttpSurface,
  policy: AccountDecisionPolicy | undefined
): CallerBarCheck | undefined {
  if (http.callerBar === 'account-decision' && policy) {
    return (facts) => {
      const outcome = accountDecisionBar(facts, policy);
      if (!outcome.ok) {
        const { code, which } = outcome.refusal;
        // The sentence is the definition's own, never from the request; compose
        // refuses an owner bar without one (`narrow-declarations.ts`).
        return {
          ok: false,
          problem: problemBody(code, { detail: accountDecisionSentence(which, http.ownerOnly!) }),
        };
      }
      const { owner } = outcome;
      const who =
        owner.kind === 'user' ? `user:${owner.userId}` : `install:${owner.installationId}`;
      const tag = `owner:${createHash('sha256').update(who).digest('hex')}`;
      return { ok: true, tag, passes: { accountDecision: accountDecisionPassed(owner) } };
    };
  }
  if (http.callerBar === 'person') {
    // The copy is the definition's own (compose requires it).
    return (facts) => {
      const refused = assessPerson(facts, http.personCopy!);
      if (refused) return { ok: false, problem: refused.body };
      // Who it let through, never more: a key is a program, even with login off.
      const program = presentsProgramCredential(facts) || facts.user?.credential === 'api-key';
      const caller = program ? 'program' : 'person';
      return {
        ok: true,
        tag: `person-bar:${caller}`,
        passes: { personBar: personBarPassed(caller) },
      };
    };
  }
  return undefined;
}

/**
 * Hold a refused confirm-first call for the sheet, keeping no pass: behind a
 * caller bar only the asking caller's kind tag, and the bar to run afresh on
 * the confirm, which earns its own pass (DOR-4978, Security t1j).
 *
 * @param c - The request that asked.
 * @param registry - The composed registry.
 * @param call - The call, without its passes.
 * @param held - The registry's refusal.
 * @param bar - The caller bar and the asking caller's tag, if any.
 */
function holdWithoutPass(
  c: Context<ApiEnv>,
  registry: CapabilityRegistry,
  call: HeldCall,
  held: ConfirmFirstRequired,
  bar: { readonly check: CallerBarCheck; readonly tag: string } | undefined
): Promise<Response> {
  if (!bar) {
    return holdConfirmFirst(c, call.id, held, (confirming, confirmation) =>
      invokeAs(c, registry, call, confirming, confirmation)
    );
  }
  const tagOf = (facts: RequestFacts) => {
    const outcome = bar.check(facts);
    return outcome.ok ? outcome.tag : undefined;
  };
  return holdConfirmFirst(
    c,
    call.id,
    held,
    (confirming, confirmation) => {
      // The confirm's own pass, from the bar run afresh on it. Its step-up
      // already ran the bar before the hold; this is the pass the call runs with.
      const again = bar.check(confirming);
      if (!again.ok) return Promise.resolve(sendProblem(c, again.problem));
      if (again.tag !== bar.tag) {
        return Promise.resolve(problem(c, 'operator_only', { detail: CONFIRM_ANOTHER_WAY }));
      }
      return invokeAs(c, registry, { ...call, ...again.passes }, confirming, confirmation);
    },
    { tag: bar.tag, tagOf }
  );
}

/** One call as the mount runs it: the capability, its raw input, and how it answers. */
interface HeldCall {
  id: string;
  input: unknown;
  success: HttpSuccessStatus;
  rest?: boolean;
}

/**
 * Invoke one capability as one request's caller, and answer.
 *
 * @param c - The request the answer is for.
 * @param registry - The composed registry.
 * @param call - The capability, its raw input, its success status, whether it came
 *   through the capability's own REST path (`rest`, never `/invoke`), and the
 *   caller bar's passes and check, if it declares one.
 * @param facts - The caller: the asking request's facts, or, when a held call
 *   commits, the confirming request's.
 * @param confirmed - The person's confirmation, only when a held call commits.
 */
async function invokeAs(
  c: Context<ApiEnv>,
  registry: CapabilityRegistry,
  call: HeldCall &
    CallerBarPasses & {
      bar?: { readonly check: CallerBarCheck; readonly tag: string };
    },
  facts: RequestFacts,
  confirmed?: unknown
): Promise<Response> {
  const { id, input, success } = call;
  const capability = registry.get(id);
  // The call is attributed when the caller presented a resolved agent token;
  // without one it runs unattributed, which does NOT make it ungated: the
  // capability's tier decides that (`tier-enforcement.ts`). The wider fact, that
  // a machine presented any token at all, travels separately, so a handler can
  // tell a revoked agent from the person at the keyboard (DOR-1361). The
  // signed-in person is named too: "no agent token" is not "the owner".
  const identity = facts.agentIdentity;
  const agentIdentityPresented = presentsAgentIdentity(facts);
  const user = facts.user;
  // The retry carries its approval token in a header, never the input: the
  // approval is bound to a hash of that input.
  const header = facts.headers[APPROVAL_TOKEN_HEADER];
  const approvalToken = (Array.isArray(header) ? header[0] : header)?.trim();
  // Proof of a person: the same bar the decide endpoint and the hand person-only
  // routes use, plus no bearer. A person-only capability asks for it, and
  // `registry.invoke` refuses one without it (ADR 261123-170830). A
  // capability's own REST path also mints it for every `observe` call, tagged
  // `rest-proof` when no program credential came either (no API key): that
  // lets the person's own read pass an area a person Blocked for agents, and
  // nothing else (DOR-4978, `personReadsPastArea`). Only for a read: minting
  // marks a missing person session, which would turn an `act` call's own
  // refusal into a password prompt that changes nothing. `/invoke` never tags it.
  // Only from the live request: a held call's replay (`confirmed`) never mints it.
  // Behind the person bar no person proof is minted at all: its own pass
  // stands in, so a caller it let through never holds a person's authority.
  const barred = capability?.surfaces.http?.callerBar === 'person';
  const restRead =
    !barred && call.rest === true && confirmed === undefined && capability?.tier === 'observe';
  const person =
    restRead || (!barred && capability?.surfaces.http?.audience === 'person')
      ? personCaller(
          {
            ...readCallerAuthority(facts),
            authorizationPresented: facts.headers.authorization !== undefined,
          },
          restRead && !presentsProgramCredential(facts)
            ? { readGroup: readGroupOf(facts) }
            : undefined
        )
      : undefined;

  const active =
    confirmed === undefined && FOLLOWS_CLIENT.has(id) ? requestAbortSignal(c) : undefined;
  try {
    const result = await registry.invoke(id, input, {
      ...(active ? { signal: active.signal } : {}),
      ...(identity ? { identity } : {}),
      ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
      ...(user ? { userId: user.userId } : {}),
      ...(approvalToken ? { approvalToken } : {}),
      ...(person ? { person } : {}),
      ...(call.accountDecision ? { accountDecision: call.accountDecision } : {}),
      ...(call.personBar ? { personBar: call.personBar } : {}),
      request: capabilityRequestFacts(
        facts,
        restRead && person !== undefined && !presentsProgramCredential(facts)
      ),
      retryChannel: 'http-header',
      ...(confirmed !== undefined ? { confirmed } : {}),
    });
    return success === 204 ? c.body(null, 204) : c.json(result, success);
  } catch (err) {
    // 202: recorded and waiting on a person, so come back. 403: refused for good.
    if (err instanceof CapabilityGateRefusal) return gateResponse(c, err.decision);
    // Held for the "Confirm it's you" sheet; a held call that commits is never held again.
    if (err instanceof ConfirmFirstRequired) {
      // Defence in depth: a commit replays the same call it held, so its confirmation matches.
      if (confirmed !== undefined) {
        return problem(c, 'precondition_failed', { detail: CONFIRMED_ANOTHER_CALL });
      }
      // The held call keeps no pass: the confirm earns its own.
      const { accountDecision: _owner, personBar: _person, bar, ...held } = call;
      return holdWithoutPass(c, registry, held, err, bar);
    }
    if (err instanceof z.ZodError) {
      return validationProblem(c, err);
    }
    // The capability refused (agent not found, system agent protected, …):
    // a problem from the fixed table, never the handler's own words.
    if (err instanceof CapabilityToolError) {
      // The handler's own words (an upstream's raw answer, say) stay in the log; what a
      // refusal carries to the caller (a stale save's file text) never does.
      logger.debug('[capabilities] invoke refused', { id, payload: loggableRefusal(err.payload) });
      return sendProblem(c, toolRefusalProblem(err.payload));
    }
    logger.error('[capabilities] invoke failed', { id, err });
    return problem(c, 'internal_error', { detail: CAPABILITY_FAILED });
  } finally {
    active?.dispose();
  }
}

/**
 * The answers about one request a capability handler may see.
 *
 * The dispatcher and the hand routes that share a handler's checks both call
 * this, so the two cannot drift. Each is worked out only when a handler first reads it, and once: the owner
 * bar records a request it refused for want of the person's session, which
 * turns the route's refusal into the step-up (`http/person-session-refusal.ts`),
 * so it must run only for a handler that actually asks, as the hand routes did.
 *
 * @param facts - The request's facts.
 * @param personOnRestPath - Whether the capability's own REST path minted a person proof for
 *   this read, with no program credential (no API key or bearer).
 * @returns The derived answers; no header value is in them.
 */
export function capabilityRequestFacts(
  facts: RequestFacts,
  personOnRestPath = false
): CapabilityRequestFacts {
  let agentBar: boolean | undefined;
  let accountOwner: boolean | undefined;
  let ownerProven: boolean | undefined;
  let local: boolean | undefined;
  let held: boolean | undefined;
  let frontDoor: ReturnType<typeof frontDoorRefusal> | null = null;
  const frontDoorAnswer = () =>
    frontDoor === null ? (frontDoor = frontDoorRefusal(facts)) : frontDoor;
  // Frozen, so no handler can rewrite what the mount worked out (the getters still work).
  return Object.freeze({
    get clearsAgentBar() {
      return (agentBar ??= clearsTheAgentBar(facts));
    },
    get accountOwner() {
      return (accountOwner ??= refuseUnlessAccountOwner(facts) === undefined);
    },
    get ownerProven() {
      return (ownerProven ??= personProof(facts));
    },
    get atThisComputerWithoutProgramKey() {
      return (local ??= isAtThisComputer(facts) && !presentsProgramCredential(facts));
    },
    get heldWifiOwner() {
      return (held ??= heldWifiOwner(facts));
    },
    get frontDoorOwner() {
      return frontDoorAnswer() === undefined;
    },
    get frontDoorElsewhere() {
      return frontDoorAnswer() === 'not-at-this-computer';
    },
    get ownerOrNoAccount() {
      return isDocOperatorAccount(facts.user);
    },
    personOnRestPath,
  });
}

/**
 * What a person's repeated reads are grouped by in the audit log (DOR-4978):
 * the sign-in's opaque device id, else the network address. Never a session
 * id, a key or anything the caller chose. Carried on the person proof to the
 * audit observer only, never into a handler's context.
 *
 * @param facts - The request's facts.
 */
function readGroupOf(facts: RequestFacts): string {
  const sessionId = facts.user?.sessionId;
  if (sessionId) return `sign-in:${deviceIdOf(sessionId)}`;
  return `address:${facts.peerAddress ?? 'unknown'}`;
}
