/**
 * What a request needs before it may reach a gated surface, decided per
 * request from where it came from (ADR 261015-125850 rules 1 to 3, F1
 * DOR-2967). This replaces "is login on" as the gate's question: login is no
 * longer one global switch, it is two truths.
 *
 * - **This computer** is trusted by default. The person at it is already
 *   signed in to it. "Ask for a password on this computer too" (stored as
 *   `auth.enabled` until its rename) makes it ask as well.
 * - **Other devices always need a person session or a key**, whatever is
 *   switched on: Wi-Fi, the own tunnel, managed remote, a non-loopback bind, a
 *   proxy on this host.
 * - **A relayed caller** (the session relay) is never admitted by these gates.
 *   The relay serves its own chat-only requests on its own path (B2).
 * - **On a hub** every request is remote, so every one needs a credential.
 *
 * One exception, for one release only (rule 11): a container that binds
 * `0.0.0.0` under `DORKOS_ALLOW_INSECURE_BIND` and has no owner account yet
 * keeps today's open posture, so a Docker install is not locked out before it
 * has anyone to sign in as. F5 (DOR-2968) adds the warning and then the setup
 * code that ends it.
 *
 * Every gate asks {@link gateAccessFor}: the HTTP session gate (`/api`, SSE
 * streams), the stream socket gate, `/mcp` and A2A, and the caller-authority
 * bars that used to read the global flag. One answer, so no two of them can
 * disagree about the same request.
 *
 * @module services/core/auth/gate-policy
 */
import { env } from '../../../env.js';
import {
  classifyRequest,
  type ClassifierFacts,
  type RequestClass,
} from '../../../lib/request-classifier.js';
import { currentServerRole } from '../../../lib/server-role.js';
import { configManager } from '../config-manager.js';
import { hasAnyUser } from './index.js';

/**
 * What a request needs at a gated surface.
 *
 * - `open`: nothing. It is a person at this computer, which does not ask.
 * - `credential`: a session cookie or a per-user key (or, at `/mcp`, the
 *   surface's own keys).
 * - `refused`: nothing this gate accepts admits it.
 */
export type GateAccess = 'open' | 'credential' | 'refused';

/** The settings and facts of this install the decision reads. */
export interface GatePosture {
  /** "Ask for a password on this computer too" (`auth.enabled` today). */
  askOnThisComputer: boolean;
  /** `DORKOS_ALLOW_INSECURE_BIND`: the container owns the network boundary. */
  insecureBind: boolean;
  /** Whether an owner account exists. Read only when the answer turns on it. */
  ownerExists: () => boolean;
}

/**
 * Decide what a request of this class needs. Pure.
 *
 * @param requestClass - The classifier's answer for the request.
 * @param posture - This install's settings.
 * @returns What the request needs.
 */
export function decideGateAccess(requestClass: RequestClass, posture: GatePosture): GateAccess {
  switch (requestClass.kind) {
    case 'hub':
      return 'credential';
    case 'relayed':
      return 'refused';
    case 'this-computer':
      return posture.askOnThisComputer ? 'credential' : 'open';
    case 'other-device':
      return isOwnerlessContainer(requestClass, posture) ? 'open' : 'credential';
  }
}

/**
 * Whether a request is a browser reaching an owner-less container through its
 * published port, the one-release exception (module comment). Only a direct
 * network request qualifies: never a marked listener (Wi-Fi, a tunnel,
 * managed remote) and never the relay.
 */
function isOwnerlessContainer(
  requestClass: Extract<RequestClass, { kind: 'other-device' }>,
  posture: GatePosture
): boolean {
  return requestClass.route === 'network' && posture.insecureBind && !posture.ownerExists();
}

/** Read this install's {@link GatePosture} from live config, env and the user table. */
export function readGatePosture(): GatePosture {
  return {
    askOnThisComputer: configManager.get('auth')?.enabled === true,
    insecureBind: env.DORKOS_ALLOW_INSECURE_BIND === true,
    ownerExists: () => hasAnyUser(),
  };
}

/**
 * What this request needs at a gated surface, from its facts and this
 * install's live settings. Read per request, so changing the setting needs no
 * restart.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 * @param posture - Override for tests; defaults to {@link readGatePosture}.
 */
export function gateAccessFor(
  facts: ClassifierFacts,
  posture: GatePosture = readGatePosture()
): GateAccess {
  return decideGateAccess(classifyRequest(facts, currentServerRole()), posture);
}

/**
 * Whether the gate asked this request for a credential, so a bar reserved for
 * a person can require the browser session that proves one. `false` only for
 * an `open` request, where no credential exists to ask for.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function credentialGated(facts: ClassifierFacts): boolean {
  return gateAccessFor(facts) !== 'open';
}

/**
 * Whether a request is a person at this computer, for the actions reserved for
 * one: signing a runtime in, finishing an MCP sign-in, remote-access settings,
 * the local browser, onboarding. Replaces `isLocalCaller`.
 *
 * True for a `this-computer` request. Also true, under
 * `DORKOS_ALLOW_INSECURE_BIND`, for a direct network request: the container is
 * the computer, its published port is how its owner reaches it, and the gate
 * has already asked that request for a password whenever an owner exists
 * (`docs/self-hosting/docker.mdx`). Never for Wi-Fi, a tunnel, managed remote,
 * the relay or a hub, under any flag.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function isAtThisComputer(facts: ClassifierFacts): boolean {
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind === 'this-computer') return true;
  return (
    requestClass.kind === 'other-device' &&
    requestClass.route === 'network' &&
    env.DORKOS_ALLOW_INSECURE_BIND === true
  );
}
