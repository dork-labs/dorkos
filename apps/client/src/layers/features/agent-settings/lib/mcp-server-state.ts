import type { ManagedMcpServerView, McpServerTransport } from '@dorkos/shared/mesh-schemas';
import type { AgentMcpTestResult, McpServerEntry } from '@dorkos/shared/transport';

/**
 * Every state a server card can be in, in the words a person reads.
 *
 * Wider than the wire's own status union on purpose. Three of these are things
 * DorkOS knows that no runtime reports — `signed-in` (a token is held but nothing
 * has contacted the server), `uses-your-key` (the operator pasted in their own
 * `Authorization` header), and `signing-in` (a sign-in is on screen right now) —
 * and one is the honest name for the absence the old surface called "Unknown":
 * `not-checked`. The wire's single `failed` splits in two, because "the server
 * didn't answer" and "this server's setup is wrong" are different problems with
 * different next steps.
 */
export type McpCardStatus =
  | 'needs-sign-in'
  | 'signing-in'
  | 'connected'
  | 'signed-in'
  | 'uses-your-key'
  | 'cant-reach'
  | 'setup-problem'
  | 'connecting'
  | 'not-checked'
  | 'off';

/**
 * How a runtime's own status maps onto a card state, for the statuses that need
 * no interpretation. `failed` is absent because it needs {@link classifyFailure}
 * and `disabled` because a card's own `enabled` flag decides that first.
 */
const RUNTIME_STATUS_TO_CARD: Record<
  Exclude<NonNullable<McpServerEntry['status']>, 'failed'>,
  McpCardStatus
> = {
  connected: 'connected',
  'needs-auth': 'needs-sign-in',
  pending: 'connecting',
  disabled: 'off',
};

/**
 * Words a runtime uses when the problem is the server's CONFIGURATION rather
 * than its reachability. Matched case-insensitively against the error string.
 */
const SETUP_PROBLEM_MARKERS = ['validation', 'invalid', 'missing required', 'not found: command'];

/**
 * Which of the two failure states an error string describes.
 *
 * A runtime reports one `failed`, but a person facing it has two different
 * problems: a server that is configured fine and did not answer ("it may be
 * down" — wait, retry) versus a server that could never have answered because
 * its entry is malformed ("fix the setup"). Telling someone to retry a
 * misspelled command wastes their time.
 *
 * **Reachability is the fall-through**, deliberately: an error we cannot read is
 * far more likely to be a network or process failure than a config one, and
 * "this server didn't answer" is the safer thing to be wrong about — it sends a
 * person to Try again rather than to hunt for a config mistake that isn't there.
 *
 * @param error - The runtime's error string, if it gave one.
 */
export function classifyFailure(error: string | undefined): 'cant-reach' | 'setup-problem' {
  if (!error) return 'cant-reach';
  const haystack = error.toLowerCase();
  return SETUP_PROBLEM_MARKERS.some((marker) => haystack.includes(marker))
    ? 'setup-problem'
    : 'cant-reach';
}

/**
 * Whether the operator authenticated this server themselves, with a header they
 * pasted in at `add`.
 *
 * DorkOS holds nothing for such a server and must not offer to sign in to it;
 * the card says "Uses your key" instead, which is both true and a reminder of
 * where the credential came from when it stops working.
 *
 * @param connection - The managed server's connection.
 */
export function usesOwnKey(connection: McpServerTransport): boolean {
  if (connection.transport === 'stdio') return false;
  if (connection.authKind === 'oauth2') return false;
  return Object.keys(connection.headers).some((header) => header.toLowerCase() === 'authorization');
}

/**
 * Whether this server is one DorkOS holds — or is expected to hold — a sign-in
 * for, which is what makes "Sign in again" and "Sign out" meaningful in the
 * overflow menu. A local command and a server carrying the operator's own header
 * are both outside it.
 *
 * @param args.connection - The managed server's connection.
 * @param args.authStatus - The listing's derived sign-in state, if any.
 */
export function holdsSignIn(args: {
  connection: McpServerTransport;
  authStatus: ManagedMcpServerView['authStatus'];
}): boolean {
  const { connection, authStatus } = args;
  if (connection.transport !== 'stdio' && connection.authKind === 'oauth2') return true;
  return authStatus !== undefined;
}

/**
 * The status a card shows, in precedence order.
 *
 * Two sources disagree here, and the rule is symmetric — whichever knows a
 * SIGN-IN fact more recently wins, because the runtime's status is a snapshot
 * from the last turn while the sign-in state is read live:
 *
 * 1. A turned-off server is `off`, whatever anything else says.
 * 2. A Test that came back OK is `connected`. Test is the only thing on this card
 *    that actually dialled the server, and since DOR-985 it dials WITH the
 *    bearer — so an `ok` is a round trip that provably worked, which beats every
 *    cached opinion below it. (Its `needsAuth` counterpart already decides the
 *    Sign in button; this is the same evidence pointed at the chip.)
 * 3. A sign-in that just completed is `signed-in` immediately — the person
 *    watched it happen and must not see the card claim otherwise.
 * 4. A runtime failure wins over both overrides below: that is a reachability or
 *    setup problem, and holding (or lacking) a token says nothing about it.
 * 5. A live token beats a runtime `needs-auth` — the token postdates the turn.
 * 6. NO token beats a runtime `connected` OR a runtime `pending` — this is the
 *    STRONGER half: with no token to inject, the next turn provably carries no
 *    bearer, so a green chip would be a lie. Without it, a token that expired
 *    after one successful turn left the card green with no Sign in button, which
 *    is DOR-985 all over again. `pending` is the same lie told more quietly: a
 *    cached "connecting…" from a past turn outranking the live, provable fact
 *    that there is no token leaves the card spinning with nothing to press.
 * 7. Otherwise the runtime's live status, then the derived sign-in state, then
 *    the operator's own key, and finally `not-checked` — which is the honest name
 *    for what the runtime cache can say before the first turn of a process. The
 *    old surface called this "Unknown" and, when a stale `pending` outranked it,
 *    "Connecting…" forever.
 *
 * @param args.enabled - Whether the managed server is switched on.
 * @param args.testedOk - Whether the most recent Test probe reached the server.
 * @param args.signedInNow - Whether this card's sign-in flow just reached `connected`.
 * @param args.runtimeStatus - The status the runtime reported, if any.
 * @param args.runtimeError - The runtime's error string, when it failed.
 * @param args.authStatus - The listing's derived sign-in state, if any.
 * @param args.ownKey - Whether the operator supplied their own `Authorization` header.
 */
export function resolveStatusKey(args: {
  enabled: boolean;
  testedOk: boolean;
  signedInNow: boolean;
  runtimeStatus: McpServerEntry['status'];
  runtimeError: string | undefined;
  authStatus: ManagedMcpServerView['authStatus'];
  ownKey: boolean;
}): McpCardStatus {
  const { enabled, testedOk, signedInNow, runtimeStatus, runtimeError, authStatus, ownKey } = args;
  if (!enabled) return 'off';
  if (testedOk) return 'connected';
  if (signedInNow) return 'signed-in';
  if (runtimeStatus === 'failed') return classifyFailure(runtimeError);
  if (authStatus === 'connected' && runtimeStatus === 'needs-auth') return 'signed-in';
  if (authStatus === 'needs-auth' && (runtimeStatus === 'connected' || runtimeStatus === 'pending'))
    return 'needs-sign-in';
  if (runtimeStatus) return RUNTIME_STATUS_TO_CARD[runtimeStatus];
  if (authStatus === 'connected') return 'signed-in';
  if (authStatus === 'needs-auth') return 'needs-sign-in';
  if (ownKey) return 'uses-your-key';
  return 'not-checked';
}

/**
 * Whether the card offers Sign in.
 *
 * The probe's own verdict counts, and it counts even against a green chip: Test
 * is the only thing here that actually contacted the server, so if it came back
 * 401 the person needs the button no matter what the runtime cached. Telling
 * them "Needs sign-in" beside no such button was the whole of DOR-985.
 *
 * The two things that do silence it: a turned-off server, and a sign-in that
 * just completed in this very card (whose fresh token postdates any probe).
 *
 * @param args.statusKey - The status the chip is showing.
 * @param args.testResult - The most recent probe result for this server, if any.
 * @param args.signedInNow - Whether this card's sign-in flow just reached `connected`.
 */
export function offersSignIn(args: {
  statusKey: McpCardStatus;
  testResult: AgentMcpTestResult | undefined;
  signedInNow: boolean;
}): boolean {
  const { statusKey, testResult, signedInNow } = args;
  if (statusKey === 'off' || signedInNow) return false;
  if (testResult?.needsAuth === true) return true;
  return statusKey === 'needs-sign-in';
}

/** A probe result plus when it landed, so newer evidence can outrank it. */
export interface StampedTestResult {
  /** What the probe found. */
  result: AgentMcpTestResult;
  /** Client epoch ms the probe answered. */
  at: number;
}

/**
 * The probe result a card should still show, or `undefined` once something newer
 * has contradicted it.
 *
 * A Test is the strongest evidence this card has — the only thing here that
 * actually dialled the server, with the bearer — and it rightly beats every
 * cached opinion at the moment it lands. But it is evidence about THAT MOMENT,
 * and the rule has to cut both ways or it tells a stale story in whichever
 * direction it is one-sided:
 *
 * - A probe said OK, then the token was lost while the panel sat open. Keeping
 *   it left a green chip on a server whose next turn provably carries no bearer,
 *   and no Sign in button — the exact lie DOR-985 existed to kill.
 * - A probe said "needs sign-in", then the person SIGNED IN. Keeping it left
 *   "Needs sign-in" sitting under a card that had just gone green, with no such
 *   button anywhere. A user hit precisely this: Test, sign in, and the
 *   instruction stayed put.
 *
 * So a probe is superseded by any newer answer that disagrees with it, from
 * either of the two sources that can know better:
 *
 * 1. This card's OWN sign-in flow reaching `connected`. Immediate, and it has to
 *    be — the person just watched it happen, and the listing has not necessarily
 *    re-read yet.
 * 2. A listing that landed AFTER the probe and disagrees with it: `needs-auth`
 *    against an OK probe, `connected` against a needs-sign-in one. This is the
 *    durable half, and it is what keeps the line gone after the sign-in panel is
 *    dismissed and `signedInNow` drops back to false.
 *
 * A third case needs no rule: a newer Test simply replaces the stored result.
 *
 * The comparison is `<=`, so on a SAME-MILLISECOND tie the listing wins. At equal
 * stamps "which is newer" is genuinely unknowable, so the tie is broken by which
 * way it is safe to be wrong: believing an overtaken OK probe puts a green chip
 * on a server with no bearer and hides the Sign in button, which is the DOR-985
 * lie in a 1ms window, while believing the listing costs at most one needless
 * press of Test. It is also what makes the rule deterministic — a strict `<` left
 * the staleness behaviour depending on whether two events landed in the same
 * millisecond, which flaked in a real full-monorepo run.
 *
 * Nothing else rests on the tie: "a fresh Test beats the listing at the moment it
 * lands" concerns a probe stamped strictly LATER, and the case where a stale
 * `needsAuth` probe must lose immediately is a sign-in this card just watched
 * land, which rule 1 answers with no clock at all.
 *
 * A `failed` probe is left alone by both. "Couldn't reach this server" is a
 * reachability fact, and signing in does not disprove it — the same reason
 * {@link resolveStatusKey} lets a runtime failure outrank every token fact.
 *
 * @param args.stamped - The stored probe result for this server, if any.
 * @param args.signedInNow - Whether this card's sign-in flow just reached `connected`.
 * @param args.authStatus - The listing's derived sign-in state for the same server.
 * @param args.rosterUpdatedAt - Client epoch ms the listing last landed.
 */
export function liveTestResult(args: {
  stamped: StampedTestResult | undefined;
  signedInNow: boolean;
  authStatus: ManagedMcpServerView['authStatus'];
  rosterUpdatedAt: number;
}): AgentMcpTestResult | undefined {
  const { stamped, signedInNow, authStatus, rosterUpdatedAt } = args;
  if (!stamped) return undefined;
  const { result } = stamped;
  if (signedInNow && result.needsAuth === true) return undefined;
  if (stamped.at <= rosterUpdatedAt) {
    if (authStatus === 'needs-auth' && result.ok) return undefined;
    if (authStatus === 'connected' && result.needsAuth === true) return undefined;
  }
  return result;
}

/**
 * The state the card's SENTENCE and primary action speak from, which is not
 * always the state its chip shows.
 *
 * The chip answers "what does DorkOS believe about this server", and
 * {@link resolveStatusKey} weighs the caches carefully to get it right. The
 * sentence answers "what should you do next", and there one source outranks the
 * rest: a probe that actually dialled the server. A 401 from a live probe means
 * sign in — even while the runtime's cache from the last turn still says
 * `connected`, which is exactly the DOR-985 case where the card offers Sign in.
 * Telling someone "12 tools available" beside the Sign in button they need to
 * press would restore that contradiction from the other side.
 *
 * `off` is untouched: a turned-off server has nothing to do, whatever a probe
 * from before it was turned off once found.
 *
 * @param args.status - The state the chip is showing.
 * @param args.probe - The probe result that still stands, per {@link liveTestResult}.
 */
export function probeAdjustedStatus(args: {
  status: McpCardStatus;
  probe: AgentMcpTestResult | undefined;
}): McpCardStatus {
  const { status, probe } = args;
  if (status === 'off' || !probe || probe.ok) return status;
  if (probe.needsAuth === true) return 'needs-sign-in';
  return classifyFailure(probe.error);
}

/**
 * The four bands the cards are sorted into when the panel opens: what needs you,
 * what is working, what came from somewhere else, and what is off.
 *
 * Used exactly once per mount — see the freeze in `AgentMcpServers` — so a card
 * changing state never changes where it sits.
 */
export const MCP_ORDER_BANDS = {
  attention: 0,
  working: 1,
  elsewhere: 2,
  off: 3,
} as const;

/** Which band a managed card's status puts it in. */
export function orderBandFor(status: McpCardStatus): number {
  if (status === 'off') return MCP_ORDER_BANDS.off;
  if (status === 'needs-sign-in' || status === 'cant-reach' || status === 'setup-problem') {
    return MCP_ORDER_BANDS.attention;
  }
  return MCP_ORDER_BANDS.working;
}
