/**
 * The one way a Cloud command may act on this computer's managed remote access
 * (DOR-2086), and a sibling of `trusted-caller.ts` in every way that matters.
 *
 * Cloud can ask this computer to open, close, rotate or revoke its managed
 * tunnel, over the instance's own command stream. Those four effects need a
 * proof that the ask really is a current, leased command from the Cloud link a
 * person made, for an enrolment a person approved and has not withdrawn. This
 * module is that proof, and it is deliberately the smallest one that can exist.
 *
 * ## The property that matters: no value that arrived as JSON can be one
 *
 * {@link CloudAuthority} is an instance of a class this module does not export,
 * and {@link isCloudAuthority} is an `instanceof` check. So a command body, an
 * HTTP request, a header, an MCP argument — anything that arrives over the wire
 * and through `JSON.parse` — cannot be one, and neither can
 * `JSON.parse(JSON.stringify(real))` or `structuredClone(real)`. All are pinned
 * by tests.
 *
 * As with `TrustedCaller`, that claim is narrower than "unforgeable".
 * In-process code holding a real marker can make another through its prototype,
 * and in-process code that can fabricate a command and a context can call
 * {@link mintCloudAuthority} directly. Not exporting the class buys **scan
 * integrity**, not attacker cost: `__tests__/gate-bypass-scan.test.ts` watches
 * `mintCloudAuthority(` and pins its one caller, the command dispatcher.
 * Export the class and a module could write `new …Marker(…)` the scan never
 * sees. Read `trusted-caller.ts`'s module doc for the full reasoning; it
 * applies here unchanged.
 *
 * ## What a mint checks, and why each one
 *
 * 1. **The command parses** against the published `RemoteCommandSchema`, and
 *    nothing looser. A command this build cannot read authorizes nothing.
 * 2. **The verb is exactly `open | close | rotate | revoke`.** The other
 *    published kinds carry no authority: `inbox_pending` only signals the
 *    seat path, and `keepalive` is a heartbeat. A verb Cloud adds later is
 *    refused here until this list is changed on purpose, which a test forces.
 *    There is no `enrol`, no mode selection and no ingress configuration:
 *    those are a person's, on this computer, behind their own guards.
 * 3. **A lease token is present**, because a command without one cannot be
 *    acknowledged and so cannot be settled exactly once.
 * 4. **The link it arrived on is still current** (`ctx.isCurrent()` from
 *    `captureCloudV1Context`). A command read under a link that was since
 *    unlinked, relinked or re-pointed acts on nothing, even with the same key.
 * 5. **A person's enrolment is active here, and it was made under this
 *    link.** The record stores the Cloud instance id the enrolment was made
 *    under, and the context carries the instance id its link resolved; the two
 *    must match. Unlinking clears the enrolment in the same write, so a
 *    leftover consent can never be picked up by a different account's link or
 *    by a relink, and withdrawal clears it locally first, so a command that
 *    races a withdrawal is refused.
 *
 * The marker re-checks 4 and 5 through {@link CloudAuthority.isStillValid}, and
 * a protected effect calls it again immediately before acting: a mint is a
 * snapshot, and the link or the consent can end between the mint and the act.
 * For `open` it also asks that managed mode is still the person's selection,
 * because a person who switched to their own tunnel meanwhile did not ask for
 * the managed one to open.
 *
 * ## What it can never do
 *
 * It cannot enrol a person, select a mode, configure the edge proof, or waive
 * `canExpose()`. Every effect it reaches still runs the local exposure rules;
 * this proves who asked, not that the answer is yes.
 *
 * @module services/core/capabilities/cloud-authority
 */
import { RemoteCommandSchema, type RemoteCommand } from '@dork-labs/cloud-api';

import type { CloudV1Context } from '../cloud/v1-client.js';
import { isRemoteEnrolmentActive, readRemoteState } from '../remote/remote-state.js';

/** The four command kinds that carry authority. Nothing else ever does. */
export const CLOUD_AUTHORITY_VERBS = ['open', 'close', 'rotate', 'revoke'] as const;

/** One of {@link CLOUD_AUTHORITY_VERBS}, constrained to the published command kinds. */
export type CloudAuthorityVerb = Extract<
  RemoteCommand['kind'],
  (typeof CLOUD_AUTHORITY_VERBS)[number]
>;

/** A published command whose kind carries authority. */
export type AuthorizingCommand = Extract<RemoteCommand, { kind: CloudAuthorityVerb }>;

/**
 * The link a command arrived on: the captured v1 context, plus the Cloud
 * instance id that context resolved (`resolveCloudInstanceId`) when the
 * command stream was opened under it.
 */
export interface CloudCommandContext extends Pick<CloudV1Context, 'isCurrent'> {
  /** The service-issued instance id of this link. */
  readonly instanceId: string;
}

/**
 * Why a mint was refused. Each is a handle-grammar slug, so the dispatcher can
 * acknowledge the command as `refused:<reason>`.
 */
export type CloudAuthorityRefusal =
  /** The command does not parse against the published schema. */
  | 'malformed-command'
  /** A published kind that carries no authority (`inbox_pending`, `keepalive`). */
  | 'not-authorizing'
  /** No lease token to settle it with. */
  | 'no-lease'
  /** The Cloud link it arrived on is no longer the current one. */
  | 'stale-link'
  /** No person's enrolment is active on this computer. */
  | 'not-enrolled'
  /** An enrolment is active, but it was made under a different link. */
  | 'other-link';

/** What {@link mintCloudAuthority} returns. */
export type CloudAuthorityMint =
  { ok: true; authority: CloudAuthority } | { ok: false; reason: CloudAuthorityRefusal };

const AUTHORIZING = new Set<string>(CLOUD_AUTHORITY_VERBS);

/**
 * The marker itself. **Do not export this class.** Not exporting it is what
 * keeps the scan's single watched token (`mintCloudAuthority(`) exhaustive,
 * and what keeps a marker from arriving as JSON. See the module doc.
 */
class CloudAuthorityMarker {
  // Private, so `util.inspect`, a debugger dump or a stray `console.log` of the
  // marker never prints the command's lease token.
  readonly #command: Readonly<AuthorizingCommand>;
  readonly #enrolmentId: string;
  readonly #ctx: CloudCommandContext;

  /**
   * Construct the marker. Reachable only from {@link mintCloudAuthority}.
   *
   * @param command - The validated command.
   * @param enrolmentId - The active enrolment at mint time.
   * @param ctx - The link context the command arrived on.
   */
  constructor(command: AuthorizingCommand, enrolmentId: string, ctx: CloudCommandContext) {
    this.#command = Object.freeze({ ...command });
    this.#enrolmentId = enrolmentId;
    this.#ctx = ctx;
    Object.freeze(this);
  }

  /** The validated command, frozen. Holds its lease token: never log or return it. */
  get command(): Readonly<AuthorizingCommand> {
    return this.#command;
  }

  /** The enrolment the command was minted under. */
  get enrolmentId(): string {
    return this.#enrolmentId;
  }

  /** The command kind this authority covers. */
  get verb(): CloudAuthorityVerb {
    return this.#command.kind;
  }

  /**
   * Whether the link is still current, the same enrolment is still active
   * under that same link, and — for `open` — managed mode is still selected.
   * A protected effect calls this immediately before acting.
   */
  isStillValid(): boolean {
    if (!this.#ctx.isCurrent()) return false;
    const state = readRemoteState();
    if (!isRemoteEnrolmentActive(state)) return false;
    if (state.enrolmentId !== this.#enrolmentId) return false;
    if (state.instanceId !== this.#ctx.instanceId) return false;
    return this.verb !== 'open' || state.mode === 'managed';
  }

  /** Never serializes its command: the lease token stays in process. */
  toJSON(): { verb: CloudAuthorityVerb; commandId: string } {
    return { verb: this.verb, commandId: this.#command.id };
  }
}

/**
 * Proof that one current, leased Cloud command may act on managed remote access.
 *
 * The type is exported so it can appear in a signature; its constructor is not,
 * so a value can only originate from {@link mintCloudAuthority}.
 */
export type CloudAuthority = CloudAuthorityMarker;

/**
 * Mint a {@link CloudAuthority} for one command from the command stream, or say
 * why not. See the module doc for each check.
 *
 * @param command - The command as read from the stream; parsed here strictly.
 * @param ctx - The link the stream was opened under: the captured context and
 *   the instance id it resolved; `null` when there was none.
 * @returns The marker, or the refusal reason.
 */
export function mintCloudAuthority(
  command: unknown,
  ctx: CloudCommandContext | null
): CloudAuthorityMint {
  const parsed = RemoteCommandSchema.safeParse(command);
  if (!parsed.success) return { ok: false, reason: 'malformed-command' };
  const candidate = parsed.data;
  if (!AUTHORIZING.has(candidate.kind)) return { ok: false, reason: 'not-authorizing' };
  const authorizing = candidate as AuthorizingCommand;
  if (typeof authorizing.leaseToken !== 'string' || authorizing.leaseToken.trim() === '') {
    return { ok: false, reason: 'no-lease' };
  }
  if (ctx === null || !ctx.isCurrent()) return { ok: false, reason: 'stale-link' };
  const state = readRemoteState();
  if (!isRemoteEnrolmentActive(state) || state.enrolmentId === null) {
    return { ok: false, reason: 'not-enrolled' };
  }
  if (typeof ctx.instanceId !== 'string' || state.instanceId !== ctx.instanceId) {
    return { ok: false, reason: 'other-link' };
  }
  return { ok: true, authority: new CloudAuthorityMarker(authorizing, state.enrolmentId, ctx) };
}

/**
 * Whether a value is a genuine {@link CloudAuthority}, optionally for one verb.
 *
 * An `instanceof` check on purpose: a plain object with the same fields, a JSON
 * round-trip or a structured clone of a real marker is not one.
 *
 * @param value - The value to test.
 * @param verb - When given, the marker must cover exactly this verb.
 * @returns True only for a marker this module minted.
 */
export function isCloudAuthority(
  value: unknown,
  verb?: CloudAuthorityVerb
): value is CloudAuthority {
  if (!(value instanceof CloudAuthorityMarker)) return false;
  return verb === undefined || value.verb === verb;
}
