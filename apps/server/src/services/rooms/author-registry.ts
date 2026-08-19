/**
 * Mint-on-first-use resolution of `(kind, naturalKey)` to an opaque `authorId`
 * (ADR 260726-170126).
 *
 * The whole point of this module is that an agent's persisted identity is keyed
 * on its **directory**, never on its manifest ULID. `agents` is a derived cache
 * (ADR-0043) and its reconciler is licensed to delete the table and rebuild it,
 * re-registering every agent under a fresh ULID. `agentPath` is what survives
 * that — it is already the key the agent-token store uses, and
 * `agents.project_path` is `NOT NULL UNIQUE`.
 *
 * The indirection through an opaque id is not ceremony over the path:
 *
 * - Accounts land later and need the same column. One id with a kind and a
 *   natural key holds humans, agents and the system; a path holds only agents.
 * - A room is a shared surface. A raw path would put `/Users/dorian/…` in front
 *   of every member of every room, which is a privacy defect we would have to
 *   undo under migration.
 *
 * **One thing above is narrower than it was** (ADR 260801-003051). A row now
 * carries `minted_for_manifest_id`, the ULID of the occupant it was minted FOR,
 * because keying purely on the directory left the inverse of the moved-agent
 * case unhandled: a NEW agent registered where an old one lived inherited its
 * entire message history. The directory is still the identity key and no caller
 * may supply a ULID; the stamp is derived here, and it only decides which
 * occupancy generation a row belongs to. The rebuild worry the paragraph above
 * describes is unreachable in current code — no reconciler path mints, and an
 * ADR-0043 rebuild reads ids back from the files that store them.
 *
 * @module server/services/rooms/author-registry
 */
import { basename } from 'node:path';
import { ulid } from 'ulidx';
import {
  agents,
  authors,
  handleTombstones,
  roomMembers,
  asc,
  eq,
  and,
  inArray,
  isNull,
  sql,
  type Db,
} from '@dorkos/db';
import { deriveHandle, deriveQualifiedHandle } from '@dorkos/shared/handle';
import {
  agentAuthorRef,
  type AuthorKind,
  type AuthorOrigin,
  type AuthorRef,
} from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../lib/logger.js';
import { AuthorHandleStore } from './handles/author-handle-store.js';
import { RoomError, type RoomAgent, type RoomAgentLookup } from './room-errors.js';

/**
 * The mesh-cache read the registry falls back to when nobody injects a lookup.
 *
 * Deliberately minimal: the registry asks three questions of an agent — which
 * occupant is at this directory, what is its `name`, and what does its manifest
 * call it — so the render fields are filled with placeholders rather than
 * queried. A caller that needs those (the room subsystem, which shares one
 * lookup across the whole domain) injects its own.
 *
 * @param db - The database.
 */
function registryAgentLookup(db: Db): RoomAgentLookup {
  return {
    byPath(agentPath): RoomAgent | null {
      const row = db
        .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
        .from(agents)
        .where(eq(agents.projectPath, agentPath))
        .get();
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        displayName: row.displayName ?? row.name,
        responseMode: 'always',
        emoji: null,
        color: null,
      };
    },
  };
}

/**
 * The natural key of the unbound human author — the one an install mints while
 * it has no accounts at all. {@link AuthorRegistry.bindOwner} rebinds it in
 * place the moment an owner account exists, so it is a starting state rather
 * than a permanent identity.
 */
const LOCAL_HUMAN_NATURAL_KEY = 'local';

/**
 * The natural key a human author bound to a local account carries.
 *
 * Opaque (Better Auth ids are random), free of personal data, and stable across
 * the person changing their email or their display name. The email is
 * deliberately not the key, for the reason this module already gives about
 * paths: a room is a shared surface, and an address is not something to make
 * every roster row's identity out of.
 *
 * @param userId - The Better Auth user id.
 */
function accountNaturalKey(userId: string): string {
  return `user:${userId}`;
}

/** The natural key of the system author — the room's own voice. */
const SYSTEM_NATURAL_KEY = 'system';

/** Display name the system author is minted with. */
const SYSTEM_DISPLAY_NAME = 'DorkOS';

/** Display name the local human author is minted with. */
const LOCAL_HUMAN_DISPLAY_NAME = 'You';

/**
 * Display name for a human author that is not this install's owner. Under
 * ADR 260727-184933 D6 there is no such person locally, so this labels a state
 * that should not arise — neutral on purpose, because a roster has to render
 * something and inventing a name would be worse.
 */
const UNNAMED_HUMAN_DISPLAY_NAME = 'Someone';

/**
 * A stored author row, including the `naturalKey` that never reaches the wire.
 * Server-side only: project it with {@link toAuthorRef} before returning it.
 */
export interface AuthorRecord {
  id: string;
  kind: AuthorKind;
  /**
   * An agent's `agentPath`, a human's account key, `'system'`, or — for
   * somebody on a platform outside this machine — `platform:{platformType}:
   * {instanceId}:{platformUserId}` (see the external-author section below). The
   * prefix is what
   * `authorOrigin` reads to tell a stranger from the operator, which is why
   * {@link AuthorRegistry.resolve} refuses to mint a local author wearing it.
   */
  naturalKey: string;
  displayName: string;
  /**
   * What somebody types after an `@` to reach this author, or `null` when
   * nothing does (spec `handles` §2).
   *
   * **Written once at mint and never refreshed on resolve.** `agents` is a
   * derived cache whose reconciler rebuilds it from disk every five minutes
   * (ADR-0043), so a handle re-derived on each resolve would be silently
   * overwritten by whatever the manifest currently says — spaces included, which
   * is the exact string this feature exists to stop being an address.
   *
   * `null` is honest rather than missing: the local human's stays null until
   * they are asked, because the only string there is to derive from is the
   * placeholder `'You'`, and absence is never consent.
   */
  handle: string | null;
  /** Render cache: emoji avatar, or `null` when the author has none. */
  emoji: string | null;
  /** Render cache: identity colour, or `null` when the author has none. */
  color: string | null;
  /**
   * Render cache: the URL of the author's photo, or `null` when they have none.
   *
   * The fourth field on the `display_name`/`emoji`/`color` lifecycle — refreshed
   * by a resolve whose caller knows it, because it is a cache and its source is
   * elsewhere. Deliberately NOT on `handle`'s lifecycle: a handle is a key and
   * is written once at mint, which is the distinction the two of them sitting
   * next to each other on this interface most needs to make.
   */
  imageUrl: string | null;
  /**
   * The manifest ULID of the occupant this row was minted for, or `null` on a
   * legacy row and on every non-agent author.
   *
   * **Not an identity key and never accepted from a caller** — it is derived by
   * {@link AuthorRegistry} from the `agents` table and rides along so the handle
   * and dispatch seams can tell one occupancy generation of a directory from the
   * next (ADR 260801-003051). The directory is still what identity keys on.
   */
  mintedForManifestId: string | null;
}

/**
 * Drop the natural key, leaving what a room member may see. A room is a shared
 * surface, and `/Users/dorian/…` is not something to hand every member of it —
 * an agent reads its own rooms' rosters, so this is the boundary that stops one
 * agent learning where another one lives.
 *
 * An agent still gets a stable handle to be recognised by: `agentRef` is
 * derived from the path rather than being it, so a consumer can match an author
 * to an agent without comparing rendered names.
 *
 * @param record - The stored author.
 * @param addressable - The handle that actually reaches this author HERE,
 *   overriding the one on the row. Omit it — the ordinary case — and the row's
 *   own handle is used, because a handle is unique on this install and reaches
 *   its owner from anywhere. Pass `null` when the caller knows better: an author
 *   whose agent is gone still has a handle on its row and no longer answers to
 *   it, and offering it in a picker would insert a mention that reaches nobody.
 */
export function toAuthorRef(record: AuthorRecord, addressable?: string | null): AuthorRef {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    handle: addressable === undefined ? record.handle : addressable,
    ...(record.emoji ? { emoji: record.emoji } : {}),
    ...(record.color ? { color: record.color } : {}),
    ...(record.imageUrl ? { imageUrl: record.imageUrl } : {}),
    ...(record.kind === 'agent' ? { agentRef: agentAuthorRef(record.naturalKey) } : {}),
  };
}

/**
 * Whether a thrown value is SQLite refusing a write because of one NAMED unique
 * index.
 *
 * Matched on the index name rather than on the error code, because the whole
 * point at the mint site is telling two unique indexes apart: one of them means
 * "somebody else got here first with the same identity" (recoverable by
 * re-reading) and the other means "somebody else has that address" (a refusal).
 * A code-only check would collapse them back together.
 *
 * `better-sqlite3` puts the index name in the message
 * (`UNIQUE constraint failed: index 'authors_handle_unique'`) and the code in
 * `.code`; both are checked, so a message-format change alone cannot turn this
 * into a silent false.
 *
 * @param err - Whatever was thrown.
 * @param indexName - The index to ask about.
 */
function isUniqueViolation(err: unknown, indexName: string): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && !code.startsWith('SQLITE_CONSTRAINT')) return false;
  return err.message.includes(indexName);
}

/**
 * Whether an already-loaded author is the owner of this install.
 *
 * The record form of {@link AuthorRegistry.isOwner} — the same rule, expressed
 * over a row a caller is already holding. The method delegates here, so there is
 * one implementation and it cannot drift.
 *
 * Two modes, one meaning:
 *
 * - **No owner account** (`ownerUserId` is `null`): the `'local'` sentinel is
 *   the owner. This is what keeps a single-user install identical — with no
 *   accounts there is nobody else it could be.
 * - **An owner account exists:** the author bound to `user:<ownerUserId>` is the
 *   owner, and nobody else is. Not another human, not an agent, not the system
 *   author.
 *
 * A caller that has just listed the roster must use THIS and not the method: the
 * method re-reads each row by id, which is one query per person against the table
 * the list already came from.
 *
 * @param record - The author to weigh.
 * @param ownerUserId - The owner account's user id, or `null` when the install
 *   has no accounts.
 */
export function isOwnerRecord(record: AuthorRecord, ownerUserId: string | null): boolean {
  if (record.kind !== 'human') return false;
  return (
    record.naturalKey ===
    (ownerUserId === null ? LOCAL_HUMAN_NATURAL_KEY : accountNaturalKey(ownerUserId))
  );
}

/**
 * The display name a resolve should WRITE, or `undefined` when this caller does
 * not know one and the stored label has to stand.
 *
 * `displayName` used to be refreshed unconditionally while `emoji`, `color` and
 * `imageUrl` beside it were guarded, and that asymmetry was a bug rather than a
 * decision (DOR-1264): the callers that resolve an agent do not all know the
 * same thing.
 *
 * - A **mesh-backed** caller — the roster, the moments feed, the Relay DM
 *   notifier — read the manifest a moment ago, so its string IS the display
 *   name.
 * - An **identity-token** caller — `room-capabilities.ts`, `room-caller.ts` —
 *   replays whatever name was minted into the token when the session spawned
 *   (`agent-token-env.ts`). That is a snapshot taken somewhere else, and until
 *   DOR-1264 it was a snapshot of the SLUG.
 *
 * So "knows one" is spelled out rather than assumed, in two halves. A blank
 * name is a caller that could not name the author at all. And a name that is
 * exactly the occupant's slug, at a directory whose manifest says the display
 * name is something else, is a caller holding the ADDRESS rather than the
 * label — the shape that renamed `Docs Writer` to `docs-writer` in every
 * message it wrote and in the member list.
 *
 * The slug half cannot misfire on an agent whose display name genuinely IS its
 * slug: there the two strings agree, so there is nothing to downgrade and the
 * refresh proceeds. It is a guard against a caller that knows less than it
 * appears to, never a rule about which strings may be display names.
 *
 * **It depends on one property of every {@link RoomAgentLookup}, so state it
 * rather than assume it: `displayName` is COALESCED, never the raw nullable
 * column.** Both production lookups spell it `row.displayName ?? row.name`
 * ({@link registryAgentLookup} here, `createAgentLookup` in `rooms/index.ts`),
 * and roughly half of a real install's agents store no display name at all. A
 * lookup that surfaced `null` as an empty string, or as a different string from
 * `name`, would make this guard start refusing legitimate renames for exactly
 * those agents. Any new implementation coalesces.
 *
 * @param supplied - The label this resolve carried.
 * @param occupant - The agent registered at this directory right now — `null`
 *   for a non-agent author, and for a directory that hosts none.
 */
function knownDisplayName(
  supplied: string | undefined,
  occupant: RoomAgent | null
): string | undefined {
  const name = supplied?.trim();
  if (!name) return undefined;
  if (occupant && name === occupant.name && occupant.displayName !== occupant.name) {
    return undefined;
  }
  return name;
}

/**
 * The label a row MINTED by this resolve carries — which is a different question
 * from what a refresh writes, and takes its answers in the opposite order.
 *
 * A refresh protects a STORED label, so the caller's is weighed against it. A
 * mint has no stored label to protect: the row is new, or the previous one has
 * just been retired and its name belonged to the agent that left. So the
 * occupant is authoritative here.
 *
 * That ordering is what stops a still-live token from a PREVIOUS occupant of a
 * directory naming its successor. Tokens are never rewritten and live up to
 * {@link TOKEN_ABSOLUTE_TTL_MS}, so an agent re-inited in place can be reached
 * by a bearer call carrying the old agent's name — a name `knownDisplayName`
 * accepts, because it differs from the new occupant's slug and so looks like a
 * caller that knows something. It knows something about somebody else.
 *
 * The last resort exists because {@link AuthorRefSchema} requires a non-empty
 * name: a blank row is one no roster could render. It is reachable only for an
 * agent — a directory with no registered occupant, resolved by a caller that
 * carried no label — because every human path arrives with a constant or with
 * `sanitizeIdentity(...) ?? platformUserId`. The directory's own last segment is
 * the honest answer there, and is the string `agents.name` is itself usually
 * derived from; nothing is invented, and the full path never renders.
 *
 * @param input - The resolve, as its caller spelled it.
 * @param occupant - The agent registered at this directory right now, or `null`.
 * @param known - {@link knownDisplayName}'s verdict on the caller's label.
 */
function mintDisplayName(
  input: ResolveAuthorInput,
  occupant: RoomAgent | null,
  known: string | undefined
): string {
  const named = occupant?.displayName ?? known;
  if (named) return named;
  if (input.kind !== 'agent') return input.displayName;
  return basename(input.naturalKey) || input.naturalKey;
}

/** What resolving an author needs: its kind, its stable key, and a label. */
export interface ResolveAuthorInput {
  kind: AuthorKind;
  /** The stable identity: an agent's `agentPath`, `'local'`, or `'system'`. */
  naturalKey: string;
  /**
   * Human-readable label, refreshed on the row every time a caller that KNOWS
   * one resolves — see {@link knownDisplayName} for what that means and why the
   * two callers on the agent path do not know the same thing. Blank is "this
   * caller cannot name the author", and leaves the stored label alone exactly
   * like an omitted {@link ResolveAuthorInput.emoji}.
   */
  displayName: string;
  /**
   * Emoji avatar, refreshed on the row like `displayName`. `undefined` means
   * "the caller does not know" and leaves whatever is stored alone; `null`
   * clears it. A caller that only holds a name must not blank the rest.
   */
  emoji?: string | null;
  /** Identity colour, on the same lifecycle as {@link ResolveAuthorInput.emoji}. */
  color?: string | null;
  /**
   * The author's photo, on the same lifecycle as
   * {@link ResolveAuthorInput.emoji}: `undefined` leaves whatever is stored
   * alone, `null` clears it. Whatever URL the avatar store returned, stored as
   * given — nothing here builds a path.
   */
  imageUrl?: string | null;
}

/**
 * Resolves and mints author rows. Synchronous throughout (`better-sqlite3`), so
 * it composes into the room service's own synchronous write path.
 */
export class AuthorRegistry {
  /**
   * Who owns which handle. Composed rather than inherited so the tombstone
   * table has exactly one reader and writer, and so the registry's own methods
   * cannot bypass the three refusals it enforces.
   */
  readonly handles: AuthorHandleStore;

  /**
   * What agent occupies a directory right now — the ONE seam the registry reads
   * an agent through.
   *
   * Two things need it and they must not answer separately: which occupancy
   * generation a row belongs to (`minted_for_manifest_id`) and what a
   * mint-time handle derives from (`agents.name`). Injected rather than queried
   * so a caller wiring a different lookup — the room subsystem does — gets the
   * same answer here as everywhere else, instead of the registry quietly reading
   * the table behind it.
   */
  private readonly agentsAt: RoomAgentLookup;

  constructor(
    private readonly db: Db,
    agentLookup?: RoomAgentLookup
  ) {
    this.handles = new AuthorHandleStore(db);
    this.agentsAt = agentLookup ?? registryAgentLookup(db);
  }

  /**
   * Set an author's handle, refusing with {@link RoomErrorCode} `HANDLE_TAKEN`,
   * `HANDLE_RESERVED` or `INVALID_HANDLE`.
   *
   * **Human-initiated only.** The one caller is `PATCH
   * /api/rooms/authors/:id/handle`; there is no MCP tool, no capability, and no
   * agent-reachable route that reaches it. That is the invariant S6 chose over
   * a rate limit, and it is a test rather than a tuning parameter.
   *
   * @param authorId - Whose handle to set.
   * @param raw - The new handle. Empty or whitespace clears it, tombstoning
   *   whatever they had.
   * @returns The author, with its handle as stored.
   */
  setHandle(authorId: string, raw: string): AuthorRecord {
    const author = this.getById(authorId);
    if (!author) throw new RoomError('MEMBER_NOT_FOUND', 'No such author');
    const handle = this.handles.set(author, raw);
    return { ...author, handle };
  }

  /**
   * Set or clear an author's photo.
   *
   * The write path for the fourth render-cache field, and the reason it is a
   * method rather than an `UPDATE` in a route: `imageUrl` is refreshed on
   * resolve like `displayName`, so anything that writes it has to write it
   * where every other reader of the row will see the same value on the next
   * resolve. A route reaching past this into SQL would be a second lifecycle
   * for one column.
   *
   * **Human-initiated only**, exactly like {@link AuthorRegistry.setHandle}:
   * the one caller is `POST/DELETE /api/profile/avatar`, which refuses an
   * agent before it reads a byte. Agents have no photos — their identity
   * language is an emoji and a colour (spec `identity-consistency` §W3.5).
   *
   * @param authorId - Whose photo to set.
   * @param imageUrl - Whatever URL the avatar store returned, stored verbatim,
   *   or `null` to clear it. Nothing here builds or inspects a path — the URL
   *   may be server-relative today and absolute tomorrow.
   * @returns The author, with its photo as stored.
   */
  setImageUrl(authorId: string, imageUrl: string | null): AuthorRecord {
    const author = this.getById(authorId);
    if (!author) throw new RoomError('MEMBER_NOT_FOUND', 'No such author');
    this.db.update(authors).set({ imageUrl }).where(eq(authors.id, authorId)).run();
    return { ...author, imageUrl };
  }

  /**
   * Resolve a LOCAL `(kind, naturalKey)` to an author, inserting the row the
   * first time it is seen and refreshing the cached `displayName` after that.
   * See {@link AuthorRegistry.upsert} for what "resolve" does; this adds the one
   * thing it refuses.
   *
   * **Every author on this machine mints through here, and none of them may
   * wear the `platform:` prefix** (chats-as-channels spec §4.1). Somebody
   * outside this machine goes through {@link AuthorRegistry.resolveExternal},
   * which is the only path that writes such a key.
   *
   * @param input - The author's kind, stable key, and current display name.
   * @returns The resolved author, whose `id` is stable for this occupancy of
   *   this natural key.
   */
  resolve(input: ResolveAuthorInput): AuthorRecord {
    // The invariant `external-authors.ts` states, enforced where every local
    // mint path already funnels rather than repeated at each of them. It is
    // structural, not a comment: `resolveExternal` is the ONLY way a
    // `platform:`-prefixed row is ever written, so reading the prefix back off a
    // stored key is a sound trust decision (spec §4.1, §4.3).
    if (input.naturalKey.startsWith(EXTERNAL_KEY_PREFIX)) {
      throw new RoomError(
        'RESERVED_NATURAL_KEY',
        `'${EXTERNAL_KEY_PREFIX}' is reserved for people outside this machine and cannot be minted locally`
      );
    }
    return this.upsert(input);
  }

  /**
   * Resolve the author of somebody on a platform outside this machine, minting
   * their row the first time they say anything (chats-as-channels spec §4.1).
   *
   * **Kind `human`, and that is the point.** A Telegram sender is a person;
   * `RoomContextMember.isPerson` reads the stored kind, and an agent told a
   * person is a machine cannot follow a single one of the etiquette rules about
   * who to answer (`meta/agent-etiquette.md` E2, E3, E18).
   *
   * **The display name is sanitized HERE, at mint, as well as at render**
   * (spec §9.2). It is a label that renders outside the untrusted fence, and
   * the paths that read a roster predate this feature — a name reaching the
   * store with `</room_context>` in it would be one more place that has to
   * remember. Sanitizing twice is harmless; sanitizing only at the far end is
   * a promise every future reader has to keep.
   *
   * Only this method may write a `platform:`-prefixed key;
   * {@link AuthorRegistry.resolve} refuses one.
   *
   * @param identity - Who this is, on which platform, through which bot, and
   *   what they call themselves there — the display name RAW, never
   *   pre-sanitized.
   * @returns The resolved author, whose `id` is stable for this person on this
   *   adapter instance, across every rename they ever do.
   */
  resolveExternal(identity: ExternalAuthorIdentity): AuthorRecord {
    return this.upsert({
      kind: 'human',
      naturalKey: externalNaturalKey(identity),
      displayName: externalDisplayName(identity),
    });
  }

  /**
   * Resolve `(kind, naturalKey)` to an author, inserting the row the first time
   * it is seen and refreshing the cached `displayName` after that — the shared
   * body of {@link AuthorRegistry.resolve} and
   * {@link AuthorRegistry.resolveExternal}, with no opinion about which keys are
   * allowed. Its two callers hold that opinion between them.
   *
   * **For an agent, "the row for this directory" is also "the row for the
   * occupant that directory currently holds"** (ADR 260801-003051). Four states,
   * and the fourth is the one revision 1 of the spec had no row for:
   *
   * | Active row's stamp     | Live agent at the path | What happens                  |
   * | ---------------------- | ---------------------- | ----------------------------- |
   * | matches the occupant   | yes                    | return it (the ordinary case) |
   * | null (legacy)          | yes                    | adopt: write the stamp        |
   * | differs                | yes                    | retire it, mint a fresh one   |
   * | anything               | **no**                 | return it unchanged — a ghost |
   *
   * The ghost row is left alone deliberately: retiring on absence would churn a
   * new row on every resolve for an agent that is merely gone, and the seams
   * that matter (handles, dispatch) already exclude it by asking the same
   * liveness question. Every lookup here filters `retired_at IS NULL`, or `.get()`
   * would be nondeterministic across a directory's retired siblings.
   *
   * @param input - The author's kind, stable key, and current display name.
   * @returns The resolved author, whose `id` is stable for this occupancy of
   *   this natural key.
   */
  private upsert(input: ResolveAuthorInput): AuthorRecord {
    const existing = this.activeRow(input.kind, input.naturalKey);
    // Both things this takes from the occupant are DERIVED through the one seam
    // the registry reads an agent through, never accepted from the caller: the
    // manifest ULID — the intent ADR 260726-170126 protected with a signature
    // that has no parameter for one — and the manifest's own display name,
    // which is the authority a caller's label is weighed against below.
    const occupant = input.kind === 'agent' ? this.agentsAt.byPath(input.naturalKey) : null;
    const occupantId = occupant?.id ?? null;
    const known = knownDisplayName(input.displayName, occupant);
    const minted: ResolveAuthorInput = {
      ...input,
      displayName: mintDisplayName(input, occupant, known),
    };

    if (existing) {
      if (
        occupantId !== null &&
        existing.mintedForManifestId !== null &&
        existing.mintedForManifestId !== occupantId
      ) {
        return this.retireAndMint(existing, minted, occupantId);
      }
      // Only the fields this caller actually knows are refreshed. `resolveAgent`
      // from the identity header carries a name and nothing else, it must not
      // wipe the avatar the mesh-backed resolve stored, and the name it carries
      // is itself only taken when it is one (see {@link knownDisplayName}).
      const refreshed = {
        displayName: known ?? existing.displayName,
        emoji: input.emoji === undefined ? existing.emoji : input.emoji,
        color: input.color === undefined ? existing.color : input.color,
        imageUrl: input.imageUrl === undefined ? existing.imageUrl : input.imageUrl,
      };
      // Adoption: a legacy row with no stamp takes the current occupant's id,
      // once, and is thereafter an ordinary stamped row. Only ever a write, so a
      // row minted before this column existed never retires on its own.
      const mintedForManifestId =
        existing.mintedForManifestId === null && occupantId !== null
          ? occupantId
          : existing.mintedForManifestId;
      if (
        existing.displayName !== refreshed.displayName ||
        existing.emoji !== refreshed.emoji ||
        existing.color !== refreshed.color ||
        existing.imageUrl !== refreshed.imageUrl ||
        existing.mintedForManifestId !== mintedForManifestId
      ) {
        this.db
          .update(authors)
          .set({ ...refreshed, mintedForManifestId })
          .where(eq(authors.id, existing.id))
          .run();
      }
      return {
        id: existing.id,
        kind: input.kind,
        naturalKey: input.naturalKey,
        // NOT refreshed, and this is the line the whole feature hangs on. See
        // `AuthorRecord.handle`: the mesh reconciler rebuilds `agents` from disk
        // every five minutes, so re-deriving here would overwrite the address
        // with whatever the manifest currently says.
        handle: existing.handle,
        ...refreshed,
        mintedForManifestId,
      };
    }

    return this.mintRow(minted, occupantId);
  }

  /**
   * Write the row for a `(kind, naturalKey)` nobody has resolved before, and
   * return whatever settled — this row, or a concurrent writer's.
   *
   * The half of {@link AuthorRegistry.upsert} that creates rather than
   * refreshes. Split out because the two share nothing but their inputs, and
   * because everything subtle about minting an author — the handle derivation,
   * and the two unique indexes that have to be told apart — reads better with
   * the refresh branch out of the way.
   *
   * @param input - The author's kind, stable key, and current display name.
   * @param occupantId - The manifest ULID to stamp, or `null` for a non-agent.
   */
  private mintRow(input: ResolveAuthorInput, occupantId: string | null): AuthorRecord {
    const id = ulid();
    const row = {
      id,
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
      handle: this.mintHandle({ id, ...input }),
      emoji: input.emoji ?? null,
      color: input.color ?? null,
      imageUrl: input.imageUrl ?? null,
      mintedForManifestId: occupantId,
      retiredAt: null,
      createdAt: new Date().toISOString(),
    };
    // **THIS USED TO BE A BARE `onConflictDoNothing()`, AND THAT IS THE TRAP.**
    // Unqualified, the clause means "on conflict with ANY unique index" — so
    // once `authors_handle_unique` exists, a handle collision would silently
    // drop the insert, the re-read below would find nothing, and this would
    // return a ULID for a row that was never written. Every later
    // `room_entries.author_id` would then point at a phantom author.
    //
    // The obvious fix is a qualified conflict target, and SQLite will not take
    // one here: `authors_kind_natural_key_unique` is PARTIAL, so the target has
    // to carry the index predicate — `ON CONFLICT (…) WHERE retired_at IS NULL
    // DO NOTHING` — and drizzle 0.45 emits its `where` AFTER `do nothing`, where
    // it means the DO UPDATE filter instead. So the two conflicts are told apart
    // by NAME, after the fact, which is stricter than a target anyway: a third
    // unique index added later reaches neither branch and surfaces rather than
    // being swallowed by a clause that quietly widened to cover it.
    try {
      this.db.insert(authors).values(row).run();
    } catch (err) {
      // A handle a moment ago free is somebody else's now. A refusal, not a
      // retry: a caller that asked to mint an author and got a different address
      // than it derived needs to know.
      if (isUniqueViolation(err, 'authors_handle_unique')) {
        throw new RoomError('HANDLE_TAKEN', `@${row.handle} is already somebody else's handle.`);
      }
      // A concurrent resolve of the SAME natural key. Re-reading returns the
      // winner's id rather than throwing on what is, to its caller, a read.
      if (!isUniqueViolation(err, 'authors_kind_natural_key_unique')) throw err;
    }
    const settled = this.activeRow(input.kind, input.naturalKey);
    return {
      id: settled?.id ?? row.id,
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
      handle: settled?.handle ?? row.handle,
      emoji: row.emoji,
      color: row.color,
      imageUrl: row.imageUrl,
      mintedForManifestId: settled?.mintedForManifestId ?? row.mintedForManifestId,
    };
  }

  /**
   * The handle a freshly-minted row is written with, or `null` when it gets
   * none.
   *
   * Three rules, and each of them is a decision rather than a convenience.
   *
   * **An agent derives from `agents.name`, not from its display name.** That is
   * the string that addresses it today (the roster puts it first), so deriving
   * from it preserves every working address — where deriving from the display
   * name would swap a live address for a cosmetic one. The display name is only
   * reached for when `name` spells nothing legal.
   *
   * **The local human gets nothing.** The only string there is to derive from is
   * `'You'`, which is the placeholder this feature exists to remove, and the OS
   * username is personal data this repo is careful with elsewhere. Where there
   * is no honest string, the right answer is to ask rather than to invent — and
   * until the surface that asks ships (DOR-979), the operator's handle is simply
   * null, which every reader renders as "cannot be addressed" already.
   * {@link AuthorRegistry.setHandle} is the write path waiting for it.
   *
   * **Somebody on another platform DOES derive**, from the name they chose
   * there. They are never going to be asked: nothing in DorkOS can prompt a
   * person in a Telegram group. Their display name is a real self-chosen name
   * rather than a placeholder, so deriving from it is honest, and without it a
   * bridged room would lose the ability to address the people in it at all.
   *
   * @param input - The row being minted, with the id it will carry.
   */
  private mintHandle(input: ResolveAuthorInput & { id: string }): string | null {
    const claimant = { id: input.id, kind: input.kind, naturalKey: input.naturalKey };
    if (input.kind === 'agent') {
      const taken = this.handles.spokenFor(claimant);
      const agentName = this.agentNameOf(input.naturalKey);
      return (
        (agentName ? deriveHandle(agentName, taken) : undefined) ??
        deriveHandle(input.displayName, taken) ??
        null
      );
    }
    if (input.kind === 'human' && isExternalNaturalKey(input.naturalKey)) {
      const taken = this.handles.spokenFor(claimant);
      const { platform, platformUserId } = externalAuthorParts(input.naturalKey);
      return (
        deriveQualifiedHandle(input.displayName, platform, taken) ??
        // A name written entirely outside the charset — Cyrillic, CJK, emoji —
        // is an ordinary thing for a person to have. The platform's own id is
        // opaque, distinct per person, and already the fallback the display-name
        // path takes when a name sanitizes to nothing.
        deriveQualifiedHandle(platformUserId, platform, taken) ??
        null
      );
    }
    return null;
  }

  /**
   * The one ACTIVE row for a `(kind, naturalKey)`, or `undefined`.
   *
   * The `retired_at IS NULL` filter is what the partial unique index promises:
   * without it, a directory that has changed hands has two rows matching and
   * `.get()` picks between them by whatever order SQLite happens to use.
   *
   * @param kind - The author kind.
   * @param naturalKey - The stable identity.
   */
  private activeRow(kind: AuthorKind, naturalKey: string): typeof authors.$inferSelect | undefined {
    return this.db
      .select()
      .from(authors)
      .where(
        and(eq(authors.kind, kind), eq(authors.naturalKey, naturalKey), isNull(authors.retiredAt))
      )
      .get();
  }

  /**
   * The `agents.name` of whatever agent is registered at a directory right now,
   * or `null` when none is. Public because the boot-time backfill derives from
   * it too, and a second query for the same column is a second answer waiting to
   * disagree.
   *
   * **`name`, deliberately, and not `display_name`.** The roster puts
   * `agents.name` first when it decides what an `@` reaches, so it is the string
   * that addresses an agent today, and deriving a handle from it is what
   * preserves every address that already works. For most agent rows the two
   * columns differ, so reading the wrong one is the single most likely way to
   * get derivation wrong: `temp-assetops-aced-iframe` is the working address and
   * `temp_assetops_aced_iframe` is merely how it renders.
   *
   * @param agentPath - The agent's project directory.
   */
  agentNameOf(agentPath: string): string | null {
    return this.agentsAt.byPath(agentPath)?.name ?? null;
  }

  /**
   * Retire the previous occupant's author and mint the new occupant one, in a
   * single transaction.
   *
   * **The memberships are deliberately not carried.** `room_members` is keyed
   * `(roomId, authorId)` and room membership is an ACCESS fact: a new agent
   * occupying a reused directory must not inherit the rooms the previous
   * occupant was invited to. The consequence — re-initializing a manifest in
   * place drops that agent out of every room until it is re-invited — is
   * accepted in ADR 260801-003051, and it is loud rather than silent: the warn
   * below names both author ids and every room left behind, the moment it
   * happens.
   *
   * One transaction because the partial unique index makes the window real: a
   * crash between the retire and the insert would leave a directory with no
   * active author at all. (It self-heals — the next resolve finds none and mints
   * — but the transaction means the window does not exist.)
   *
   * **The handle release is INSIDE that transaction, and it has to be.** The
   * retired row gives up the address it answered to — a retired author stops
   * claiming handles, and while it holds one, `authors_handle_unique` refuses
   * the successor. Done outside, a crash between the release and the insert
   * would leave the directory with no active author AND its handle tombstoned to
   * a row nobody resolves, which the next resolve cannot self-heal: the mint
   * would derive a suffixed handle and the original would sit reserved forever.
   * So the release is spelled out here rather than delegated to
   * {@link AuthorHandleStore.release}, which opens a transaction of its own.
   *
   * Released rather than deleted, so the tombstone still records who had it —
   * and the successor at this same directory is inside that author's lineage, so
   * it takes the name straight back. Re-initializing your own agent in place must
   * not burn its handle forever.
   *
   * @param existing - The row being retired.
   * @param input - What the new row is minted from.
   * @param occupantId - The manifest ULID the fresh row is stamped with.
   */
  private retireAndMint(
    existing: typeof authors.$inferSelect,
    input: ResolveAuthorInput,
    occupantId: string
  ): AuthorRecord {
    const now = new Date().toISOString();
    const id = ulid();
    // Derived BEFORE the release and unaffected by it: `spokenFor` already
    // excludes the claimant's own lineage, and the row being retired is in it —
    // so the successor sees the same free namespace either way, and the two
    // steps can share one transaction rather than having to be ordered.
    const fresh = {
      id,
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
      handle: this.mintHandle({ id, ...input }),
      emoji: input.emoji ?? null,
      color: input.color ?? null,
      imageUrl: input.imageUrl ?? null,
      mintedForManifestId: occupantId,
      retiredAt: null,
      createdAt: now,
    };
    const abandoned = this.db
      .select({ roomId: roomMembers.roomId })
      .from(roomMembers)
      .where(eq(roomMembers.authorId, existing.id))
      .all()
      .map((row) => row.roomId);
    // Read outside the transaction because it names the rows this one is about
    // to change: the retired author, and any earlier generation at the same
    // directory. `fresh` is not in it yet and does not need to be — nothing it
    // could own has been written.
    const lineage = [
      ...this.handles.lineageOf({
        id: existing.id,
        kind: input.kind,
        naturalKey: input.naturalKey,
      }),
    ];

    this.db.transaction((tx) => {
      if (existing.handle !== null) {
        tx.insert(handleTombstones)
          .values({ handle: existing.handle, authorId: existing.id, releasedAt: now })
          .onConflictDoNothing()
          .run();
      }
      tx.update(authors)
        .set({ retiredAt: now, handle: null })
        .where(eq(authors.id, existing.id))
        .run();
      tx.insert(authors).values(fresh).run();
      // Scoped by author id, exactly as `AuthorHandleStore.set` scopes its own
      // reclaim: only a tombstone this lineage wrote is this lineage's to clear.
      // An unscoped delete would silently drop somebody else's reservation the
      // day two of them ever shared a handle.
      if (fresh.handle !== null) {
        tx.delete(handleTombstones)
          .where(
            and(
              sql`lower(${handleTombstones.handle}) = ${fresh.handle}`,
              inArray(handleTombstones.authorId, lineage)
            )
          )
          .run();
      }
    });

    logger.warn('[rooms] an agent directory changed hands, so its rooms did not carry over', {
      retiredAuthorId: existing.id,
      authorId: fresh.id,
      manifestId: occupantId,
      previousManifestId: existing.mintedForManifestId,
      displayName: input.displayName,
      // Both addresses, because this is the one event that moves one: the
      // previous occupant's is now a tombstone, and somebody reading the log to
      // work out why `@bella-codebase` stopped reaching what they expected needs
      // to see the pair rather than infer it.
      handle: fresh.handle,
      previousHandle: existing.handle,
      roomsLeftBehind: abandoned.length,
      roomIds: abandoned,
    });

    return {
      id: fresh.id,
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: fresh.displayName,
      handle: fresh.handle,
      emoji: fresh.emoji,
      color: fresh.color,
      imageUrl: fresh.imageUrl,
      mintedForManifestId: occupantId,
    };
  }

  /**
   * Resolve an agent by its directory. This overload exists so no caller is
   * ever handed the opportunity to pass a manifest ULID: the signature simply
   * has no parameter for one.
   *
   * That is still true after ADR 260801-003051, and the distinction is worth
   * holding. The registry now DERIVES the current occupant's manifest ULID from
   * the `agents` table it already reads, and stamps it on the row, so a
   * directory that changes hands starts a fresh author instead of inheriting the
   * previous occupant's history. What no caller may do is SUPPLY one — identity
   * still keys on the directory, and the id rides along only to tell one
   * occupancy generation from the next.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @param displayName - The agent's current name, for rendering — and only
   *   when this caller knows one. Nothing, whitespace, or the agent's slug where
   *   its manifest says otherwise all mean "cannot name it": the stored label
   *   stands rather than being overwritten ({@link knownDisplayName}). A row
   *   being MINTED has no stored label, so it takes the occupant's own name,
   *   and — for a directory with no registered occupant at all — the
   *   directory's last segment rather than a blank one no roster could render
   *   ({@link mintDisplayName}).
   * @param presentation - Emoji and colour, when the caller knows them. Omitted
   *   fields leave the stored render cache alone. **`imageUrl` is deliberately
   *   not here**, though the row carries one: an agent's identity language is
   *   its emoji and its colour, and no source of agent photos exists (the
   *   upload surface is for people). A caller that does acquire one goes
   *   through {@link AuthorRegistry.resolve}, which takes every cached field —
   *   so this stays a parameter list of things something actually knows,
   *   rather than one that invites a value nothing can supply.
   */
  resolveAgent(
    agentPath: string,
    displayName: string | undefined,
    presentation: { emoji?: string | null; color?: string | null } = {}
  ): AuthorRecord {
    return {
      ...this.resolve({
        kind: 'agent',
        naturalKey: agentPath,
        // A caller that could not name the agent at all and one that passed
        // only whitespace are saying the same thing, and `upsert` reads both as
        // "does not know" — so they collapse here rather than each needing a
        // branch downstream.
        displayName: displayName ?? '',
        ...presentation,
      }),
    };
  }

  /**
   * The unbound human author — the person at the keyboard on an install that
   * has no accounts at all. Once one exists, {@link AuthorRegistry.bindOwner}
   * takes this row over and this method stops being reachable.
   */
  localHuman(): AuthorRecord {
    return this.resolve({
      kind: 'human',
      naturalKey: LOCAL_HUMAN_NATURAL_KEY,
      displayName: LOCAL_HUMAN_DISPLAY_NAME,
    });
  }

  /**
   * The human author for a local account that is NOT this install's owner.
   *
   * Under ADR 260727-184933 D6 there is no such account: registration is closed
   * for good after the first one. This exists as the guard on that invariant
   * rather than as a path anything walks — because the failure it prevents is
   * total. It never adopts the `'local'` sentinel, so if a second account ever
   * did appear, it would get a row of its own rather than the owner's messages,
   * memberships and read cursors. {@link AuthorRegistry.bindOwner} is the one
   * path that may take the sentinel.
   *
   * @param userId - The Better Auth user id.
   */
  human(userId: string): AuthorRecord {
    const naturalKey = accountNaturalKey(userId);
    return this.resolve({
      kind: 'human',
      naturalKey,
      displayName: this.storedHumanName(naturalKey) ?? UNNAMED_HUMAN_DISPLAY_NAME,
    });
  }

  /**
   * The owner's human author — rebinding the `'local'` sentinel onto the owner's
   * account the first time this runs.
   *
   * `author-registry.ts` wrote down the plan for this before the plan existed:
   * _"The single human author v1 mints. It gets an account binding when accounts
   * land, without moving any message."_ This is that, and it is one UPDATE:
   *
   * ```sql
   * UPDATE authors SET natural_key = 'user:<id>'
   *  WHERE kind = 'human' AND natural_key = 'local'
   * ```
   *
   * **The opaque `id` does not change**, which is the entire point of the
   * opaque-id indirection collected in one statement: every `room_entries.author_id`,
   * every `room_members` row, every `room_sessions` binding and every read
   * cursor keeps pointing at the same author. Nothing is migrated and nothing is
   * rewritten.
   *
   * **`displayName` is deliberately not touched, and this is load-bearing.** The
   * column is a render cache with one value per author, so writing the owner's
   * account name here would not label them going forward — it would relabel
   * every message they had ever written, retroactively, the moment they turned
   * login on. And there is nothing to gain by it: D6 keeps this install
   * single-user, so the owner is the only person who ever reads their own
   * roster, and `'You'` is the right word for them. (`specs/invites` §17 #5
   * asked whether the rename was acceptable; D6 answers no. Remote community
   * members render under their real names, but they are cached under a different
   * natural-key scheme by a different path — never this one.)
   *
   * Idempotent, and safe in either order: once a bound row exists this returns
   * it untouched, and an install whose sentinel was never minted gets a fresh
   * bound row.
   *
   * @param userId - The owner's Better Auth user id.
   */
  bindOwner(userId: string): AuthorRecord {
    const naturalKey = accountNaturalKey(userId);
    // Both reads go through the active-row filter for the same reason the
    // resolve path does. A human author never retires — there is no manifest
    // behind it to change hands — but a `(kind, natural_key)` lookup that does
    // not say so is a lookup that would pick nondeterministically the day one
    // ever does.
    const bound = this.activeRow('human', naturalKey);
    if (bound) return toRecord(bound);

    const sentinel = this.activeRow('human', LOCAL_HUMAN_NATURAL_KEY);
    if (!sentinel) {
      return this.resolve({ kind: 'human', naturalKey, displayName: LOCAL_HUMAN_DISPLAY_NAME });
    }

    this.db.update(authors).set({ naturalKey }).where(eq(authors.id, sentinel.id)).run();
    return { ...toRecord(sentinel), naturalKey };
  }

  /**
   * Whether an author is the owner of this install — the predicate that replaced
   * `kind === 'human'` in the two places that used to read it as "is the
   * operator" (spec `invites` §4.4).
   *
   * Two modes, one meaning:
   *
   * - **No owner account** (`ownerUserId` is `null`): the `'local'` sentinel is
   *   the owner. This is what keeps a single-user install identical — with no
   *   accounts there is nobody else it could be.
   * - **An owner account exists:** the author bound to `user:<ownerUserId>` is
   *   the owner, and nobody else is. Not another human, not an agent, not the
   *   system author.
   *
   * @param authorId - The author to weigh.
   * @param ownerUserId - The owner account's user id, or `null` when the install
   *   has no accounts.
   */
  isOwner(authorId: string, ownerUserId: string | null): boolean {
    const author = this.getById(authorId);
    return author ? isOwnerRecord(author, ownerUserId) : false;
  }

  /** The system author — who a `notice` entry is written by. */
  system(): AuthorRecord {
    return this.resolve({
      kind: 'system',
      naturalKey: SYSTEM_NATURAL_KEY,
      displayName: SYSTEM_DISPLAY_NAME,
    });
  }

  /**
   * Look an author up by its opaque id.
   *
   * @param id - The author id.
   * @returns The author, or `null` when no row carries that id.
   */
  getById(id: string): AuthorRecord | null {
    const row = this.db.select().from(authors).where(eq(authors.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /**
   * Every author this install currently has, oldest first.
   *
   * The `retired_at IS NULL` filter is the same one {@link AuthorRegistry.activeRow}
   * relies on, for the same reason: a directory that has changed hands has a
   * retired row and a live one, and a listing that did not say so would render
   * both. A retired author keeps its history forever — it simply stops being
   * anybody the install can address.
   *
   * Ordered by `created_at` so the answer is stable across calls rather than
   * whatever order SQLite happens to return. **A pure read**: unlike
   * {@link AuthorRegistry.localHuman} and {@link AuthorRegistry.resolve}, this
   * mints nothing, which is what lets a read-only surface (`GET /api/team`,
   * ADR 260806-222535) list people without creating one.
   *
   * @param kind - Narrow to one author kind, or omit for all of them.
   */
  listActive(kind?: AuthorKind): AuthorRecord[] {
    const rows = this.db
      .select()
      .from(authors)
      .where(
        kind ? and(eq(authors.kind, kind), isNull(authors.retiredAt)) : isNull(authors.retiredAt)
      )
      .orderBy(asc(authors.createdAt))
      .all();
    return rows.map(toRecord);
  }

  /**
   * Look up many authors at once — one query for a whole roster rather than one
   * per member.
   *
   * @param ids - The author ids to resolve.
   * @returns A map from id to author, omitting ids with no row.
   */
  getMany(ids: readonly string[]): Map<string, AuthorRecord> {
    const resolved = new Map<string, AuthorRecord>();
    if (ids.length === 0) return resolved;
    const rows = this.db
      .select()
      .from(authors)
      .where(inArray(authors.id, [...new Set(ids)]))
      .all();
    for (const row of rows) resolved.set(row.id, toRecord(row));
    return resolved;
  }

  /** The stored display name of a human author, or `null` when it has no row yet. */
  private storedHumanName(naturalKey: string): string | null {
    return this.activeRow('human', naturalKey)?.displayName ?? null;
  }
}

/**
 * The label an external person is stored under: their platform name, sanitized
 * at mint (spec §9.2).
 *
 * **The fallback is the platform user id, and it is not laziness.** A name made
 * entirely of angle brackets and control characters sanitizes to nothing, and
 * every such person would otherwise be stored under one shared word — two
 * strangers rendering identically in a roster whose entire job is telling
 * members apart, which is the same merge §4.1 refuses at the identity level.
 * The id is opaque, address-free and distinct per person, which is exactly what
 * a label has to be here. Nobody reaches this by accident: a name has to be
 * built only of the characters `sanitizeIdentity` removes.
 *
 * @param identity - The external person, with their display name still raw.
 */
function externalDisplayName(identity: ExternalAuthorIdentity): string {
  return sanitizeIdentity(identity.displayName) ?? identity.platformUserId;
}

// === External authors: people on a platform outside this machine ===
//
// The fourth natural-key shape, beside `local`, `user:{id}` and an agent's
// directory (chats-as-channels spec §4.1–§4.3). It lives here rather than in a
// module of its own because it IS the same family: `LOCAL_HUMAN_NATURAL_KEY`,
// `accountNaturalKey` and `SYSTEM_NATURAL_KEY` are three ways of spelling an
// author's stable identity, `externalNaturalKey` is the fourth, and
// `authorOrigin` reads one back. Splitting the family across two files would
// put the invariant that binds them — no local key may wear the external
// prefix — somewhere other than the code that enforces it.

/**
 * What every external author's natural key begins with, and what nothing minted
 * on this machine may begin with.
 *
 * Exported because the invariant above is enforced in `author-registry.ts` and
 * pinned by a test, and all three have to be talking about the same string.
 */
export const EXTERNAL_KEY_PREFIX = 'platform:';

/** What separates the segments of an external natural key. */
const KEY_SEPARATOR = ':';

/**
 * A person on a platform outside this machine, as much as DorkOS knows about
 * them: which platform, which bot they reached, who they are there, and what
 * they call themselves.
 *
 * `platformUserId` is required and non-empty by construction. A message that
 * carries no resolvable one gets **no author at all** and is dropped with a
 * refusal — never folded into a shared "someone", which would merge two
 * strangers into one identity in a log that is meant to be evidence (spec §4.1).
 * That is why this type cannot express the absent case: the drop happens at the
 * boundary that reads the payload (`relay/platform-identity.ts`), before
 * anything here is reachable.
 */
export interface ExternalAuthorIdentity {
  /** The platform, as the relay subject spells it: `telegram`, `slack`. */
  platformType: string;
  /** The adapter instance the message arrived on — which bot, not which chat. */
  instanceId: string;
  /** The platform's own id for this person, read from `platformData`. */
  platformUserId: string;
  /**
   * What they call themselves there, RAW. Sanitized when the author row is
   * minted (spec §9.2) — never pass an already-sanitized value, and never
   * sanitize it twice.
   */
  displayName: string;
}

/**
 * The natural key an external person's author row is minted on.
 *
 * `platformUserId` is last, so a platform whose ids contain the separator still
 * round-trips: {@link authorOrigin} only ever reads the platform segment, which
 * is bounded by the two before it. The two segments that are NOT last are
 * checked, because a separator in either would shift what every later segment
 * means and could let one identity be spelled two ways.
 *
 * @param identity - Who this is, on which platform, through which bot.
 * @returns The key, e.g. `platform:telegram:tg-main:145223`.
 */
export function externalNaturalKey(identity: ExternalAuthorIdentity): string {
  requireKeySegment(identity.platformType, 'platform type');
  requireKeySegment(identity.instanceId, 'adapter instance');
  if (identity.platformUserId.length === 0) {
    throw new RoomError(
      'EXTERNAL_IDENTITY_INVALID',
      'An external author needs a platform user id — a message without one gets no author at all'
    );
  }
  return [
    EXTERNAL_KEY_PREFIX + identity.platformType,
    identity.instanceId,
    identity.platformUserId,
  ].join(KEY_SEPARATOR);
}

/**
 * Whether a stored natural key belongs to somebody outside this machine.
 *
 * @param naturalKey - The stored key.
 */
export function isExternalNaturalKey(naturalKey: string): boolean {
  return naturalKey.startsWith(EXTERNAL_KEY_PREFIX);
}

/**
 * Where an author is, read back off the key they were minted on.
 *
 * **This is the only derivation of origin there is**, and it deliberately takes
 * a stored key rather than a live message: origin is a property of the author,
 * established at write time and carried (spec §9.1). A version that read the
 * relay subject would answer differently for the same entry depending on what
 * else was happening on the machine.
 *
 * A malformed external key — the prefix with no platform behind it, which
 * {@link externalNaturalKey} cannot produce — is reported as external with an
 * empty-but-present platform rather than as local. Losing the platform name
 * costs a label; reporting a stranger as local would lose the trust boundary.
 *
 * @param naturalKey - The author's stored natural key.
 */
export function authorOrigin(naturalKey: string): AuthorOrigin {
  if (!isExternalNaturalKey(naturalKey)) return 'local';
  return { platform: externalAuthorParts(naturalKey).platform };
}

/**
 * The platform and the platform's own user id, read back off a stored external
 * key.
 *
 * **One parse, three readers.** {@link authorOrigin} needs the platform to draw
 * a trust boundary, the handle derivation needs both — the platform to qualify
 * the namespace, and the user id as the fallback when somebody's name spells
 * nothing the grammar can hold — and the bridged Ask card needs the user id to
 * ask an adapter's approver allowlist about it (spec `ask-entitlement` §5.1).
 * Two parses of one key shape is how they come to disagree about where a person
 * is, which is why the third reader exported this rather than writing its own.
 *
 * `platformUserId` is everything after the second separator, joined back
 * together, because a platform's ids may contain one; the two segments before it
 * are checked at mint time and cannot.
 *
 * `instanceId` is the middle segment — WHICH BOT this person reached us
 * through, not which chat. The bridged Ask card compares it against the
 * bridge's own `adapterId`, because an id is only meaningful on the
 * installation that issued it.
 *
 * A malformed key — the prefix with no platform behind it, which
 * {@link externalNaturalKey} cannot produce — reports `'unknown'` rather than an
 * empty string. Losing the platform name costs a label; a caller that read the
 * empty string as "no qualifier" would derive an unqualified handle, which is
 * the squat the qualifier exists to prevent.
 *
 * @param naturalKey - An external author's stored natural key.
 */
export function externalAuthorParts(naturalKey: string): {
  platform: string;
  instanceId: string;
  platformUserId: string;
} {
  const segments = naturalKey.slice(EXTERNAL_KEY_PREFIX.length).split(KEY_SEPARATOR);
  const platform = segments[0] ?? '';
  return {
    platform: platform.length > 0 ? platform : 'unknown',
    instanceId: segments[1] ?? '',
    platformUserId: segments.slice(2).join(KEY_SEPARATOR),
  };
}

/**
 * Refuse a key segment that is empty or carries the separator.
 *
 * @param value - The segment.
 * @param what - What it is, for the message.
 */
function requireKeySegment(value: string, what: string): void {
  if (value.length === 0 || value.includes(KEY_SEPARATOR)) {
    throw new RoomError(
      'EXTERNAL_IDENTITY_INVALID',
      `An external author's ${what} must be non-empty and must not contain '${KEY_SEPARATOR}'`
    );
  }
}

/** Narrow a stored row's stringly-typed `kind` onto the domain union. */
function toRecord(row: typeof authors.$inferSelect): AuthorRecord {
  return {
    id: row.id,
    kind: row.kind as AuthorKind,
    naturalKey: row.naturalKey,
    displayName: row.displayName,
    handle: row.handle,
    emoji: row.emoji,
    color: row.color,
    imageUrl: row.imageUrl,
    mintedForManifestId: row.mintedForManifestId,
  };
}
