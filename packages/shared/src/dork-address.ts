/**
 * The `dork:` address: people's words for a member, and its renderings
 * (ADR 261122-124821, spec `conversation-model` §6).
 *
 * An address is `dork:<space>/<handle>[/<name>]`: an org slug, a member's
 * handle, and optionally one of that member's named conversations. It resolves
 * to exactly one reference (`./dork-ref`), and it is retired, never edited. The
 * bare `dork:<space>/<handle>` is the Cloud contract's `AddressSchema.canonical`
 * (`packages/cloud-api/src/seats.ts`).
 *
 * Renderings, for people (never URIs): display `owl+launch@acme`, mention
 * `@owl@acme`, channel `#build@acme`, email local part `owl.acme+launch`.
 *
 * Names are lowercase by grammar. A mixed-case name is refused, not folded,
 * because a folded token passes validation and then fails to match its own
 * subscription. A caller reading what a person typed (or an email envelope)
 * passes `{ foldCase: true }` to fold first, on purpose.
 *
 * @module shared/dork-address
 */
import { DORK_KINDS, DORK_SCHEME, type DorkParseResult } from './dork-ref.js';
import { BROADCAST_RESERVATIONS, SYSTEM_HANDLE } from './handle.js';

/**
 * An address handle: the Cloud contract's `HandleSchema`, 2 to 32 characters,
 * `[a-z0-9_-]`, starting and ending with a letter or digit, no dot (one routing
 * token). A local handle may hold a dot (`HANDLE_PATTERN` in `./handle`); it
 * keeps working as a mention and gets no address until a dot-free one is issued.
 */
export const ADDRESS_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

/** An org slug, the `<space>` of an address: 2 to 32, `[a-z0-9-]`, alnum ends. */
export const SPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

/** A named conversation: 1 to 23, `[a-z0-9-]`, alnum ends, no dot or underscore. */
export const CONVERSATION_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,21}[a-z0-9])?$/;

/**
 * A channel slug as `#slug` renders it: the room slug grammar
 * (`ROOM_SLUG_REGEX` in `./room-schemas`, 1 to 80, may end with `-`), not the
 * research report's 2-to-32 `slug` ABNF. `#slug` names a live room whose slug
 * that grammar minted, so a stricter rule would refuse real channels. Copied,
 * not imported, to keep this module free of Zod; a test holds the two equal.
 */
const CHANNEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The longest `handle.space` pair an emailable address may have, so the email
 * local part with a `+name` stays within RFC 5321's 64 characters.
 */
export const EMAIL_PAIR_MAX_LENGTH = 40;

/**
 * Words no address may use as its space or its handle: RFC 2142's role
 * mailboxes, the usual mail and admin words, DorkOS's own names, the local
 * handle reservations (`./handle`), and every reference kind (so
 * `dork:chat/...` can never be read as an org called "chat").
 *
 * Matched on a skeleton with `-` and `_` removed ({@link isReservedAddressWord}),
 * so `no-reply`, `no_reply` and `noreply` are one word and the list names each
 * word once.
 */
export const RESERVED_ADDRESS_WORDS: readonly string[] = [
  'postmaster',
  'abuse',
  'hostmaster',
  'webmaster',
  'admin',
  'support',
  'security',
  'noreply',
  'mailer-daemon',
  'dmarc',
  'dork',
  SYSTEM_HANDLE,
  ...BROADCAST_RESERVATIONS,
  ...DORK_KINDS,
];

/** A word with its separators dropped, so `no_reply` and `noreply` compare equal. */
function skeleton(word: string): string {
  return word.replace(/[-_]/g, '');
}

const RESERVED_SKELETONS: ReadonlySet<string> = new Set(RESERVED_ADDRESS_WORDS.map(skeleton));

/**
 * Whether a space or handle is reserved, ignoring `-` and `_`: `mailer_daemon`
 * and `ch-at` are as reserved as `mailer-daemon` and `chat`.
 *
 * @param word - A lowercase space slug or handle.
 * @returns True when no address may use it.
 */
export function isReservedAddressWord(word: string): boolean {
  return RESERVED_SKELETONS.has(skeleton(word));
}

/** An address: a member of a space, or one of a member's named conversations. */
export interface DorkAddress {
  /** The org slug. */
  readonly space: string;
  /** The member's handle in that space. */
  readonly handle: string;
  /** A named conversation the member owns, when the address names one. */
  readonly name?: string;
}

/** A display form: the address with its space optional (dropped inside your own space). */
export interface DorkDisplay {
  readonly handle: string;
  readonly name?: string;
  readonly space?: string;
}

/** A `#channel[@space]` mention. */
export interface DorkChannelMention {
  readonly channel: string;
  readonly space?: string;
}

/** Why a string is not an address or a rendering of one. */
export type DorkAddressRefusal =
  | 'not-a-string'
  | 'no-scheme'
  | 'bad-shape'
  | 'mixed-case'
  | 'bad-space'
  | 'bad-handle'
  | 'bad-name'
  | 'bad-channel'
  | 'reserved';

/** Options for parsing what a person or a mail envelope wrote. */
export interface FoldOptions {
  /** Fold ASCII upper case to lower before checking. Default false: refuse it. */
  readonly foldCase?: boolean;
}

type Result<T> = DorkParseResult<T, DorkAddressRefusal>;

function refuse<T>(reason: DorkAddressRefusal): Result<T> {
  return { ok: false, reason };
}

/**
 * Case handling shared by every parser: fold on request, refuse otherwise.
 *
 * Folds ASCII `A-Z` only. `String.prototype.toLowerCase` also folds a few
 * non-ASCII letters into ASCII ones (the Kelvin sign, U+212A, becomes
 * `k`), which would let a look-alike pass the ASCII grammar after folding.
 */
function caseChecked(input: string, options: FoldOptions | undefined): string | null {
  if (options?.foldCase) return input.replace(/[A-Z]/g, (char) => char.toLowerCase());
  return /[A-Z]/.test(input) ? null : input;
}

function checkSpace(space: string): DorkAddressRefusal | null {
  if (!SPACE_SLUG_PATTERN.test(space)) return 'bad-space';
  return isReservedAddressWord(space) ? 'reserved' : null;
}

function checkHandle(handle: string): DorkAddressRefusal | null {
  if (!ADDRESS_HANDLE_PATTERN.test(handle)) return 'bad-handle';
  return isReservedAddressWord(handle) ? 'reserved' : null;
}

function checkName(name: string | undefined): DorkAddressRefusal | null {
  if (name === undefined) return null;
  return CONVERSATION_NAME_PATTERN.test(name) ? null : 'bad-name';
}

function checkAddress(address: DorkAddress): DorkAddressRefusal | null {
  return checkSpace(address.space) ?? checkHandle(address.handle) ?? checkName(address.name);
}

function withName<T extends object>(value: T, name: string | undefined): T & { name?: string } {
  return name === undefined ? value : { ...value, name };
}

/**
 * Parse `dork:<space>/<handle>[/<name>]`. Never folds: an address on the wire
 * is already lowercase, and a mixed-case one is refused.
 *
 * @param input - The candidate string.
 * @returns The address, or the reason it is not one.
 */
export function parseDorkAddress(input: unknown): Result<DorkAddress> {
  if (typeof input !== 'string') return refuse('not-a-string');
  if (!input.startsWith(DORK_SCHEME)) return refuse('no-scheme');
  const parts = input.slice(DORK_SCHEME.length).split('/');
  if (parts.length < 2 || parts.length > 3) return refuse('bad-shape');
  if (/[A-Z]/.test(input.slice(DORK_SCHEME.length))) return refuse('mixed-case');
  const [space, handle, name] = parts as [string, string, string | undefined];
  const address: DorkAddress = withName({ space, handle }, name);
  const problem = checkAddress(address);
  return problem ? refuse(problem) : { ok: true, value: address };
}

/**
 * Spell an address: `dork:<space>/<handle>[/<name>]`.
 *
 * @param address - The address.
 * @returns Its canonical string.
 * @throws {TypeError} When a part does not fit the grammar or is reserved.
 */
export function formatDorkAddress(address: DorkAddress): string {
  const problem = checkAddress(address);
  if (problem) throw new TypeError(`Not a dork: address (${problem})`);
  const tail = address.name === undefined ? '' : `/${address.name}`;
  return `${DORK_SCHEME}${address.space}/${address.handle}${tail}`;
}

/**
 * Parse a display form, `handle[+name][@space]`, such as `owl+launch@acme`.
 *
 * @param input - What a person typed or a surface showed.
 * @param options - `foldCase` to accept what a person typed in mixed case.
 * @returns The parts, or the reason it is not a display form.
 */
export function parseDorkDisplay(input: unknown, options?: FoldOptions): Result<DorkDisplay> {
  if (typeof input !== 'string') return refuse('not-a-string');
  const text = caseChecked(input, options);
  if (text === null) return refuse('mixed-case');
  const match = /^([^+@]+)(?:\+([^+@]+))?(?:@([^+@]+))?$/.exec(text);
  if (!match) return refuse('bad-shape');
  const [, handle, name, space] = match as unknown as [string, string, string?, string?];
  const problem =
    checkHandle(handle) ?? checkName(name) ?? (space === undefined ? null : checkSpace(space));
  if (problem) return refuse(problem);
  const value: DorkDisplay = withName({ handle }, name);
  return { ok: true, value: space === undefined ? value : { ...value, space } };
}

/**
 * Spell a display form. Pass `ownSpace` to drop `@space` inside your own space.
 *
 * @param display - The parts.
 * @param ownSpace - The viewer's own org slug, if any.
 * @returns `handle[+name][@space]`.
 * @throws {TypeError} When a part does not fit the grammar.
 */
export function formatDorkDisplay(display: DorkDisplay, ownSpace?: string): string {
  const problem =
    checkHandle(display.handle) ??
    checkName(display.name) ??
    (display.space === undefined ? null : checkSpace(display.space));
  if (problem) throw new TypeError(`Not a display form (${problem})`);
  const name = display.name === undefined ? '' : `+${display.name}`;
  const space =
    display.space === undefined || display.space === ownSpace ? '' : `@${display.space}`;
  return `${display.handle}${name}${space}`;
}

/**
 * Parse a member mention, `@handle[@space]`. A named conversation is picked
 * from the mention picker, never typed into a mention, so `+name` is refused.
 *
 * This is the address grammar's mention, the one that can cross spaces. A
 * dotted local handle (`HANDLE_PATTERN` in `./handle`) still works as a mention
 * inside its own room, which resolves it against the roster; it is refused
 * here because it has no address. So are the reserved words, broadcast
 * mentions such as `@everyone` included: they name no member.
 *
 * @param input - The mention, sigil included.
 * @param options - `foldCase` to accept what a person typed in mixed case.
 * @returns The handle and optional space.
 */
export function parseDorkMention(
  input: unknown,
  options?: FoldOptions
): Result<Omit<DorkDisplay, 'name'>> {
  if (typeof input !== 'string') return refuse('not-a-string');
  if (!input.startsWith('@') || input.includes('+')) return refuse('bad-shape');
  const parsed = parseDorkDisplay(input.slice(1), options);
  if (!parsed.ok) return parsed;
  const { handle, space } = parsed.value;
  return { ok: true, value: space === undefined ? { handle } : { handle, space } };
}

/**
 * Parse a channel mention, `#slug[@space]`. It names a room, not an address,
 * and resolves only while the channel is live (a slug is released on archive).
 *
 * @param input - The mention, sigil included.
 * @param options - `foldCase` to accept what a person typed in mixed case.
 * @returns The channel slug and optional space.
 */
export function parseDorkChannelMention(
  input: unknown,
  options?: FoldOptions
): Result<DorkChannelMention> {
  if (typeof input !== 'string') return refuse('not-a-string');
  const text = caseChecked(input, options);
  if (text === null) return refuse('mixed-case');
  const match = /^#([^@]+)(?:@([^@]+))?$/.exec(text);
  if (!match) return refuse('bad-shape');
  const [, channel, space] = match as unknown as [string, string, string?];
  if (!CHANNEL_SLUG_PATTERN.test(channel)) return refuse('bad-channel');
  if (space !== undefined) {
    const problem = checkSpace(space);
    if (problem) return refuse(problem);
    return { ok: true, value: { channel, space } };
  }
  return { ok: true, value: { channel } };
}

/**
 * Whether an address may be issued with an email form: `handle.space` must be
 * at most {@link EMAIL_PAIR_MAX_LENGTH} characters, so the local part fits 64
 * with a `+name`. Checked when an address is issued, never when mail arrives.
 *
 * @param handle - The address handle.
 * @param space - The org slug.
 * @returns True when the pair fits.
 */
export function fitsEmailLocalPart(handle: string, space: string): boolean {
  return handle.length + 1 + space.length <= EMAIL_PAIR_MAX_LENGTH;
}

/**
 * Parse an email local part, `handle.space[+name]` (the part before the `@`
 * of the envelope recipient; the domain is the caller's to check). The handle
 * and the slug hold no dot, so there is exactly one.
 *
 * @param input - The local part.
 * @param options - `foldCase` to fold a mixed-case recipient, as mail allows.
 * @returns The address it names.
 */
export function parseEmailLocalPart(input: unknown, options?: FoldOptions): Result<DorkAddress> {
  if (typeof input !== 'string') return refuse('not-a-string');
  const text = caseChecked(input, options);
  if (text === null) return refuse('mixed-case');
  const match = /^([^.+@]+)\.([^.+@]+)(?:\+([^.+@]+))?$/.exec(text);
  if (!match) return refuse('bad-shape');
  const [, handle, space, name] = match as unknown as [string, string, string, string?];
  const address: DorkAddress = withName({ space, handle }, name);
  const problem = checkAddress(address);
  return problem ? refuse(problem) : { ok: true, value: address };
}

/**
 * Spell an address's email local part: `handle.space[+name]`.
 *
 * @param address - The address.
 * @returns The local part, without `@` or domain.
 * @throws {TypeError} When a part does not fit, or the pair is too long to email.
 */
export function formatEmailLocalPart(address: DorkAddress): string {
  const problem = checkAddress(address);
  if (problem) throw new TypeError(`Not a dork: address (${problem})`);
  if (!fitsEmailLocalPart(address.handle, address.space)) {
    throw new TypeError('This handle and space are too long together for an email address');
  }
  const name = address.name === undefined ? '' : `+${address.name}`;
  return `${address.handle}.${address.space}${name}`;
}
