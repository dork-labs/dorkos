/**
 * The `dork:` reference: one spelling for every DorkOS thing, by its id
 * (ADR 261122-124821, spec `conversation-model` §6).
 *
 * A reference is `dork:<kind>:<id>`. It names **what**, never **where**: the
 * origin of a link, a signature's `space` and `host` fields and an email's
 * domain carry the location. It never changes, so it is what storage, links,
 * signatures and the work graph hold. Its twin, the address
 * (`dork:<space>/<handle>[/<name>]`, people's words for a member), lives in
 * `./dork-address`.
 *
 * Pure and dependency-free on purpose: the server, the client, the desktop
 * main process and shell readers all parse the same string, and a second copy
 * of this grammar is how two of them start to disagree.
 *
 * @module shared/dork-ref
 */

/** The scheme every DorkOS reference and address starts with. */
export const DORK_SCHEME = 'dork:';

/**
 * The kinds DorkOS mints ids for, fixed English words (never translated and
 * never a product word that may change: a chat stays `chat` even if the UI one
 * day calls it something else).
 *
 * The first eight are ADR 261122-124821's. `todo`, `run` and `project` are the
 * work graph's (DOR-4967): a to-do's ULID, a task run's ULID, and a known
 * project's stable short name. New kinds are added, never reinterpreted.
 */
export const DORK_KINDS = [
  'space',
  'person',
  'agent',
  'host',
  'room',
  'entry',
  'chat',
  'turn',
  'todo',
  'run',
  'project',
] as const;

/** A kind DorkOS mints ids for. */
export type DorkKind = (typeof DORK_KINDS)[number];

/** What a kind word may be spelled with: 1 to 16 lowercase ASCII letters. */
export const DORK_KIND_PATTERN = /^[a-z]{1,16}$/;

/**
 * What an id may be spelled with: 1 to 64 ASCII letters, digits, `-` and `_`.
 * Ids keep the case they were minted with (ULIDs upper, UUIDs lower) and are
 * compared exactly, never folded. Every id DorkOS holds today already fits; a
 * runtime whose native id does not gets a DorkOS-minted id and a mapping, never
 * an escaping rule.
 */
export const DORK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A Mesh agent id: a ULID, 26 Crockford base-32 characters, upper case.
 * The one copy of this pattern; `session-relay.ts` reads it from here.
 */
export const AGENT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** How many characters of a chat id a public repository carries. */
export const PUBLIC_CHAT_ID_LENGTH = 8;

/**
 * A reference: a kind and an id. `kind` is a known {@link DorkKind} when DorkOS
 * minted it; a reference of a kind this build does not know still parses, so a
 * reader one release behind can show it as an opaque name instead of dropping
 * it.
 */
export interface DorkReference<K extends string = DorkKind> {
  readonly kind: K;
  readonly id: string;
}

/** Why a string is not a reference. Stable codes, for tests and for logs. */
export type DorkReferenceRefusal =
  'not-a-string' | 'no-scheme' | 'no-kind' | 'bad-kind' | 'bad-id' | 'unknown-kind' | 'wrong-kind';

/** The outcome of a parse: the value, or one stable reason it was refused. */
export type DorkParseResult<T, R extends string> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: R };

/** Whether `kind` is one DorkOS mints ids for. */
export function isDorkKind(kind: string): kind is DorkKind {
  return (DORK_KINDS as readonly string[]).includes(kind);
}

/** Whether `id` fits the id grammar (case kept, never folded). */
export function isDorkId(id: string): boolean {
  return DORK_ID_PATTERN.test(id);
}

/**
 * Parse `dork:<kind>:<id>`, keeping a kind this build does not know.
 *
 * Nothing is trimmed, decoded or case-folded: a reference is a machine string
 * and an almost-reference is refused, never repaired.
 *
 * @param input - The candidate string.
 * @returns The reference, or the reason it is not one.
 */
export function parseAnyDorkReference(
  input: unknown
): DorkParseResult<DorkReference<string>, DorkReferenceRefusal> {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  if (!input.startsWith(DORK_SCHEME)) return { ok: false, reason: 'no-scheme' };
  const rest = input.slice(DORK_SCHEME.length);
  const colon = rest.indexOf(':');
  if (colon === -1) return { ok: false, reason: 'no-kind' };
  const kind = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  if (!DORK_KIND_PATTERN.test(kind)) return { ok: false, reason: 'bad-kind' };
  if (!DORK_ID_PATTERN.test(id)) return { ok: false, reason: 'bad-id' };
  return { ok: true, value: { kind, id } };
}

/**
 * Parse `dork:<kind>:<id>` where the kind must be one DorkOS mints.
 *
 * @param input - The candidate string.
 * @param expected - When given, the only kind accepted (`wrong-kind` otherwise).
 * @returns The reference, or the reason it is not one.
 */
export function parseDorkReference<K extends DorkKind = DorkKind>(
  input: unknown,
  expected?: K
): DorkParseResult<DorkReference<K>, DorkReferenceRefusal> {
  const parsed = parseAnyDorkReference(input);
  if (!parsed.ok) return parsed;
  const { kind, id } = parsed.value;
  if (!isDorkKind(kind)) return { ok: false, reason: 'unknown-kind' };
  if (expected !== undefined && kind !== expected) return { ok: false, reason: 'wrong-kind' };
  return { ok: true, value: { kind: kind as K, id } };
}

/**
 * Build a reference from its parts, refusing parts that would not parse back.
 *
 * @param kind - A kind DorkOS mints ids for.
 * @param id - The thing's id, exactly as minted.
 * @returns The reference.
 * @throws {TypeError} When `kind` is not a {@link DorkKind} or `id` does not fit
 *   {@link DORK_ID_PATTERN}.
 */
export function dorkRef<K extends DorkKind>(kind: K, id: string): DorkReference<K> {
  if (!isDorkKind(kind)) throw new TypeError(`Not a dork: reference kind: ${String(kind)}`);
  if (!isDorkId(id)) throw new TypeError(`Not a dork: reference id for ${kind}`);
  return { kind, id };
}

/**
 * Spell a reference: `dork:<kind>:<id>`. Round-trips with
 * {@link parseAnyDorkReference} for every reference that one accepts.
 *
 * @param ref - The reference.
 * @returns Its canonical string.
 * @throws {TypeError} When a part does not fit the grammar.
 */
export function formatDorkReference(ref: DorkReference<string>): string {
  if (!DORK_KIND_PATTERN.test(ref.kind)) throw new TypeError('Not a dork: reference kind');
  if (!isDorkId(ref.id)) throw new TypeError(`Not a dork: reference id for ${ref.kind}`);
  return `${DORK_SCHEME}${ref.kind}:${ref.id}`;
}

/**
 * The chat reference a public repository may carry: the id cut to its first
 * {@link PUBLIC_CHAT_ID_LENGTH} characters (the id, not the whole URI).
 *
 * @param chatId - The chat's full id.
 * @returns `dork:chat:<first 8>`.
 */
export function publicChatReference(chatId: string): string {
  return formatDorkReference({ kind: 'chat', id: chatId.slice(0, PUBLIC_CHAT_ID_LENGTH) });
}

/** The path of the one link route every DorkOS origin answers (DOR-5046). */
export const DORK_LINK_PREFIX = '/r/';

/** The desktop app's link form: `dorkos://r/<dork-uri>`. */
export const DORK_DESKTOP_LINK_PREFIX = 'dorkos://r/';

/**
 * The app-relative link to a reference: `/r/dork:<kind>:<id>`. A `dork:`
 * string uses only `[A-Za-z0-9:/_-]`, so it needs no encoding in a path, a
 * query or a Markdown link. Put an origin in front of it for a full URL.
 *
 * @param ref - The reference to link.
 * @returns The path.
 */
export function dorkLinkPath(ref: DorkReference<string>): string {
  return `${DORK_LINK_PREFIX}${formatDorkReference(ref)}`;
}

/**
 * Read the `dork:` string out of a link path (`/r/dork:...`) or a desktop link
 * (`dorkos://r/dork:...`). A query string or fragment after it is ignored.
 *
 * @param link - The path or desktop URL.
 * @returns The `dork:` string, or null when the link is not a `/r/` link.
 */
export function dorkUriFromLink(link: string): string | null {
  let rest: string;
  if (link.startsWith(DORK_LINK_PREFIX)) rest = link.slice(DORK_LINK_PREFIX.length);
  else if (link.startsWith(DORK_DESKTOP_LINK_PREFIX))
    rest = link.slice(DORK_DESKTOP_LINK_PREFIX.length);
  else return null;
  const end = rest.search(/[?#]/);
  const uri = end === -1 ? rest : rest.slice(0, end);
  return uri.startsWith(DORK_SCHEME) ? uri : null;
}
