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
 * One exception, for one release only (rule 11): a browser reaching a container
 * through its published port, under `DORKOS_ALLOW_INSECURE_BIND`, while the
 * container has no owner account yet, keeps today's open posture, so a Docker
 * install is not locked out before it has anyone to sign in as. F5 (DOR-2968)
 * adds the warning and then the setup code that ends it.
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
import { isLoopbackPeer } from '../../../lib/trusted-origins.js';
import { configManager } from '../config-manager.js';
import { AUTH_COOKIES_SECURE } from './cookie-security.js';
import { hasAnyUser } from './index.js';
import type { RequestUser } from './session-gate.js';

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
  return isContainerPortRequest(requestClass, () => posture) && !posture.ownerExists();
}

/**
 * Whether a request reached a container through its published port: under
 * `DORKOS_ALLOW_INSECURE_BIND`, a direct request whose only other-device mark is
 * the bridge gateway it arrived from. A proxy's forwarding headers, a `Host`
 * that names somewhere else (DNS rebinding) and a page on another site all
 * still count as another device, flag or not.
 */
function isContainerPortRequest(requestClass: RequestClass, posture: () => GatePosture): boolean {
  return (
    requestClass.kind === 'other-device' &&
    requestClass.route === 'network' &&
    requestClass.reason === 'peer-not-loopback' &&
    posture().insecureBind
  );
}

/**
 * Whether a request is a browser reaching a container through its published
 * port (see `isContainerPortRequest`), reading the live settings. The sign-up
 * hook asks it: such a container keeps its open first sign-up for one more
 * release (ADR 261015-125850 rule 11).
 *
 * @param requestClass - The classifier's answer for the request.
 */
export function isContainerPortClass(requestClass: RequestClass): boolean {
  return isContainerPortRequest(requestClass, readGatePosture);
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
 * True for a `this-computer` request. Under `DORKOS_ALLOW_INSECURE_BIND` it is
 * also true for a browser reaching the container through its published port
 * (`docs/self-hosting/docker.mdx`): the container is the computer, and that
 * port is how its owner reaches it. Once an owner exists, only with a browser
 * session, since an API key is not a person (ADR 261015-125850 rule 11). Never
 * for Wi-Fi, a tunnel, managed remote, the relay, a hub, a proxy's forwarding
 * headers, a `Host` that names somewhere else or a page on another site.
 *
 * @param facts - The request's TCP peer, raw headers, ingress and, when the
 *   gate proved one, its user.
 * @param posture - Override for tests; defaults to {@link readGatePosture}.
 */
export function isAtThisComputer(
  facts: ClassifierFacts & { readonly user?: RequestUser },
  posture?: GatePosture
): boolean {
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind === 'this-computer') return true;
  // Read the settings only for a request that could be a container's port.
  const live = () => (posture ??= readGatePosture());
  if (!isContainerPortRequest(requestClass, live)) return false;
  return facts.user?.credential === 'cookie' || !live().ownerExists();
}

/**
 * Whether a request from another device came over an encrypted connection, so
 * a signed-in person on it gets exactly what they get at this computer
 * (DOR-3172). Where someone connects from never changes what they may do; how
 * well DorkOS knows it is them does, and plain `http` is the one way in where
 * anyone on the same network can copy the sign-in.
 *
 * - **The own tunnel and managed remote access**: always `https` at their
 *   edge, then forwarded over loopback.
 * - **A proxy on this host** (forwarding headers from a loopback peer, such as
 *   `tailscale serve`): in a built DorkOS the sign-in cookie is `Secure`, so a
 *   browser only ever sends it over `https`. In a development build, where it
 *   is not, only when the proxy says `X-Forwarded-Proto: https`.
 * - **Never a bare network bind** (`DORKOS_HOST`), which is plain `http`.
 * - **Never Wi-Fi**: that listener is plain `http`, and its cookie drops
 *   `Secure` to work there (`lan-access/lan-cookies.ts`).
 * - **Never the relay or a hub**: each has its own bar.
 *
 * This answers only "is the connection private". Who is asking is the bar's
 * own question, and every caller of this pairs it with one.
 *
 * @param facts - The request's TCP peer, raw headers and ingress.
 */
export function isOnEncryptedConnection(facts: ClassifierFacts): boolean {
  const requestClass = classifyRequest(facts, currentServerRole());
  if (requestClass.kind !== 'other-device') return false;
  if (requestClass.route === 'own-tunnel' || requestClass.route === 'managed') return true;
  // A proxy on this host: forwarding headers from a loopback peer. Never a
  // bare network bind, which is plain `http`, nor a page on another site.
  if (requestClass.route !== 'network' || requestClass.reason !== 'forwarded') return false;
  if (!isLoopbackPeer(facts.peerAddress)) return false;
  return AUTH_COOKIES_SECURE || proxySaysHttps(facts);
}

/**
 * Whether the proxy named `https` as the scheme the browser used. Reads the
 * last value: the one the proxy next to DorkOS added. Earlier values are
 * whatever the browser or a hop before it sent.
 */
function proxySaysHttps(facts: ClassifierFacts): boolean {
  const raw = facts.headers['x-forwarded-proto'];
  const joined = Array.isArray(raw) ? raw.join(',') : raw;
  const last = joined?.split(',').at(-1)?.trim().toLowerCase();
  return last === 'https';
}
