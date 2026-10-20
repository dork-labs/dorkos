/**
 * Linking a computer to its hub (spec `everything-is-a-space` step B3,
 * DOR-2946): the one-time link code a hub shows its owner, the request a
 * computer sends with it, the hub's signed answer, and the exact bytes each
 * side signs.
 *
 * **The link code** is one string the owner copies from the hub to the
 * computer: 16 characters of Crockford base32 (80 bits), grouped in fours,
 * then `@` and the hub's host, e.g. `7K3M-Q9TD-X2HV-8RNB@me.dorkos.app`. The
 * host part tells the computer where to send the request; the code part
 * proves the request carries the owner's intent, because only the owner's
 * signed-in browser can mint one ({@link parseRelayLinkCode}).
 *
 * **Who proves what.**
 *
 * - The computer signs {@link relayLinkRequestTranscript} with its long-lived
 *   Ed25519 key and sends that key's public half. The hub checks the
 *   signature with the key in the request, so the key it pins is the key that
 *   holds the private half, and the hash of the code binds the signature to
 *   this one code.
 * - The hub answers with its own key and signs
 *   {@link relayLinkResponseTranscript} with it. The computer checks that
 *   signature with the returned key; with TLS to the origin in the code, that
 *   is how it knows the key came from the hub at that origin, never from
 *   DorkOS Cloud.
 * - The relay secret never crosses: the computer sends only its SHA-256.
 *
 * Both transcripts start with the session relay's own label line, so the hub's
 * key (which signs relay transcripts and nothing else) can sign the answer,
 * and their kind lines (`link-request`, `link-response`) differ from every
 * handshake kind, so no link signature stands in for a handshake one.
 *
 * Pure: schemas and bytes only. Hashing and signing live with the two ends
 * (`apps/server`).
 *
 * @module shared/session-relay-link
 */
import { z } from 'zod';
import {
  RelayDisplayNameSchema,
  RelayPinnedHubKeySchema,
  RelaySignatureSchema,
  SESSION_RELAY_TRANSCRIPT_LABEL,
} from './session-relay.js';

// === The link code ===

/** Characters in a link code: 16 of Crockford base32, 80 bits. */
export const RELAY_LINK_CODE_LENGTH = 16;

/** How long a link code works after the hub mints it. */
export const RELAY_LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** The largest link request body a hub reads. */
export const RELAY_LINK_MAX_BODY_BYTES = 4096;

/** The path a computer sends its link request to, on the hub's origin. */
export const RELAY_LINK_PATH = '/api/hub/link';

/** Crockford base32: no I, L, O or U, so a code read aloud is not misheard. */
export const RELAY_LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A host as a link code carries it: a DNS name or IPv4, an optional port. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;

/**
 * A code as typed or pasted, made canonical: uppercase, without spaces or
 * dashes, with the letters people confuse read as the digits they look like.
 *
 * @param input - The code part, as the person entered it.
 * @returns The 16 canonical characters, or `null` when it is not a code.
 */
export function normalizeRelayLinkCode(input: string): string | null {
  const value = input
    .toUpperCase()
    // Spaces and every dash a paste might bring (hyphen, en and em dashes).
    .replace(/[\s\-\u2010-\u2015\u2212]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (value.length !== RELAY_LINK_CODE_LENGTH) return null;
  for (const char of value) if (!RELAY_LINK_CODE_ALPHABET.includes(char)) return null;
  return value;
}

/**
 * The string the hub shows its owner: the code in groups of four, `@`, and
 * the hub's host (with its port, when it is not 443).
 *
 * @param code - The canonical code ({@link normalizeRelayLinkCode}).
 * @param hubOrigin - The hub's bare https origin.
 */
export function formatRelayLinkCode(code: string, hubOrigin: string): string {
  const url = new URL(hubOrigin);
  if (url.protocol !== 'https:' || url.origin !== hubOrigin) {
    throw new Error('A link code names a bare https origin');
  }
  const groups = code.match(/.{1,4}/g) ?? [];
  return `${groups.join('-')}@${url.host}`;
}

/** What a pasted link code says: where the hub is, and the code itself. */
export interface ParsedRelayLinkCode {
  /** The hub's bare https origin. */
  origin: string;
  /** The 16 canonical characters. */
  code: string;
}

/**
 * Read a pasted link code. Only `<code>@<host>` is accepted: the host becomes
 * an https origin with no path, no user name and no query, so a code cannot
 * send the computer anywhere but a plain https address.
 *
 * @param text - What the person pasted.
 * @returns The hub's origin and the code, or `null` when it is not a link code.
 */
export function parseRelayLinkCode(text: string): ParsedRelayLinkCode | null {
  const trimmed = text.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const code = normalizeRelayLinkCode(trimmed.slice(0, at));
  const host = trimmed.slice(at + 1).toLowerCase();
  if (!code || !HOST_PATTERN.test(host)) return null;
  let origin: string;
  try {
    origin = new URL(`https://${host}`).origin;
  } catch {
    return null;
  }
  // `URL` drops `:443`, and refuses a port past 65535.
  return origin.startsWith('https://') ? { origin, code } : null;
}

// === Request and response ===

/** A computer's id, as its hub knows it: the same rule as a relay pin's. */
export const RelayLinkComputerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.:-]+$/);

/** Base64url of exactly 32 bytes, unpadded: a SHA-256. */
const Sha256Base64urlSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** No control characters, so a value can never split a transcript line. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/**
 * The name a computer gives itself, as its owner sees it on the hub. Never
 * trimmed, since both ends sign the exact text: a name with leading or
 * trailing whitespace is refused instead.
 */
export const RelayLinkComputerNameSchema = RelayDisplayNameSchema;

/**
 * What a computer sends to `POST /api/hub/link`. `signature` is the
 * computer's Ed25519 signature over {@link relayLinkRequestTranscript}, by the
 * key in `computerKey`.
 */
export const RelayLinkRequestSchema = z.strictObject({
  v: z.literal(1),
  /** The code part of the link code, as the owner pasted it. */
  code: z.string().min(1).max(64),
  computerId: RelayLinkComputerIdSchema,
  /** The computer's Ed25519 public key, raw 32 bytes base64url. */
  computerKey: RelayPinnedHubKeySchema,
  /** SHA-256 of the relay secret, base64url. The hub never sees the secret. */
  secretHash: Sha256Base64urlSchema,
  computerName: RelayLinkComputerNameSchema,
  signature: RelaySignatureSchema,
});

/** See {@link RelayLinkRequestSchema}. */
export type RelayLinkRequest = z.infer<typeof RelayLinkRequestSchema>;

/**
 * The hub's answer to a link request it accepted. `signature` is the hub's
 * Ed25519 signature over {@link relayLinkResponseTranscript}, by `hubKey`.
 * `ownerAccountId` and `issuer` are present when the hub is assigned to a
 * DorkOS account, so a computer signed in to a different account can refuse.
 */
export const RelayLinkResponseSchema = z.strictObject({
  v: z.literal(1),
  /** The hub's Ed25519 public key, raw 32 bytes base64url. Pin this one. */
  hubKey: RelayPinnedHubKeySchema,
  /** The hub owner's account id at `issuer`. */
  ownerAccountId: z.string().min(1).max(128).regex(NO_CONTROL).optional(),
  /** The issuer that account id belongs to. */
  issuer: z.string().min(1).max(512).startsWith('https://').regex(NO_CONTROL).optional(),
  signature: RelaySignatureSchema,
});

/** See {@link RelayLinkResponseSchema}. */
export type RelayLinkResponse = z.infer<typeof RelayLinkResponseSchema>;

// === Signed transcripts ===

/** The fields both link transcripts cover. */
export interface RelayLinkTranscriptInput {
  /** The hub's bare https origin, as the link code named it. */
  hubOrigin: string;
  /** SHA-256 of the canonical code, base64url. */
  codeHash: string;
  computerId: string;
  computerKey: string;
  secretHash: string;
}

/**
 * The exact bytes a computer signs in its link request: the relay label, its
 * own kind line, then the hub's origin, the code's hash, the computer's id,
 * key, secret hash and name, one per line.
 *
 * @param input - The fields both transcripts cover.
 * @param computerName - The name the request carries.
 * @throws When any field holds a line break.
 */
export function relayLinkRequestTranscript(
  input: RelayLinkTranscriptInput,
  computerName: string
): Uint8Array {
  return linkTranscript('link-request', input, [computerName]);
}

/**
 * The exact bytes a hub signs in its answer: the same fields as the request
 * (without the name), then the hub's key, the owner's account id and its
 * issuer, each empty when absent.
 *
 * @param input - The fields both transcripts cover.
 * @param answer - The hub's key and owner, as the answer carries them.
 * @throws When any field holds a line break.
 */
export function relayLinkResponseTranscript(
  input: RelayLinkTranscriptInput,
  answer: Pick<RelayLinkResponse, 'hubKey' | 'ownerAccountId' | 'issuer'>
): Uint8Array {
  return linkTranscript('link-response', input, [
    answer.hubKey,
    answer.ownerAccountId ?? '',
    answer.issuer ?? '',
  ]);
}

function linkTranscript(kind: string, input: RelayLinkTranscriptInput, tail: string[]): Uint8Array {
  const fields = [
    input.hubOrigin,
    input.codeHash,
    input.computerId,
    input.computerKey,
    input.secretHash,
    ...tail,
  ];
  // One field per line: a line break in one could shift every field after it.
  if (fields.some((field) => /[\r\n]/.test(field))) {
    throw new Error('A link transcript field cannot contain a line break');
  }
  return new TextEncoder().encode([SESSION_RELAY_TRANSCRIPT_LABEL, kind, ...fields].join('\n'));
}

// === The hub's owner routes ===

/** One computer a hub serves, as its owner's settings list it. */
export const HubComputerSummarySchema = z.object({
  computerId: z.string(),
  /** The name it linked with; `null` for one linked before names were kept. */
  computerName: z.string().nullable(),
  /** When it was linked (ISO 8601); `null` when the record is gone. */
  linkedAt: z.string().nullable(),
  connected: z.boolean(),
  features: z.array(z.string()),
});

/** See {@link HubComputerSummarySchema}. */
export type HubComputerSummary = z.infer<typeof HubComputerSummarySchema>;

/** `GET /api/hub/computers`. */
export const HubComputerListSchema = z.object({ computers: z.array(HubComputerSummarySchema) });

/** See {@link HubComputerListSchema}. */
export type HubComputerList = z.infer<typeof HubComputerListSchema>;

/** `POST /api/hub/computers/link-code`: the string to copy, and when it stops working. */
export const HubLinkCodeSchema = z.object({
  linkCode: z.string(),
  expiresAt: z.string(),
});

/** See {@link HubLinkCodeSchema}. */
export type HubLinkCode = z.infer<typeof HubLinkCodeSchema>;

// === The computer's own switch (`/api/session-relay`) ===

/**
 * What the web may do on a linked computer. `chat` reads and sends messages;
 * questions and approvals wait at the computer. `full` is stored for a later
 * step and changes nothing on the relay yet. Only the owner at the computer
 * sets it: it is never raised from the web.
 */
export const SessionRelayLevelSchema = z.enum(['chat', 'full']);

/** See {@link SessionRelayLevelSchema}. */
export type SessionRelayLevel = z.infer<typeof SessionRelayLevelSchema>;

/** `GET /api/session-relay/status`: where the link stands. Never the secret. */
export const SessionRelayStatusSchema = z.object({
  linked: z.boolean(),
  /** The hub's origin; `null` when not linked. */
  hubOrigin: z.string().nullable(),
  /** The name this computer linked with; `null` when not linked. */
  computerName: z.string().nullable(),
  level: SessionRelayLevelSchema,
  paused: z.boolean(),
  /** Whether the relay connection is open right now. */
  connected: z.boolean(),
  /** When it was linked (ISO 8601); `null` when not linked. */
  pinnedAt: z.string().nullable(),
  /** The name to offer when linking: this computer's own host name. */
  suggestedName: z.string(),
});

/** See {@link SessionRelayStatusSchema}. */
export type SessionRelayStatus = z.infer<typeof SessionRelayStatusSchema>;

/**
 * The install owner's password, asked again before any change that opens this
 * computer wider through the API (and so through the agents' DorkOS tools):
 * linking, raising the level, resuming. An agent calling those routes like the
 * app does not have the password. It does not make linking agent-proof:
 * anything that can write the data folder (an agent with a shell, say) can
 * write a relay pin directly, as it could open any other channel. That is the
 * DOR-505 class, tracked separately. Never stored, logged or audited.
 */
const StepUpPasswordSchema = z.string().max(1024);

/** `POST /api/session-relay/link`. */
export const SessionRelayLinkBodySchema = z.object({
  /** The `<code>@<host>` string the owner copied from their hub. */
  linkCode: z.string().min(1).max(512),
  /** The name to link with; this computer's own name when absent. */
  computerName: RelayLinkComputerNameSchema.optional(),
  /** The owner's password; see `StepUpPasswordSchema`. */
  password: StepUpPasswordSchema.optional(),
});

/** See {@link SessionRelayLinkBodySchema}. */
export type SessionRelayLinkBody = z.infer<typeof SessionRelayLinkBodySchema>;

/** `PATCH /api/session-relay/level`. Raising to `full` needs the owner's password. */
export const SessionRelayLevelBodySchema = z.object({
  level: SessionRelayLevelSchema,
  password: StepUpPasswordSchema.optional(),
});

/** `POST /api/session-relay/resume`: the owner's password. */
export const SessionRelayResumeBodySchema = z.object({
  password: StepUpPasswordSchema.optional(),
});

/** Why linking this computer to a hub did not happen. */
export const SessionRelayLinkRefusalSchema = z.enum([
  /** The pasted text is not a link code. */
  'bad-code',
  /** No answer from the hub, a redirect, a timeout or an unreadable answer. */
  'hub-unreachable',
  /** The hub said no: a wrong, expired or used code, or it cannot link now. */
  'hub-refused',
  /** The hub's answer was not signed by the key it handed over. */
  'signature-failed',
  /**
   * On a computer linked to a DorkOS account, the hub's answer names another
   * account or issuer, or none: a check against linking the wrong hub by
   * mistake, not proof of whose hub it is.
   */
  'different-account',
  /** The code names this computer, an address on a private network, or one that resolves there. */
  'not-public',
  /** This computer is already linked, here or on the hub. */
  'already-linked',
  /** This computer is linked to a DorkOS account that could not be read just now. */
  'account-unreadable',
]);

/** See {@link SessionRelayLinkRefusalSchema}. */
export type SessionRelayLinkRefusal = z.infer<typeof SessionRelayLinkRefusalSchema>;

// === Who is using this computer from the web ===

/**
 * One browser that used chat from the web here, as this computer remembers
 * it: the hub's label for it and when it was first and last seen. Never its
 * id, and never anything it said.
 */
export const SessionRelayDeviceSchema = z.object({
  label: z.string(),
  /** When this computer first saw it (ISO 8601). */
  firstSeenAt: z.string(),
  /** When it last asked this computer for something (ISO 8601). */
  lastSeenAt: z.string(),
});

/** See {@link SessionRelayDeviceSchema}. */
export type SessionRelayDevice = z.infer<typeof SessionRelayDeviceSchema>;

/**
 * `GET /api/session-relay/presence`, and the `session_relay_presence` event
 * on the global stream: whether someone is using this computer from the web
 * right now, which is the relay connected with at least one chat open on the
 * hub.
 */
export const SessionRelayPresenceSchema = z.object({
  active: z.boolean(),
  /** When it became active (ISO 8601); absent while not active. */
  since: z.string().optional(),
  /** The browsers seen since then, most recent first; empty while not active. */
  devices: z.array(SessionRelayDeviceSchema),
});

/** See {@link SessionRelayPresenceSchema}. */
export type SessionRelayPresence = z.infer<typeof SessionRelayPresenceSchema>;

/** `GET /api/session-relay/devices`: every browser seen here, most recent first. */
export const SessionRelayDeviceListSchema = z.object({
  devices: z.array(SessionRelayDeviceSchema),
});

/** See {@link SessionRelayDeviceListSchema}. */
export type SessionRelayDeviceList = z.infer<typeof SessionRelayDeviceListSchema>;

// === Approvals passkeys (B4c) ===

/**
 * Where the loopback return page sends a new approvals passkey. The one
 * session-relay path the login gate lets through without a session: the
 * single-use enrol statement it carries is the credential (see
 * `routes/session-relay-passkeys.ts` in the server).
 */
export const SESSION_RELAY_PASSKEY_FINISH_PATH = '/api/session-relay/passkeys/finish';

/** What the owner calls an approvals passkey, as Settings lists it. No control characters. */
export const SessionRelayPasskeyLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  .regex(/^[^\u0000-\u001f\u007f]*$/);

/**
 * `POST /api/session-relay/passkeys/start`: begin adding an approvals passkey,
 * at this computer, with the owner's password. `origin` (and `rpId`, its host)
 * default to DorkOS's approve page, or to the ones already pinned; a
 * self-hosted hub names its own.
 */
export const SessionRelayPasskeyStartBodySchema = z.object({
  /** The owner's password; see `StepUpPasswordSchema`. */
  password: StepUpPasswordSchema.optional(),
  label: SessionRelayPasskeyLabelSchema,
  /** The relying party: the approve page's host. Derived from `origin` when left out. */
  rpId: z.string().min(1).max(253).optional(),
  /** The approve page's https origin. */
  origin: z.string().min(1).max(256).optional(),
});

/** See {@link SessionRelayPasskeyStartBodySchema}. */
export type SessionRelayPasskeyStartBody = z.input<typeof SessionRelayPasskeyStartBodySchema>;

/** What `POST /api/session-relay/passkeys/start` answers. */
export const SessionRelayPasskeyStartSchema = z.object({
  /** The enrol statement, base64url of its canonical bytes. */
  statement: z.string(),
  /** The WebAuthn challenge: base64url `SHA-256` of the statement bytes. */
  challenge: z.string(),
  /** The approve page's enrol page, the statement in its fragment. Open it in a browser. */
  approveUrl: z.string(),
  /** When the statement stops being accepted (ISO 8601). */
  expiresAt: z.string(),
});

/** See {@link SessionRelayPasskeyStartSchema}. */
export type SessionRelayPasskeyStart = z.infer<typeof SessionRelayPasskeyStartSchema>;

/** Base64url text, unpadded, at most `max` characters. */
const base64urlText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * A WebAuthn registration response, as `navigator.credentials.create` gives
 * it and `PublicKeyCredential.toJSON()` writes it: every binary field base64url.
 */
export const SessionRelayPasskeyAttestationSchema = z.object({
  id: base64urlText(1_400),
  rawId: base64urlText(1_400),
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: base64urlText(4_096),
    attestationObject: base64urlText(16_384),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});

/** `POST /api/session-relay/passkeys/finish`: the statement `/start` issued, and the new passkey. */
export const SessionRelayPasskeyFinishBodySchema = z.object({
  statement: base64urlText(8_192),
  attestation: SessionRelayPasskeyAttestationSchema,
});

/** See {@link SessionRelayPasskeyFinishBodySchema}. */
export type SessionRelayPasskeyFinishBody = z.input<typeof SessionRelayPasskeyFinishBodySchema>;

/** One pinned approvals passkey, as Settings lists it. Never its public key. */
export const SessionRelayPasskeySchema = z.object({
  credentialId: z.string(),
  label: z.string(),
  /** When it was added (ISO 8601). */
  addedAt: z.string(),
  /** The COSE algorithm it signs with. */
  alg: z.number().int(),
});

/** See {@link SessionRelayPasskeySchema}. */
export type SessionRelayPasskey = z.infer<typeof SessionRelayPasskeySchema>;

/** `GET /api/session-relay/passkeys`: the approve page they belong to, and the passkeys. */
export const SessionRelayPasskeyListSchema = z.object({
  /** Present when the keys file is damaged: remove it (`DELETE /passkeys`) to start again. */
  damaged: z.boolean().optional(),
  /** The pinned relying party; `null` until a passkey is added. */
  rpId: z.string().nullable(),
  /** The pinned approve page; `null` until a passkey is added. */
  origin: z.string().nullable(),
  keys: z.array(SessionRelayPasskeySchema),
});

/** See {@link SessionRelayPasskeyListSchema}. */
export type SessionRelayPasskeyList = z.infer<typeof SessionRelayPasskeyListSchema>;

/** `DELETE /api/session-relay/passkeys/:credentialId`: the owner's password. */
export const SessionRelayPasskeyRemoveBodySchema = z.object({
  password: StepUpPasswordSchema.optional(),
});
