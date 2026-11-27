/**
 * The one way a caller may reach a capability WITHOUT the tier gate
 * (spec `agent-trust` §3.2, DOR-467).
 *
 * Moving the gate inside `registry.invoke` makes every registry-borne surface
 * gated by construction. That is only usable if there is also an honest answer
 * for the surface that is not an agent at all: the person clicking Uninstall in
 * their own cockpit. This module is that answer, and it is deliberately the
 * SMALLEST one that can exist.
 *
 * ## The property that matters: no value that arrived as JSON can be one
 *
 * {@link TrustedCaller} is an instance of a class this module does not export,
 * and `isTrustedCaller` is an `instanceof` check. So a crafted MCP argument, an
 * HTTP body, a query string, a header — everything that arrives over the wire and
 * through `JSON.parse` — cannot be one. A plain object with the right-looking
 * fields is not trusted, and neither is `JSON.parse(JSON.stringify(realMarker))`.
 * Both are pinned by tests.
 *
 * That is the whole claim, and it is deliberately narrower than "unforgeable".
 * **In-process JavaScript holding a real marker CAN make another one** —
 * `new (real.constructor)(…)`, `Object.create(proto)`, `Object.setPrototypeOf`,
 * a subclass, a `Proxy` wrapping one. Review demonstrated all five. And in-process
 * code does not even need one to start with: {@link trustedCaller} hands a genuine
 * marker to any caller that can fabricate a request object, which is three lines.
 *
 * ## What non-export actually buys, which is not attacker cost
 *
 * It buys **scan integrity**, and that is load-bearing rather than reassurance.
 *
 * Not exporting the class does NOT make an attacker work harder, because the cheap
 * route is untouched by it: in-process code that wants trust calls the exported
 * {@link trustedCaller}, not `real.constructor`. The prototype routes above only
 * matter to code that already holds a marker, which by definition already has
 * trust. There is no scenario where non-export adds a step.
 *
 * What it does is keep ONE token exhaustive.
 * `__tests__/gate-bypass-scan.test.ts` watches `trustedCaller(` and pins which
 * modules may call it. If the class were exported, a module could write
 * `new TrustedCallerMarker(…)` and mint trust the scan would never see — that
 * constructor is not a listed protected effect, and nobody would think to add it.
 * Non-export is precisely what makes the scan's single watched token cover every
 * in-process path to a marker. **So the in-process boundary is the call-site scan,
 * and non-export is what the scan rests on.** Export this class and the scan
 * quietly stops being exhaustive.
 *
 * What no attacker-supplied DATA can do is become one, and that is the property
 * the wire-facing surfaces actually rely on.
 *
 * This is also why the marker is not a boolean field, a string constant, or an
 * object shape. Any of those would mean "the gate is off for whoever can type the
 * magic value", and every caller of a capability can type any value it likes.
 *
 * ## Trust is proof of a person, and it is the SAME proof used to decide
 *
 * There is exactly one predicate for "is there positive proof of a human here?"
 * in DorkOS, and it already exists: {@link resolveDecisionAuthority}, the guard on
 * `POST /api/approvals/:id/grant`. This module reuses it rather than inventing a
 * second notion of trust, and that reuse is the load-bearing design decision, not
 * a convenience:
 *
 * **Whoever may DECIDE an approval may act without one.** A caller that clears
 * this check could obtain the same effect in two steps anyway — ask, get the 202
 * with the approval id, grant it, retry with the token. Letting it act directly
 * therefore removes no guarantee. Conversely, a caller this check REFUSES cannot
 * grant its own approval either, so gating it is not theatre.
 *
 * ### Under login, that same proof now means a session cookie (DOR-474)
 *
 * The invariant above is what makes this escape safe, so it has to keep holding
 * in BOTH directions, and DOR-474 broke one of them. `POST /api/approvals/:id/grant`
 * now refuses a caller holding a per-user API key while login is on, because
 * the session gate accepts that key as the same identity a browser session proves and
 * agents legitimately hold one. If this module kept minting markers for that same
 * caller, acting without an approval would become STRICTLY MORE powerful than
 * deciding one — the two-step path that justifies the escape would be closed to a
 * caller that could still take the shortcut. So {@link trustedCaller} applies the
 * same cookie requirement, in the same posture, and the invariant survives.
 *
 * Login OFF is unchanged. There is no cookie for anyone in that posture, so
 * demanding one would refuse the person too; the residual is the one the module
 * below states.
 *
 * **The one caller that does NOT want this is no longer a caller.** Adding or
 * removing a package source (DOR-502) is operator-only with no approval card
 * behind it, and `dorkos marketplace add` is a documented terminal verb whose only
 * credential is an API key — so a cookie bar there is a lockout, not a hardening
 * (`services/marketplace/sources/source-write-policy.ts`). That route asked this module
 * for a boolean it then threw away, so it now reads `resolveDecisionAuthority`
 * directly instead of minting a gate-bypass marker it never used. Nothing about
 * that route's posture changed.
 *
 * Read `approvals/decision-authority.ts` for what each posture does and does not
 * promise; the honest summary of the default `local-trust` posture is that with
 * login off there is no cryptographic difference between the person in the
 * cockpit and a program running `curl` on the same machine. What the check DOES
 * enforce in every posture is that a caller presenting an agent identity is
 * refused. That is the whole point here: an agent following its instructions —
 * the prompt-injected agent this feature exists to stop — carries
 * `DORKOS_AGENT_TOKEN`, so `dorkos uninstall` from inside a session presents
 * `X-DorkOS-Agent` and is gated. What is NOT closed is an adversary with shell
 * access who strips its own credential; that is stated rather than papered over,
 * because a forgeable check called security is worse than the gap it hides.
 *
 * ## Trusted and identified is a contradiction, not a precedence question
 *
 * A call carrying both a trusted marker and an agent identity is refused outright
 * by `registry.invoke` rather than resolved in favour of either. The two facts
 * cannot both be true — the marker means "no machine principal presented itself",
 * and the identity is a machine principal presenting itself — so the only correct
 * reading of the pair is that a caller assembled it wrongly. Resolving it in
 * favour of trust would turn a wiring bug into a bypass.
 *
 * @module services/core/capabilities/trusted-caller
 */
import { PERSON_ONLY_CODE, PERSON_ONLY_MESSAGE } from '@dorkos/shared/capabilities';
import type { CapabilityDefinition } from './capability-definition.js';
import { CapabilityToolError } from './mcp-envelope.js';
import {
  resolveDecisionAuthority,
  type DecisionAuthorityRequest,
} from '../approvals/decision-authority.js';

/**
 * The marker itself. **Do not export this class.** Not exporting it is what keeps
 * the call-site scan's single watched token (`trustedCaller(`) exhaustive for
 * in-process minting; an exported constructor would be a second, unwatched way to
 * mint trust. It also means a marker cannot arrive as JSON. The way to obtain one
 * is {@link trustedCaller}, which requires clearing
 * {@link resolveDecisionAuthority}. See the module TSDoc for the full reasoning.
 */
class TrustedCallerMarker {
  /**
   * Construct the marker. Reachable only from {@link trustedCaller}.
   *
   * @param decidedBy - Label for the principal the authority check accepted, as
   *   the Activity trail would name it (an account id, or the local operator).
   */
  constructor(readonly decidedBy: string) {}
}

/**
 * Proof that a call came from a caller allowed to decide approvals, and may
 * therefore act without one.
 *
 * The type is exported so it can appear in an invocation context; its
 * constructor is not, so this value can only originate from
 * {@link trustedCaller}.
 */
export type TrustedCaller = TrustedCallerMarker;

/**
 * Mint a {@link TrustedCaller} for a request, or `undefined` when the caller has
 * not shown it may decide approvals.
 *
 * Pass exactly what the decide endpoint passes — see `routes/approvals.ts` — so
 * the two surfaces cannot drift apart in what they accept.
 *
 * @param request - What the caller presented; see {@link DecisionAuthorityRequest}.
 * @returns The marker when the caller may decide, otherwise `undefined`.
 */
export function trustedCaller(request: DecisionAuthorityRequest): TrustedCaller | undefined {
  const authority = resolveDecisionAuthority(request);
  if (!authority.allowed) return undefined;

  // Under login, only a session cookie proves a person (DOR-474). The posture is
  // read rather than the login flag, because `signed-in-operator` IS "login is on
  // and an identity resolved" — asking the config a second time here would be a
  // second source of truth for the same fact, and the two could disagree.
  if (authority.posture === 'signed-in-operator' && request.user?.credential !== 'cookie') {
    return undefined;
  }

  return new TrustedCallerMarker(authority.decidedBy);
}

/**
 * Whether a value is a genuine {@link TrustedCaller}.
 *
 * An `instanceof` check on purpose: a plain object carrying the same fields, or
 * a JSON round-trip of a real marker, is not one.
 *
 * @param value - The value to test.
 * @returns True only for a marker this module minted.
 */
export function isTrustedCaller(value: unknown): value is TrustedCaller {
  return value instanceof TrustedCallerMarker;
}

/** The proof that a caller is a person, for a person-only capability. Minted only by {@link personCaller}. */
class PersonCallerMarker {
  /** What it proves, for a reader of a logged context. */
  readonly proves = 'person' as const;

  /**
   * Construct the marker. Reachable only from {@link personCaller}.
   *
   * @param from - `rest-proof` when minted on a capability's own REST path for a
   *   caller with no program credential; see `context/person-read.ts`.
   */
  constructor(readonly from?: 'rest-proof') {}
}

/**
 * Proof that a caller is a person, which a person-only capability
 * (`surfaces.http.audience: 'person'`) needs before `registry.invoke` runs it
 * (ADR 261123-170830). Unlike {@link TrustedCaller} it skips no gate: it only
 * opens the person-only door, and the tier and permission gate still run.
 */
export type PersonCaller = PersonCallerMarker;

/** What the person check reads beyond the decide endpoint's facts. */
export interface PersonCallerRequest extends DecisionAuthorityRequest {
  /**
   * Whether the request carried an `Authorization` header. The app proves a
   * person with a session cookie and never sends one, so a bearer token or an
   * API key without `X-DorkOS-Agent` is a program, not a person.
   */
  authorizationPresented: boolean;
}

/**
 * Mint a {@link PersonCaller} when the caller is a person: the same bar as
 * {@link trustedCaller} (no agent header, no approval token, and wherever a
 * person must prove a session, a browser session), and no `Authorization`
 * header at all.
 *
 * @param request - What the caller presented; see {@link PersonCallerRequest}.
 * @param rest - Only from a capability's own REST path, for an `observe` call
 *   from a caller that sent no program credential at all (no API key either):
 *   tags the marker `rest-proof` (`context/person-read.ts`) and records the
 *   sign-in or address its audit rows are grouped by.
 * @returns The marker for a person, otherwise `undefined`.
 */
export function personCaller(
  request: PersonCallerRequest,
  rest?: { readGroup: string }
): PersonCaller | undefined {
  if (request.authorizationPresented || !trustedCaller(request)) return undefined;
  const marker = new PersonCallerMarker(rest ? 'rest-proof' : undefined);
  if (rest) READ_GROUPS.set(marker, rest.readGroup);
  return marker;
}

/**
 * The sign-in or address a REST-path proof was minted for, keyed by the
 * marker and kept off it, so no logged or forwarded context carries it. Read
 * only by the audit observer, to group a person's repeated reads (DOR-4978).
 */
const READ_GROUPS = new WeakMap<PersonCallerMarker, string>();

/**
 * The read group a REST-path person proof was minted with, for the audit
 * observer alone (`capability-attribution.ts`); never a handler's to read.
 *
 * @param value - The call's person proof, if any.
 * @returns The group, or `undefined` for anything but a REST-path proof.
 */
export function personReadGroup(value: unknown): string | undefined {
  return isPersonCaller(value) ? READ_GROUPS.get(value) : undefined;
}

/**
 * Whether a value is a genuine {@link PersonCaller}: an `instanceof` check, so
 * a look-alike object is not one.
 *
 * @param value - The value to test.
 * @returns True only for a marker {@link personCaller} minted.
 */
export function isPersonCaller(value: unknown): value is PersonCaller {
  return value instanceof PersonCallerMarker;
}

/** The caller facts {@link assertCallerProofs} checks. */
export interface SuppliedCallerProofs {
  /** The trusted-caller marker, when the surface minted one. */
  readonly trusted?: unknown;
  /** The person proof, when the surface minted one. */
  readonly person?: unknown;
  /** The agent the call came from, when one identified itself. */
  readonly identity?: { readonly agentPath: string };
}

/**
 * Check the proofs a call carries before `registry.invoke` runs it.
 *
 * - A present `trusted` that is not a genuine marker is refused LOUDLY rather
 *   than quietly downgraded: the only ways to get one are a caller forging the
 *   field or a module minting it wrongly, and truthiness is not enough
 *   (`JSON.parse(JSON.stringify(marker))` is a truthy plain object).
 * - Trusted means "no machine principal presented itself", and an identity IS
 *   one, so the pair is refused rather than a winner picked.
 * - A person-only capability (`surfaces.http.audience: 'person'`) runs only
 *   with a {@link PersonCaller} or a trusted marker, whatever door the call
 *   came through (ADR 261123-170830); anything else is refused `PERSON_ONLY`.
 *
 * @param id - The capability id, for the error.
 * @param capability - The capability, for its audience.
 * @param supplied - The invocation context's proofs.
 * @throws An `Error` for a forged or contradictory proof, a
 *   {@link CapabilityToolError} `PERSON_ONLY` for a caller that is not a person.
 */
export function assertCallerProofs(
  id: string,
  capability: Pick<CapabilityDefinition, 'surfaces'>,
  supplied: SuppliedCallerProofs
): void {
  if (supplied.trusted !== undefined && !isTrustedCaller(supplied.trusted)) {
    throw new Error(
      `Capability registry: "${id}" was invoked with a \`trusted\` value that is not a ` +
        `trusted-caller marker. Only \`trustedCaller\` can mint one; a value that merely ` +
        `looks like it (a JSON round-trip, a hand-built object) is not trust.`
    );
  }
  if (supplied.trusted && supplied.identity) {
    throw new Error(
      `Capability registry: "${id}" was invoked with both a trusted-caller marker and an agent ` +
        `identity (${supplied.identity.agentPath}). A trusted call is one no machine principal ` +
        `made; these cannot both hold.`
    );
  }
  // A capability behind the person bar is checked by the bar's own pass
  // instead (`context/owner-authority.ts`), never by a person proof.
  const http = capability.surfaces.http;
  const personOnly = http?.audience === 'person' && http.callerBar !== 'person';
  if (personOnly && !isPersonCaller(supplied.person) && !supplied.trusted) {
    // The surface may name the tool an agent uses instead: a fixed sentence, never free text.
    const error = capability.surfaces.http?.agentsUse ?? PERSON_ONLY_MESSAGE;
    throw new CapabilityToolError({ error, code: PERSON_ONLY_CODE });
  }
}
