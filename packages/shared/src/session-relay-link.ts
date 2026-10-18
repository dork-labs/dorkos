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

/**
 * The prefix that marks a relay computer id as a cloud agent computer's
 * (DOR-2940). The space after it is reserved: a person's own computer never
 * links under an id that starts with it, so the two kinds can never collide
 * on one hub and a hub can tell an agent computer's redeem from a Mac's by
 * the id alone, with no new field on the wire.
 */
export const AGENT_COMPUTER_RELAY_ID_PREFIX = 'ac:';

/**
 * What a cloud computer id must look like to be relayed: 1 to 61 of letters,
 * digits, `_`, `.` and `-`, so the prefixed id fits
 * {@link RelayLinkComputerIdSchema} with room to spare and holds no second
 * colon. Cloud's ids are opaque, so one outside this is refused on both ends
 * rather than rewritten: a rewrite could map two ids onto one.
 */
const CLOUD_COMPUTER_ID = /^[A-Za-z0-9_.-]{1,61}$/;

/**
 * The relay computer id an agent computer links and dials under: its cloud
 * computer id behind {@link AGENT_COMPUTER_RELAY_ID_PREFIX}.
 *
 * @param cloudComputerId - The computer's id as Cloud and the hub name it.
 * @returns The relay id, or `null` when the cloud id cannot be relayed.
 */
export function agentComputerRelayId(cloudComputerId: string): string | null {
  return CLOUD_COMPUTER_ID.test(cloudComputerId)
    ? `${AGENT_COMPUTER_RELAY_ID_PREFIX}${cloudComputerId}`
    : null;
}

/**
 * The cloud computer id inside an agent computer's relay id.
 *
 * @param relayComputerId - A relay computer id.
 * @returns The cloud id, or `null` when the id is not an agent computer's.
 */
export function cloudComputerIdOf(relayComputerId: string): string | null {
  if (!relayComputerId.startsWith(AGENT_COMPUTER_RELAY_ID_PREFIX)) return null;
  const id = relayComputerId.slice(AGENT_COMPUTER_RELAY_ID_PREFIX.length);
  return CLOUD_COMPUTER_ID.test(id) ? id : null;
}

/** Base64url of exactly 32 bytes, unpadded: a SHA-256. */
const Sha256Base64urlSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** No control characters, so a value can never split a transcript line. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/**
 * Invisible format characters (`\p{Cf}`, direction marks among them) and the
 * Unicode line and paragraph separators: a name carrying one could read as
 * another name, or break a line where the transcript does not.
 */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u;

/**
 * The name a computer gives itself, as its owner sees it on the hub. Never
 * trimmed, since both ends sign the exact text: a name with leading or
 * trailing whitespace is refused instead.
 */
export const RelayLinkComputerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NO_CONTROL)
  .refine((name) => name.trim() === name, 'no leading or trailing whitespace')
  .refine((name) => !INVISIBLE.test(name), 'no invisible characters');

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
