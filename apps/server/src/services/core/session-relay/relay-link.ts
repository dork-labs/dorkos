/**
 * Linking this computer to its owner's hub with a link code (spec
 * `everything-is-a-space` step B3, DOR-2946): the computer's half of the
 * handshake `routes/hub-link.ts` answers.
 *
 * 1. Read the pasted `<code>@<host>`: the host becomes the only address this
 *    computer will send the request to, and only over https. A host that is
 *    this computer, an IP literal, a `.local`/`.internal`/`.localhost` name,
 *    or a name that resolves to a loopback, private or link-local address is
 *    refused: a hub is on the internet.
 * 2. Name this computer: its DorkOS Cloud instance id when it is linked to a
 *    DorkOS account (the relay's wake commands carry that id), otherwise a
 *    random `mac-…` id kept in the relay's folder, so linking again keeps it.
 * 3. Mint the relay secret here. Only its SHA-256 crosses the network.
 * 4. Send the request signed with this computer's own key, refusing any
 *    redirect, with a timeout and a cap on the answer's size.
 * 5. Check the hub's answer is signed by the key it hands over, over exactly
 *    this request (origin, code hash, computer id, key and secret hash). With
 *    TLS to the origin in the code, that is how this computer knows the key is
 *    the hub's, never DorkOS Cloud's.
 * 6. On a computer linked to a DorkOS account, refuse a hub whose answer does
 *    not name that same account (id and issuer) as its owner. This catches
 *    linking to the wrong hub by mistake; it is not proof of whose hub it is,
 *    since the answer is signed only by the key it hands over. The guard
 *    against linking by someone other than the owner is the owner's password,
 *    asked by the route. A computer with no account cannot check this at all.
 * 7. Pin it. Nothing is written before every check passes.
 *
 * @module services/core/session-relay/relay-link
 */
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { claimSecretText } from '@dorkos/shared/secret-file';
import {
  RELAY_LINK_CODE_ALPHABET,
  RELAY_LINK_PATH,
  RelayLinkComputerIdSchema,
  RelayLinkComputerNameSchema,
  RelayLinkResponseSchema,
  parseRelayLinkCode,
  type RelayLinkResponse,
  type SessionRelayLinkRefusal,
} from '@dorkos/shared/session-relay-link';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { logger } from '../../../lib/logger.js';
import { relaySecretHash } from '../hub-relay/computer-store.js';
import { captureCloudV1Context, resolveCloudIdentity } from '../cloud/v1-client.js';
import { signRelayLinkRequest, verifyRelayLinkResponse } from './link-signature.js';
import { computerSigningKey, readRelayPin, writeRelayPin, type RelayPin } from './pin-store.js';

/** How long the hub has to answer. */
export const RELAY_LINK_TIMEOUT_MS = 15_000;

/** The largest answer read from a hub; a real one is a few hundred bytes. */
export const RELAY_LINK_MAX_RESPONSE_BYTES = 16 * 1024;

/** The file the computer's own id is kept in, when it has no Cloud instance id. */
const COMPUTER_ID_FILE = 'computer-id';

/** Whether this computer is linked to a DorkOS account, and who it is there. */
export type CloudLinkIdentity =
  | { linked: false }
  | {
      linked: true;
      instanceId: string | null;
      accountKey: string | null;
      /**
       * The issuer of this computer's DorkOS account, or `null` while it is
       * not known. No Cloud contract tells a computer its account's issuer yet
       * (the hub learns its own from its assignment), so the live value is
       * `null` until one does; see {@link accountMatches}.
       */
      issuer: string | null;
    };

/** What {@link linkToHub} reads and calls, injectable for tests. */
export interface LinkToHubDeps {
  /** The data folder; the live one by default. */
  dorkHome?: string;
  /** The `fetch` to send the request with. */
  fetch?: typeof fetch;
  /** This computer's DorkOS account link. */
  cloudIdentity?: () => Promise<CloudLinkIdentity>;
  /** The clock, for `pinnedAt`. */
  now?: () => Date;
  /** Override {@link RELAY_LINK_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Resolve a host to every address it has. */
  lookup?: (host: string) => Promise<Array<{ address: string }>>;
}

/** What linking came to. */
export type LinkToHubResult =
  { ok: true; pin: RelayPin } | { ok: false; reason: SessionRelayLinkRefusal };

/** The live answer: this computer's Cloud instance and account, if linked. */
async function liveCloudIdentity(): Promise<CloudLinkIdentity> {
  const context = captureCloudV1Context();
  if (context === null) return { linked: false };
  try {
    // No contract carries the account's issuer to a computer yet.
    return { linked: true, ...(await resolveCloudIdentity(context)), issuer: null };
  } catch {
    return { linked: true, instanceId: null, accountKey: null, issuer: null };
  }
}

/**
 * This computer's name as its owner would recognise it: the host name, before
 * the first dot, cut to fit a link request. `Computer` when there is none.
 */
export function defaultComputerName(): string {
  const host = (os.hostname().split('.')[0] ?? '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim();
  const name = host.slice(0, 64).trim();
  return RelayLinkComputerNameSchema.safeParse(name).success ? name : 'Computer';
}

/** A random, stable id for a computer with no Cloud instance id: `mac-` and 16 base32 characters. */
function localComputerId(dorkHome: string): string {
  const bytes = randomBytes(16);
  const alphabet = RELAY_LINK_CODE_ALPHABET.toLowerCase();
  const minted = `mac-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
  return claimSecretText(path.join(dorkHome, 'session-relay', COMPUTER_ID_FILE), minted, 0o600)
    .value;
}

/** The hub's answer, as text, up to the cap; `null` past it or on any read failure. */
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RELAY_LINK_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Host names that never name a hub on the internet. */
const LOCAL_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];

/** Whether a host, as a link code carries it (no port), is plainly not on the internet. */
export function isLocalHostName(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (name === 'localhost' || isIP(name) !== 0) return true;
  return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Whether an address is one a hub on the internet never has: unspecified,
 * loopback, private, shared (CGNAT), link-local or unique-local, in IPv4 or
 * IPv6 (an IPv4-mapped IPv6 address is read as its IPv4).
 */
export function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const v4 = mapped ? mapped[1]! : address;
  if (isIP(v4) === 4) {
    const [a = 0, b = 0] = v4.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = address.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Every address a host resolves to, through the system resolver. */
async function lookupAll(host: string): Promise<Array<{ address: string }>> {
  return dnsLookup(host, { all: true });
}

/**
 * Whether a hub's host is on the internet: not a local name, and every
 * address it resolves to public. A name that does not resolve is unreachable.
 */
async function checkPublicHost(
  origin: string,
  lookup: (host: string) => Promise<Array<{ address: string }>>
): Promise<'ok' | 'not-public' | 'hub-unreachable'> {
  const host = new URL(origin).hostname;
  if (isLocalHostName(host)) return 'not-public';
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    return 'hub-unreachable';
  }
  if (addresses.length === 0) return 'hub-unreachable';
  return addresses.some(({ address }) => isNonPublicAddress(address)) ? 'not-public' : 'ok';
}

/** Strip trailing slashes, as an issuer is compared everywhere else (`hub-sign-in.ts`). */
const bareIssuer = (issuer: string): string => issuer.replace(/\/+$/u, '');

/**
 * Whether a hub's answer names this computer's own DorkOS account as its
 * owner: the same account id, and an issuer. The issuer must equal this
 * computer's when it knows its own; while no contract tells it (`issuer:
 * null`), the hub must still name one, since an account id means nothing
 * without the issuer it belongs to. A safeguard against the wrong hub, not
 * proof of ownership.
 */
export function accountMatches(
  identity: Extract<CloudLinkIdentity, { linked: true }>,
  answer: Pick<RelayLinkResponse, 'ownerAccountId' | 'issuer'>
): boolean {
  if (!answer.ownerAccountId || answer.ownerAccountId !== identity.accountKey) return false;
  if (!answer.issuer) return false;
  return identity.issuer === null || bareIssuer(answer.issuer) === bareIssuer(identity.issuer);
}

/** Map a hub's refusal status to the reason the owner reads. */
function refusalFor(status: number): SessionRelayLinkRefusal {
  if (status === 409) return 'already-linked';
  if (status >= 300 && status < 400) return 'hub-unreachable';
  if (status === 404 || status >= 500) return 'hub-unreachable';
  return 'hub-refused';
}

/**
 * Link this computer to the hub a link code names, and pin it. The caller
 * has already checked the person at this computer; this checks the hub.
 * Never throws.
 *
 * @param input - The pasted code and the name to link with.
 * @param deps - Seams for tests; the live ones by default.
 */
export async function linkToHub(
  input: { linkCode: string; computerName: string },
  deps: LinkToHubDeps = {}
): Promise<LinkToHubResult> {
  const dorkHome = deps.dorkHome ?? resolveDorkHome();
  const parsed = parseRelayLinkCode(input.linkCode);
  // `parseRelayLinkCode` only builds https origins; checked again here because
  // the relay secret's hash and this computer's key go nowhere else.
  if (!parsed || new URL(parsed.origin).protocol !== 'https:') return refused('bad-code');
  if (!RelayLinkComputerNameSchema.safeParse(input.computerName).success) {
    return refused('bad-code');
  }
  if (readRelayPin(dorkHome)) return refused('already-linked');
  // Checked again by the resolver the fetch uses a moment later; a name that
  // changes its answer in between (DNS rebinding) is not covered here.
  const reach = await checkPublicHost(parsed.origin, deps.lookup ?? lookupAll);
  if (reach !== 'ok') return refused(reach);

  const identity = await (deps.cloudIdentity ?? liveCloudIdentity)();
  let computerId: string;
  if (identity.linked) {
    // A linked computer is known to the relay's wake by its instance id, and
    // must be able to tell its own account from another's.
    if (!identity.instanceId || !identity.accountKey) return refused('account-unreadable');
    if (!RelayLinkComputerIdSchema.safeParse(identity.instanceId).success) {
      return refused('account-unreadable');
    }
    computerId = identity.instanceId;
  } else {
    computerId = localComputerId(dorkHome);
  }

  const relaySecret = randomBytes(32).toString('base64url');
  const request = signRelayLinkRequest(
    {
      v: 1,
      code: parsed.code,
      computerId,
      secretHash: relaySecretHash(relaySecret),
      computerName: input.computerName,
    },
    parsed.origin,
    computerSigningKey(dorkHome)
  );

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${parsed.origin}${RELAY_LINK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
      // Never follow a redirect: the request is for the origin in the code.
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? RELAY_LINK_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn('[SessionRelay] The hub could not be reached to link', {
      error: (error as Error).name,
    });
    return refused('hub-unreachable');
  }
  // A manual redirect surfaces as a 3xx, or as an opaque answer in a browser-like fetch.
  if (response.type === 'opaqueredirect' || response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return refused(refusalFor(response.status));
  }

  const text = await readCapped(response);
  let answer: RelayLinkResponse;
  try {
    const checked = text === null ? null : RelayLinkResponseSchema.safeParse(JSON.parse(text));
    if (!checked?.success) return refused('hub-unreachable');
    answer = checked.data;
  } catch {
    return refused('hub-unreachable');
  }
  if (!verifyRelayLinkResponse(answer, request, parsed.origin)) {
    logger.warn('[SessionRelay] The hub’s link answer was not signed by its key; nothing pinned');
    return refused('signature-failed');
  }
  if (identity.linked && !accountMatches(identity, answer)) {
    logger.warn('[SessionRelay] The hub names a different DorkOS account; nothing pinned');
    return refused('different-account');
  }

  const pin: RelayPin = {
    v: 2,
    computerId,
    hubOrigin: parsed.origin,
    hubKey: answer.hubKey,
    relaySecret,
    pinnedAt: (deps.now ?? (() => new Date()))().toISOString(),
    computerName: input.computerName,
    level: 'chat',
    paused: false,
    ...(answer.issuer ? { issuer: answer.issuer } : {}),
    ...(answer.ownerAccountId ? { accountId: answer.ownerAccountId } : {}),
  };
  try {
    await writeRelayPin(pin, dorkHome);
  } catch (error) {
    logger.warn('[SessionRelay] The link could not be saved', { error: (error as Error).name });
    return refused('hub-unreachable');
  }
  return { ok: true, pin };
}

function refused(reason: SessionRelayLinkRefusal): LinkToHubResult {
  return { ok: false, reason };
}
