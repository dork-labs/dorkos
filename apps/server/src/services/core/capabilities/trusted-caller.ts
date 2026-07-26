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
  return authority.allowed ? new TrustedCallerMarker(authority.decidedBy) : undefined;
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
