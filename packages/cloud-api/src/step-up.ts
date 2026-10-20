/**
 * Approving from the web with a passkey: the statement a computer asks its
 * owner to sign, and the messages the hub's page and the approve page pass to
 * each other.
 *
 * A person who approves a tool call from their hub on the web does it on a
 * separate page (an approve host DorkOS Cloud serves on its own origin, or a
 * self-hosted hub's own origin). The computer writes a **statement**: exactly what is being approved
 * or denied, for which chat, until when. The approve page shows the statement
 * and asks the passkey to sign `SHA-256` of its bytes. The computer then checks
 * the signature against the passkey it pinned, the statement it issued, and
 * the tool input it still holds. Neither the hub nor DorkOS Cloud can change a
 * statement without the signature failing.
 *
 * **One set of bytes, never re-written.** The computer is the only side that
 * builds a statement ({@link encodeStepUpStatement}). Every other side hashes
 * the bytes it received and checks them with {@link decodeStepUpStatement},
 * which refuses bytes the computer would not have written: keys out of order,
 * extra whitespace, a key given twice, an escaped character that did not need
 * escaping, an unpaired surrogate, or invalid UTF-8. So two readers can never
 * see two different statements in the same bytes.
 *
 * Everything here is isomorphic: it runs in Node on the computer and in a
 * browser on the approve page, using only `TextEncoder`, `TextDecoder` and
 * WebCrypto.
 *
 * @module step-up
 */
import { z } from 'zod';

import { HttpsOriginSchema } from './hubs.js';

// === Limits ===

/** Most UTF-8 bytes one statement may take. A larger one is approved at the computer. */
export const STEP_UP_STATEMENT_MAX_BYTES = 262_144;

/** Longest base64url text of one statement: {@link STEP_UP_STATEMENT_MAX_BYTES}, unpadded. */
export const STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH = Math.ceil(
  (STEP_UP_STATEMENT_MAX_BYTES * 4) / 3
);

/**
 * Deepest nesting a statement may have, counting the statement itself.
 *
 * Fixed so the computer and every browser refuse the same statements: without
 * it, how deep a value may go would depend on each engine's stack.
 */
export const STEP_UP_STATEMENT_MAX_DEPTH = 64;

/** Most passkeys one statement may name. */
export const STEP_UP_MAX_CREDENTIALS = 16;

// === Field shapes ===

/** Base64url text, unpadded, as WebAuthn encodes binary fields. */
const base64url = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The id of one challenge the computer issued. The same shape as a relay
 * request id (`RelayRequestIdSchema` in `@dorkos/shared/session-relay`), so
 * it can never carry a path segment or a query string.
 */
export const StepUpChallengeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.:-]+$/)
  .describe('The id of one challenge the computer issued. Letters, digits and _ . : - only.');

/** A computer, by the id its hub knows it by. */
const ComputerIdSchema = StepUpChallengeIdSchema;

/** No C0 control characters or DEL, so a value can never split a line it is written into. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;

/** Unicode format characters (`\p{Cf}`, direction marks among them) and line separators. */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u;

/**
 * A short name the approve page shows, by the same rule as a relay display
 * name (`RelayDisplayNameSchema` in `@dorkos/shared/session-relay`): no C0
 * controls or DEL, no format characters, no leading or trailing whitespace
 * (signed text is signed exactly, never trimmed), at most `max` characters.
 * C1 controls and everything else pass. This is not display safety: showing
 * any statement text safely, escaping control and bidi characters, is the
 * approve page's job.
 */
const displayText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(NO_CONTROL)
    .refine((text) => text.trim() === text, 'no leading or trailing whitespace')
    .refine((text) => !INVISIBLE.test(text), 'no invisible characters');

/** A lowercase UUID, as a chat's id is minted. */
const SessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** A tool call a chat is waiting on, as its runtime named it. */
const ToolCallIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\w.:-]+$/);

/** A SHA-256 digest as 64 lowercase hex characters. */
const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** 32 random bytes, base64url: exactly 43 characters. */
const NonceSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** An instant in UTC with milliseconds, as `Date.prototype.toISOString` writes it. */
const InstantSchema = z.iso.datetime({ precision: 3 });

/** A WebAuthn credential id, base64url. */
const CredentialIdSchema = base64url(1_400);

/** A WebAuthn relying party id: a lowercase host name, no port. */
const RpIdSchema = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/);

/** An https origin and nothing more, at most 256 characters. */
const OriginSchema = HttpsOriginSchema.max(256);

/**
 * Where the enrol page sends the browser back with the new passkey: a page on
 * the computer itself, over plain http to its loopback address with an explicit
 * port (RFC 8252). The numeric loopback address and `localhost` only. No user part, no
 * fragment (the enrol page puts the result there), and written exactly as the
 * URL standard writes it, so two readers cannot disagree about where it goes.
 */
export const StepUpLoopbackReturnToSchema = z
  .string()
  .max(2_048)
  .regex(/^http:\/\/(127\.0\.0\.1|localhost):[1-9][0-9]{0,4}\//, 'must be a loopback http page')
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
        url.port !== '' &&
        url.username === '' &&
        url.password === '' &&
        url.hash === '' &&
        url.href === value
      );
    } catch {
      return false;
    }
  }, 'must be a loopback http page with an explicit port, written canonically')
  .describe('A page on the computer itself: plain http to its loopback address, explicit port.');

/** Whether `origin`'s host is exactly `rpId`: the relying party is the approve page's own host. */
function originMatchesRpId(statement: { origin: string; rpId: string }): boolean {
  return new URL(statement.origin).hostname === statement.rpId;
}

/** Whether a statement expires after it was issued. */
function expiresAfterIssue(statement: { issuedAt: string; expiresAt: string }): boolean {
  return Date.parse(statement.expiresAt) > Date.parse(statement.issuedAt);
}

// === Statements ===

/** The statement type of an approval. */
export const STEP_UP_APPROVAL_STATEMENT_TYPE = 'dorkos.relay.approval.v1';

/** The statement type of adding an approvals passkey. */
export const STEP_UP_ENROL_STATEMENT_TYPE = 'dorkos.relay.passkey-enrol.v1';

/**
 * What the owner signs to approve or deny one tool call from the web.
 *
 * The approve page shows it as text, all of it, and nothing the hub says
 * outside it. `input` is the tool input the computer holds (the raw string
 * when it is not JSON), and `inputSha256` is the computer's own hash of it,
 * which it checks again before it acts. `hubOrigin` is the only page the
 * approve page answers; `origin` and `rpId` are the passkey's pinned home.
 */
export const StepUpStatementV1Schema = z
  .strictObject({
    t: z.literal(STEP_UP_APPROVAL_STATEMENT_TYPE),
    challengeId: StepUpChallengeIdSchema,
    computerId: ComputerIdSchema,
    computerName: displayText(64),
    hubOrigin: OriginSchema,
    sessionId: SessionIdSchema,
    toolCallId: ToolCallIdSchema,
    decision: z.enum(['approve', 'deny']),
    toolName: displayText(256),
    displayName: displayText(256).optional(),
    input: z.json(),
    inputSha256: Sha256HexSchema,
    nonce: NonceSchema,
    issuedAt: InstantSchema,
    expiresAt: InstantSchema,
    rpId: RpIdSchema,
    origin: OriginSchema,
    credentialIds: z.array(CredentialIdSchema).min(1).max(STEP_UP_MAX_CREDENTIALS),
  })
  .refine(originMatchesRpId, 'the origin`s host must be the relying party id')
  .refine(expiresAfterIssue, 'a statement must expire after it was issued')
  .describe('What the owner signs to approve or deny one tool call from the web.');

/** See {@link StepUpStatementV1Schema}. */
export type StepUpStatementV1 = z.infer<typeof StepUpStatementV1Schema>;

/**
 * What the owner signs, at the computer, to add an approvals passkey.
 *
 * The enrol page creates the passkey for `userHandle`, skipping the ones in
 * `excludeCredentialIds`, and sends the browser back to `returnTo` on the
 * computer itself, never anywhere else.
 */
export const PasskeyEnrolStatementV1Schema = z
  .strictObject({
    t: z.literal(STEP_UP_ENROL_STATEMENT_TYPE),
    challengeId: StepUpChallengeIdSchema,
    computerId: ComputerIdSchema,
    computerName: displayText(64),
    accountId: StepUpChallengeIdSchema,
    userHandle: base64url(128),
    nonce: NonceSchema,
    issuedAt: InstantSchema,
    expiresAt: InstantSchema,
    rpId: RpIdSchema,
    origin: OriginSchema,
    returnTo: StepUpLoopbackReturnToSchema,
    excludeCredentialIds: z.array(CredentialIdSchema).max(STEP_UP_MAX_CREDENTIALS),
  })
  .refine(originMatchesRpId, 'the origin`s host must be the relying party id')
  .refine(expiresAfterIssue, 'a statement must expire after it was issued')
  .describe('What the owner signs, at the computer, to add an approvals passkey.');

/** See {@link PasskeyEnrolStatementV1Schema}. */
export type PasskeyEnrolStatementV1 = z.infer<typeof PasskeyEnrolStatementV1Schema>;

/** Either statement, told apart by `t`. */
export const StepUpAnyStatementSchema = z
  .discriminatedUnion('t', [StepUpStatementV1Schema, PasskeyEnrolStatementV1Schema])
  .describe('An approval statement or a passkey enrol statement, told apart by `t`.');

/** See {@link StepUpAnyStatementSchema}. */
export type StepUpAnyStatement = z.infer<typeof StepUpAnyStatementSchema>;

// === The signed proof ===

/**
 * A WebAuthn assertion over a challenge the computer issued, every binary
 * field base64url. The relay carries it as `RelayApprovalProofSchema`.
 */
export const StepUpAssertionSchema = z
  .strictObject({
    /** The challenge the computer issued, by its id. */
    challengeId: StepUpChallengeIdSchema,
    credentialId: CredentialIdSchema,
    clientDataJSON: base64url(4_096),
    authenticatorData: base64url(1_024),
    signature: base64url(512),
    userHandle: base64url(128).optional(),
  })
  .describe('A WebAuthn assertion over a challenge the computer issued, binary fields base64url.');

/** See {@link StepUpAssertionSchema}. */
export type StepUpAssertion = z.infer<typeof StepUpAssertionSchema>;

// === Messages between the hub's page and the approve page ===

/**
 * What the hub's page and the approve page post to each other.
 *
 * - `dorkos.stepup.ready`: the approve page is open. Carries nothing.
 * - `dorkos.stepup.request`: the hub's page hands over the statement bytes.
 * - `dorkos.stepup.result`: the approve page hands back the signed proof.
 * - `dorkos.stepup.cancel`: the approve page closed without one.
 *
 * Each side still checks who sent a message and from which origin; the shape
 * says nothing about that.
 */
export const StepUpMessageSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('dorkos.stepup.ready') }),
    z.strictObject({
      type: z.literal('dorkos.stepup.request'),
      v: z.literal(1),
      statement: base64url(STEP_UP_STATEMENT_MAX_BASE64URL_LENGTH),
    }),
    z
      .strictObject({
        type: z.literal('dorkos.stepup.result'),
        challengeId: StepUpChallengeIdSchema,
        assertion: StepUpAssertionSchema,
      })
      .refine(
        (message) => message.assertion.challengeId === message.challengeId,
        'the assertion must be for the same challenge'
      ),
    z.strictObject({
      type: z.literal('dorkos.stepup.cancel'),
      challengeId: StepUpChallengeIdSchema,
      reason: z.enum(['dismissed', 'expired', 'not-allowed']),
    }),
  ])
  .describe('A message between the hub`s page and the approve page, told apart by `type`.');

/** See {@link StepUpMessageSchema}. */
export type StepUpMessage = z.infer<typeof StepUpMessageSchema>;

// === Bytes ===

/** Why a statement was refused, for whoever has to fix it. */
export class StepUpStatementError extends Error {
  /** Distinguishes this from a generic failure without an `instanceof` import. */
  override readonly name = 'StepUpStatementError';
}

/** An unpaired surrogate. With the `u` flag a well-formed pair is one code point and never matches. */
const LONE_SURROGATE = /\p{Cs}/u;

/** JSON text for one string, refusing one that has no exact UTF-8 form. */
function canonicalString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new StepUpStatementError('A statement cannot hold an unpaired surrogate');
  }
  return JSON.stringify(value);
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit at every depth, no
 * whitespace, `undefined` object members left out. The same text
 * `stableStringify` (`@dorkos/shared/capabilities`) writes for plain JSON,
 * which is what the computer hashes tool input with; it is written out here
 * because this package depends on nothing in the workspace.
 *
 * Stricter than `stableStringify` where that one is silently lossy: a value
 * that is not plain JSON, a `__proto__` key (which `stableStringify` drops),
 * or nesting past {@link STEP_UP_STATEMENT_MAX_DEPTH} throws instead.
 */
function canonicalJson(value: unknown, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return canonicalString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new StepUpStatementError('A statement cannot hold NaN or an infinite number');
      }
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new StepUpStatementError(`A statement cannot hold a ${typeof value}`);
  }
  if (depth >= STEP_UP_STATEMENT_MAX_DEPTH) {
    throw tooDeep();
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    throw new StepUpStatementError('A statement can hold plain objects only');
  }
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (key === '__proto__') {
      throw new StepUpStatementError('A statement cannot hold a __proto__ key');
    }
    const member = record[key];
    if (member === undefined) continue;
    members.push(`${canonicalString(key)}:${canonicalJson(member, depth + 1)}`);
  }
  return `{${members.join(',')}}`;
}

/** The refusal for a statement nested past {@link STEP_UP_STATEMENT_MAX_DEPTH}. */
function tooDeep(): StepUpStatementError {
  return new StepUpStatementError(
    `A statement cannot nest deeper than ${STEP_UP_STATEMENT_MAX_DEPTH}`
  );
}

/**
 * Refuse JSON text that nests past the cap, counting `[` and `{` outside
 * strings. Iterative, so it cannot overflow the stack it protects: the schema
 * and the canonical writer both recurse, and must never see a deeper value.
 */
function assertTextDepth(text: string): void {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charCodeAt(i);
    if (inString) {
      if (char === 0x5c) i += 1;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > STEP_UP_STATEMENT_MAX_DEPTH) throw tooDeep();
    } else if (char === 0x5d || char === 0x7d) depth -= 1;
  }
}

/**
 * Refuse a value that nests past the cap, the statement itself counting as one
 * level. Iterative for the same reason as {@link assertTextDepth}, and it stops
 * at the cap, so a value that refers to itself ends here too.
 */
function assertValueDepth(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length > 0) {
    const [node, level] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (level > STEP_UP_STATEMENT_MAX_DEPTH) throw tooDeep();
    const children = Array.isArray(node) ? node : Object.values(node as object);
    for (const child of children) stack.push([child, level + 1]);
  }
}

/** Check a value against the statement schemas, every failure a {@link StepUpStatementError}. */
function parseStatement(value: unknown): StepUpAnyStatement {
  let parsed: ReturnType<typeof StepUpAnyStatementSchema.safeParse>;
  try {
    parsed = StepUpAnyStatementSchema.safeParse(value);
  } catch (error) {
    throw new StepUpStatementError(
      `Not a valid statement: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed.success) {
    throw new StepUpStatementError(`Not a valid statement: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Canonical UTF-8 bytes of a value, refused over the byte cap. */
function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(canonicalJson(value, 0));
  if (bytes.byteLength > STEP_UP_STATEMENT_MAX_BYTES) {
    throw new StepUpStatementError(
      `A statement cannot be larger than ${STEP_UP_STATEMENT_MAX_BYTES} bytes`
    );
  }
  return bytes;
}

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The exact bytes of a statement: canonical JSON as UTF-8.
 *
 * Only the computer calls this. It checks the statement against its schema
 * first, so a statement it could not decode again is never written.
 *
 * @param statement - An approval or enrol statement.
 * @returns The bytes to hash, send and later check.
 * @throws {@link StepUpStatementError} when the statement does not fit its
 *   schema, holds a value with no exact JSON form, or exceeds
 *   {@link STEP_UP_STATEMENT_MAX_BYTES}.
 */
export function encodeStepUpStatement(statement: StepUpAnyStatement): Uint8Array<ArrayBuffer> {
  assertValueDepth(statement);
  parseStatement(statement);
  // The original, not the parsed copy: parsing quietly drops a `__proto__` key
  // inside `input`, and the canonical writer must see it to refuse it.
  return canonicalBytes(statement);
}

/**
 * Read statement bytes, refusing any the computer would not have written.
 *
 * The bytes must be valid UTF-8, parse as JSON, match a statement schema, and
 * encode back to exactly the same bytes. That last check refuses reordered
 * keys, whitespace, a key given twice, needless escapes and unpaired
 * surrogates, so what a reader shows is exactly what was hashed.
 *
 * @param bytes - The statement bytes as received.
 * @returns The statement they hold.
 * @throws {@link StepUpStatementError} on any bytes that are not one canonical statement.
 */
export function decodeStepUpStatement(bytes: Uint8Array): StepUpAnyStatement {
  if (bytes.byteLength > STEP_UP_STATEMENT_MAX_BYTES) {
    throw new StepUpStatementError(
      `A statement cannot be larger than ${STEP_UP_STATEMENT_MAX_BYTES} bytes`
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StepUpStatementError('A statement must be valid UTF-8');
  }
  assertTextDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StepUpStatementError('A statement must be valid JSON');
  }
  const statement = parseStatement(value);
  if (!sameBytes(canonicalBytes(statement), bytes)) {
    throw new StepUpStatementError('A statement must be in its one canonical form');
  }
  return statement;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url text of some bytes, unpadded. How a statement crosses the wire.
 *
 * @param bytes - Any bytes.
 * @returns Base64url text without `=` padding.
 */
export function encodeStepUpBase64url(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.byteLength; i += 3) {
    const chunk = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const left = bytes.byteLength - i;
    text += BASE64URL_ALPHABET[(chunk >> 18) & 63]! + BASE64URL_ALPHABET[(chunk >> 12) & 63]!;
    if (left > 1) text += BASE64URL_ALPHABET[(chunk >> 6) & 63]!;
    if (left > 2) text += BASE64URL_ALPHABET[chunk & 63]!;
  }
  return text;
}

/**
 * The bytes base64url text holds, refusing any text but the one canonical
 * spelling {@link encodeStepUpBase64url} writes (no padding, no stray bits).
 *
 * @param text - Unpadded base64url text.
 * @returns The bytes it holds.
 * @throws {@link StepUpStatementError} on text that is not canonical base64url.
 */
export function decodeStepUpBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new StepUpStatementError('Not base64url text');
  }
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const char of text) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  if (encodeStepUpBase64url(bytes) !== text) {
    throw new StepUpStatementError('Not canonical base64url text');
  }
  return bytes;
}

/**
 * The WebAuthn challenge for a statement: base64url (unpadded) of
 * `SHA-256(bytes)`, which is always the same length. The approve page hashes the bytes it
 * received and never re-writes them.
 *
 * @param bytes - The statement bytes, exactly as sent.
 * @returns The challenge the passkey signs.
 */
export async function stepUpChallenge(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return encodeStepUpBase64url(new Uint8Array(digest));
}

/**
 * Whether a statement has expired: `now` is at or past its `expiresAt`.
 *
 * @param statement - Any statement.
 * @param now - The current time.
 * @returns True once the statement may no longer be signed or accepted.
 */
export function isStatementExpired(
  statement: Pick<StepUpAnyStatement, 'expiresAt'>,
  now: Date
): boolean {
  return now.getTime() >= Date.parse(statement.expiresAt);
}
