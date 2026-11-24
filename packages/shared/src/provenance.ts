/**
 * The `agent:provenance` signature: the one hidden line an agent ends an
 * outward write with (a Linear comment, a PR body), so a later reader can
 * route a reply back to the chat that wrote it (AGENTS.md "Signing outward
 * writes", research `20261122_dorkos-address-format.md` §5.6, ADR
 * 261122-124821).
 *
 * Version 2 names the writer by `dork:` references; version 1 named it by a
 * session id and a hostname. This module reads both into one
 * {@link Provenance} and builds only version 2.
 *
 * **Routing is advice.** Anyone can paste a signature, so it never proves who
 * wrote a body and never grants a right to deliver. A router delivers only
 * into chats its own install holds, applies the outsider-words rule to the
 * body, and prefers its local run record over the line.
 *
 * The reading rules match the flow plugin's reader
 * (`dork-labs/marketplace`, `plugins/flow/scripts/signature-line.ts`,
 * `docs/provenance.md` §11) line for line, and its test vectors are copied into
 * this module's tests, so the two readers cannot drift silently:
 *
 * - **Absent, never half-trusted.** A line that is not a signature, JSON that
 *   does not parse or is not an object, or a `v` that is not a whole number of
 *   at least 1 reads as no signature at all. A missing `v` is 1.
 * - **One field at a time otherwise.** A known field with the wrong type or
 *   shape is dropped alone, as if the writer had omitted it. Each such loss
 *   only moves a router toward its safe path.
 * - **Fields by version.** Version 1 names its chat by `sessionId`; version 2
 *   by `chat` (`dork:chat:<id>`). A version newer than 2 is read with version
 *   2's fields. `host` counts only as `dork:host:<32 lowercase hex>`, so an
 *   older line's hostname is never surfaced. `resumeUrl`, `instanceId` and
 *   unknown fields are never read.
 *
 * CI tools read the line with bash and jq, so it stays ONE line of JSON.
 *
 * @module shared/provenance
 */
import {
  ADDRESS_HANDLE_PATTERN,
  CONVERSATION_NAME_PATTERN,
  SPACE_SLUG_PATTERN,
  parseDorkAddress,
} from './dork-address.js';
import {
  DORK_SCHEME,
  formatDorkReference,
  isDorkId,
  isDorkKind,
  parseDorkReference,
  publicChatReference,
  type DorkKind,
} from './dork-ref.js';

/** The two names a signature is read under: the emitted one, then the legacy one. */
export const PROVENANCE_NAMES = ['agent:provenance', 'flow:provenance'] as const;

/** One of {@link PROVENANCE_NAMES}; `flow:provenance` is the legacy one. */
export type ProvenanceName = (typeof PROVENANCE_NAMES)[number];

/** The version {@link buildProvenanceV2} writes. */
export const PROVENANCE_VERSION = 2;

/** A whole signature line under either name, its name and JSON captured. */
const PROVENANCE_LINE = /^<!--\s*(agent:provenance|flow:provenance)\s+(\{.*\})\s*-->$/;

/** A harness: `claude-code`, `codex`, `opencode`, or `other:<name>` for any other. */
const HARNESS = /^(?:claude-code|codex|opencode|other:[a-z0-9][a-z0-9._-]{0,31})$/;

/** A surface: `dorkos`, `bare-cli`, `ci`, or a newer word of the same shape. */
const SURFACE = /^[a-z][a-z0-9-]{0,31}$/;

/** An account handle: short, and never an email (no `@` can match). */
const ACCOUNT = /^[A-Za-z0-9._-]{1,64}$/;

/** An install id inside `dork:host:`: a one-way hash, never a hostname or a raw UUID. */
const HOST_ID = /^[0-9a-f]{32}$/;

/** A signature, read the same way whichever version wrote it. Unknown or malformed fields are absent. */
export interface Provenance {
  /** The name the line was written under. */
  name: ProvenanceName;
  /** The version the line declares; 1 when it declares none. */
  v: number;
  /** The harness that wrote it (`claude-code`, `codex`, `opencode`, `other:<name>`). */
  harness?: string;
  /** Where it was driven from (`dorkos`, `bare-cli`, `ci`, ...). */
  surface?: string;
  /** The harness account handle, never an email. */
  account?: string;
  /** The agent, as `dork:agent:<id>` (version 2). */
  agent?: string;
  /**
   * The chat's bare id: a version 1 `sessionId`, or the id inside a version 2
   * `chat`. On a public body it may be only the first 8 characters, so a
   * router prefix-matches it against its own chats, and treats no match or
   * more than one as no chat.
   */
  chat?: string;
  /** The space the chat belongs to, as `dork:space:<id>` (version 2). */
  space?: string;
  /** The install, as `dork:host:<32 hex>`; never a hostname. */
  host?: string;
  /** The turn that wrote it, as `dork:turn:<id>` (version 2). */
  turn?: string;
  /** The agent's address, as `dork:<space>/<handle>[/<name>]` (version 2). */
  address?: string;
}

/** The optional fields of a {@link Provenance}, in the fixed order they are written. */
type ProvenanceField = Exclude<keyof Provenance, 'name' | 'v'>;

/** Reads one raw JSON value into its normalized string, or `undefined` when malformed. */
type FieldReader = (raw: unknown) => string | undefined;

function matching(shape: RegExp): FieldReader {
  return (raw) => (typeof raw === 'string' && shape.test(raw) ? raw : undefined);
}

function reference(kind: DorkKind): FieldReader {
  return (raw) => (parseDorkReference(raw, kind).ok ? (raw as string) : undefined);
}

function readChatReference(raw: unknown): string | undefined {
  const parsed = parseDorkReference(raw, 'chat');
  return parsed.ok ? parsed.value.id : undefined;
}

function readHost(raw: unknown): string | undefined {
  const parsed = parseDorkReference(raw, 'host');
  return parsed.ok && HOST_ID.test(parsed.value.id) ? (raw as string) : undefined;
}

/**
 * An address in the `dork:` grammar whose space is not a kind word, so
 * `dork:chat/owl` is never read as an org called "chat".
 *
 * Deliberately looser than {@link parseDorkAddress}: a reserved word other than
 * a kind (`admin`, or a kind word as the handle) still reads, as it does in the
 * flow reader. Only the builder refuses to write one.
 */
function readAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.startsWith(DORK_SCHEME)) return undefined;
  const parts = raw.slice(DORK_SCHEME.length).split('/');
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [space = '', handle = '', name] = parts;
  if (!SPACE_SLUG_PATTERN.test(space) || isDorkKind(space)) return undefined;
  if (!ADDRESS_HANDLE_PATTERN.test(handle)) return undefined;
  if (name !== undefined && !CONVERSATION_NAME_PATTERN.test(name)) return undefined;
  return raw;
}

/** Every field both versions carry under the same key and shape. */
const SHARED_READERS = {
  harness: matching(HARNESS),
  surface: matching(SURFACE),
  account: matching(ACCOUNT),
  host: readHost,
} as const;

/** Version 2's fields, in the order {@link buildProvenanceV2} writes them. */
const V2_READERS: Readonly<Record<ProvenanceField, FieldReader>> = {
  harness: SHARED_READERS.harness,
  surface: SHARED_READERS.surface,
  account: SHARED_READERS.account,
  agent: reference('agent'),
  chat: readChatReference,
  space: reference('space'),
  host: SHARED_READERS.host,
  turn: reference('turn'),
  address: readAddress,
};

/** The fixed field order of a written line and of a normalized read. */
const FIELD_ORDER = Object.keys(V2_READERS) as ProvenanceField[];

/** A raw JSON object's own value at `key`; inherited keys never count. */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/**
 * Read one line as a signature, under either name.
 *
 * Routing is advice: the result says where a reply might go, never that the
 * caller may deliver there.
 *
 * @param line - One line of a body; surrounding space is allowed.
 * @returns The normalized signature, or null when the line is not one that parses
 *   (including a `v` that is not a whole number of at least 1).
 */
export function parseProvenanceLine(line: string): Provenance | null {
  const match = PROVENANCE_LINE.exec(line.trim());
  if (match === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[2] as string);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const object = json as Record<string, unknown>;
  const v = Object.hasOwn(object, 'v') ? object.v : 1;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return null;

  const read: Partial<Record<ProvenanceField, string | undefined>> = {};
  if (v === 1) {
    for (const [key, reader] of Object.entries(SHARED_READERS)) {
      read[key as ProvenanceField] = reader(own(object, key));
    }
    const sessionId = own(object, 'sessionId');
    read.chat = typeof sessionId === 'string' && isDorkId(sessionId) ? sessionId : undefined;
  } else {
    for (const key of FIELD_ORDER) read[key] = V2_READERS[key](own(object, key));
  }
  const provenance: Provenance = { name: match[1] as ProvenanceName, v };
  for (const key of FIELD_ORDER) {
    const value = read[key];
    if (value !== undefined) provenance[key] = value;
  }
  return provenance;
}

/**
 * The signature a body ends with: its LAST non-blank line. A signature
 * anywhere else in the body does not count.
 *
 * Routing is advice: the result never grants a right to deliver.
 *
 * @param body - A comment, description or PR body.
 * @returns The normalized signature, or null when the body does not end in one that parses.
 */
export function readProvenance(body: string): Provenance | null {
  return parseProvenanceLine(body.trimEnd().split('\n').at(-1) ?? '');
}

/** What {@link buildProvenanceV2} may write: a {@link Provenance}'s fields, `chat` as the bare id. */
export type ProvenanceFields = Partial<Pick<Provenance, ProvenanceField>>;

/**
 * Where the line will be posted. `unknown` is treated as `public`: the
 * fail-safe direction is to carry less.
 */
export type ProvenanceVisibility = 'public' | 'private' | 'unknown';

/** Options for {@link buildProvenanceV2}. */
export interface BuildProvenanceOptions {
  /** Where the line will be posted; decides what is cut and omitted. */
  readonly visibility: ProvenanceVisibility;
}

/** Fields a public (or unknown) repository never carries. */
const PRIVATE_ONLY: ReadonlySet<ProvenanceField> = new Set(['host', 'turn']);

/**
 * Build a version 2 signature line: `<!-- agent:provenance {...} -->`, one line
 * of JSON in the fixed order `v, harness, surface, account, agent, chat, space,
 * host, turn, address`.
 *
 * In a public or unknown repository the chat id is cut to its first 8
 * characters and `host` and `turn` are omitted; `agent`, `space` and `address`
 * are kept. `resumeUrl`, `instanceId` and any other key are never written. A
 * field that would not read back through {@link parseProvenanceLine} (an
 * account holding `@`, a hostname as `host`, a reserved address) is dropped,
 * so build then read round-trips.
 *
 * Routing is advice: the line tells a router where a reply might go and never
 * grants a right to deliver.
 *
 * @param fields - The writer's fields; `chat` is the chat's bare id, the other
 *   reference fields are whole `dork:` strings.
 * @param options - Where the line will be posted.
 * @returns The single signature line.
 */
export function buildProvenanceV2(
  fields: ProvenanceFields,
  options: BuildProvenanceOptions
): string {
  const isPrivate = options.visibility === 'private';
  const out: Record<string, string | number> = { v: PROVENANCE_VERSION };
  for (const key of FIELD_ORDER) {
    if (!isPrivate && PRIVATE_ONLY.has(key)) continue;
    const value: unknown = own(fields as Record<string, unknown>, key);
    if (typeof value !== 'string') continue;
    if (key === 'chat') {
      if (!isDorkId(value)) continue;
      out.chat = isPrivate
        ? formatDorkReference({ kind: 'chat', id: value })
        : publicChatReference(value);
      continue;
    }
    if (key === 'address' && !parseDorkAddress(value).ok) continue;
    if (V2_READERS[key](value) === value) out[key] = value;
  }
  return `<!-- ${PROVENANCE_NAMES[0]} ${JSON.stringify(out)} -->`;
}
