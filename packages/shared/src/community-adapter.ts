/**
 * The `CommunityAdapter` port — one contract for reading and writing rooms in
 * more than one place: this machine's own SQLite rooms, a Buzz relay, and (one
 * day) `apps/community`.
 *
 * This is the FOURTH swappable seam beside {@link ./agent-runtime.js | AgentRuntime},
 * {@link ./transport.js | Transport} and {@link ./connector-provider.js | ConnectorProvider}:
 * one port, N backends, a server-side registry that aggregates with per-backend
 * degradation (ADR-0310), capability flags, and a shared conformance suite
 * (`communityConformance` in `@dorkos/test-utils`) that gates every
 * implementation exactly as `runtimeConformance` gates runtimes.
 *
 * Four rules govern everything below, and each exists because the obvious
 * design satisfies both of our own backends and fails against a backend we do
 * not control (spec `community-adapter`, §Background):
 *
 * 1. **One instance serves ONE community.** Buzz resolves its tenant from the
 *    HTTP Host at row zero, so "join two communities" means two adapters. Every
 *    address on this port is the pair `(community, roomId)`.
 * 2. **Every method is REQUIRED.** A capability-gated method whose capability is
 *    off rejects with {@link CommunityUnsupportedError} — never a silent no-op,
 *    never a partial write. Optional methods let a backend omit a surface with
 *    the compiler silent; `AgentRuntime.executeCommandIntent` is the precedent
 *    for the required-and-refusing shape.
 * 3. **No credential crosses this port** — not as an argument, not on a DTO, not
 *    in `features`. An adapter resolves its own from a server-side store keyed on
 *    its {@link CommunityRef} (D3).
 * 4. **Nothing here executes an agent** (D9, ADR `260727-184933`). There is no
 *    turn, no session handle and no invocation on this port, deliberately. The
 *    port carries conversation; compute stays on the member's machine.
 *
 * Schemas are the authoritative contract (the repo is Zod-first); TS types derive
 * via `z.infer`. The port interface itself is a runtime port rather than a
 * serializable DTO, so it is a TS interface over the derived types — and it
 * reuses `ResponseModeSchema` and `SignalTypeSchema` rather than forking either,
 * exactly as `room-schemas.ts` does.
 *
 * See `specs/community-adapter/02-specification.md` (including Amendment 2, which
 * gives `publishSignal` its presence payload, and Amendment 3, which says what
 * `subscribeRoom` owes a room the caller cannot have).
 *
 * @module shared/community-adapter
 */
import { z } from 'zod';
import { ResponseModeSchema, type ResponseMode } from './mesh-schemas.js';
import { SignalTypeSchema, type SignalType } from './relay-envelope-schemas.js';
import { AuthorKindSchema, RoomKindSchema, RoomPresenceStateSchema } from './room-schemas.js';

// ---------------------------------------------------------------------------
// 1. Addressing and identity
// ---------------------------------------------------------------------------

/**
 * Opaque, locally-minted handle for ONE configured community connection.
 * Branded so a bare string cannot pass where a community is due.
 *
 * Minted as a ULID (`ulidx`, already how rooms, entries and authors get their
 * ids). The regex is not decoration: this value becomes a directory name under
 * `<dorkHome>/communities/<ref>/`, so it must never contain `/`, `.` or `..`.
 *
 * It is minted locally at configure time and **never supplied by a remote** —
 * the same fence Buzz's `TenantContext` draws by refusing to derive
 * `Deserialize`. It is deliberately not a normalized host: a host is the one
 * attribute of a remote community that changes without the community changing,
 * and this value is both a directory name and the key every cached room hangs
 * off. {@link CommunityDescriptor.label} buys the legibility back.
 */
export const CommunityRefSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z_-]*$/, 'A community ref must be path-safe')
  .brand('CommunityRef');
/** Opaque handle for one configured community. See {@link CommunityRefSchema}. */
export type CommunityRef = z.infer<typeof CommunityRefSchema>;

/**
 * The reserved ref for this machine's own SQLite rooms. Every room that exists
 * today is addressed under it. A ULID is 26 characters of uppercase Crockford
 * base32, so no minted ref can ever collide with this lowercase literal.
 */
export const LOCAL_COMMUNITY: CommunityRef = 'local' as CommunityRef;

/**
 * A configured community as the registry knows it. The `label` is the
 * legibility a normalized host would have bought in a config file or a log
 * line, kept beside the ULID instead of inside it.
 *
 * The label lives here, once per community, and on no other payload except
 * {@link CommunityWarningSchema} — a warning is the one place the community is
 * itself the subject, so it must render without a lookup back into the
 * registry. Not on {@link CommunityCapabilitiesSchema}, which admits nothing
 * merely descriptive; not on {@link CommunityRoomSchema}, where a per-community
 * constant would be repeated per row and would be the thing that disagrees with
 * itself after a rename.
 */
export const CommunityDescriptorSchema = z.object({
  /** The community this describes. */
  community: CommunityRefSchema,
  /** Person-supplied, freely renameable, never an identifier. */
  label: z.string().min(1),
  /** Mirrors `adapter.type`, so a list renders without asking every adapter. */
  type: z.string().min(1),
});
/** A configured community as the registry knows it. See {@link CommunityDescriptorSchema}. */
export type CommunityDescriptor = z.infer<typeof CommunityDescriptorSchema>;

/**
 * A room reference. A bare room id is never sufficient — Buzz addresses
 * channels by a UUID unique only within one host, and our own `rooms` table has
 * no community column at all, so a bare id is ambiguous the moment a second
 * community exists.
 */
export const RoomAddressSchema = z.object({
  /** The community the room lives in. */
  community: CommunityRefSchema,
  /** The room's id within that community. */
  roomId: z.string().min(1),
});
/** A `(community, roomId)` pair. See {@link RoomAddressSchema}. */
export type RoomAddress = z.infer<typeof RoomAddressSchema>;

/**
 * One member, addressed. The connected identity is reported as one of these so
 * a caller can compare it against a roster row without carrying a whole member.
 *
 * A remote member's `naturalKey` is the opaque member id that community minted;
 * only the opaque local `authorId` ever reaches the wire, which is why nothing
 * here is derived from a pubkey, an email or a filesystem path.
 */
export const CommunityMemberRefSchema = z.object({
  /** The community that minted this member id. */
  community: CommunityRefSchema,
  /** Opaque member id, as this community knows it. */
  memberId: z.string().min(1),
});
/** One member, addressed. See {@link CommunityMemberRefSchema}. */
export type CommunityMemberRef = z.infer<typeof CommunityMemberRefSchema>;

// ---------------------------------------------------------------------------
// 2. The cursor
// ---------------------------------------------------------------------------

/**
 * Opaque resume token. Only the adapter that minted it may interpret it.
 *
 * Four rules, all conformance-asserted:
 *
 * 1. **Only the minting adapter interprets it.** No consumer may parse,
 *    compare, order or arithmetic a cursor. This is why its internal encoding
 *    is not a capability flag: the encoding is precisely what no consumer may
 *    branch on.
 * 2. **It is self-identifying.** A cursor must encode enough to reject one
 *    minted for a different room, a different community, or a superseded epoch.
 *    A foreign cursor is a plausible value that would silently skip real
 *    entries, so it must be **rejected, not bounded**.
 * 3. **Resume is gap-free or it throws**, eagerly, at call time. There is no
 *    best-effort and no per-adapter opt-out — it is a property of the port that
 *    every adapter owes, not a capability one may decline.
 * 4. **Every entry carries the cursor that resumes after it**
 *    ({@link CommunityEntry.cursor}). That is what replaces a numeric `seq`: you
 *    resume from an entry without knowing what is inside the token.
 */
export const CommunityCursorSchema = z.string().min(1).brand('CommunityCursor');
/** Opaque resume token. See {@link CommunityCursorSchema}. */
export type CommunityCursor = z.infer<typeof CommunityCursorSchema>;

// ---------------------------------------------------------------------------
// 3. Capabilities
// ---------------------------------------------------------------------------

/**
 * One role a backend declares. `administers` is the ONLY portable predicate the
 * product branches on — it is what makes collapsing five roles into three
 * unnecessary. Buzz's `Bot` declares `administers: false` and no rank, which is
 * honest: their own git policy layer says "Bot is a designation (what it is),
 * not a permission tier (what it can do)".
 *
 * There is deliberately no `rank` and no ordering in v1: `Bot` is the
 * counter-example that shows a linear hierarchy would have to lie about at
 * least one declared role. If a moderation UI ever needs "is this role above
 * that one", the shape to add is a partial order with an explicit incomparable
 * case — a later decision made with a real surface in front of it.
 */
export const CommunityRoleDescriptorSchema = z.object({
  /** Stable backend-specific role id, e.g. `'moderator'`. */
  id: z.string().min(1),
  /** Human-readable label — the only thing a surface renders. */
  label: z.string().min(1),
  /** May this role invite, moderate, create or archive rooms, and eject members? */
  administers: z.boolean(),
  /** Exactly one role may set this. The irreducible one: they hold the database. */
  isOwner: z.boolean().optional(),
});
/** One role a backend declares. See {@link CommunityRoleDescriptorSchema}. */
export type CommunityRoleDescriptor = z.infer<typeof CommunityRoleDescriptorSchema>;

/**
 * Static capability descriptor for one community backend (mirrors
 * `RuntimeCapabilities`).
 *
 * Genuinely-boolean differences stay booleans; anything with more than two
 * honest states is an enum; `roles` is structured because backends expose
 * materially different sets (the `RuntimeCapabilities.permissionModes`
 * precedent, ADR-0256). **Every flag here changes what a caller may do or what
 * the conformance suite asserts** — none is descriptive colour, which is why
 * there is no display name and no protocol version on it.
 *
 * Capabilities describe the **adapter, not the protocol**. Buzz-the-protocol
 * has read cursors, community invites and presence events that a read-only
 * client could genuinely observe; a read-only Buzz adapter declares
 * `readCursor: 'none'`, `invite: 'none'` and `signals: 'none'` anyway, because
 * two of those need a write path and the third has no consumer without one.
 * Declaring what a protocol could theoretically do would make the flags a lie
 * the conformance suite could not catch.
 *
 * There is deliberately **no resume flag**. All three planned backends reach a
 * gap-free resume — the hardest of them by working harder, over two transports
 * — so the guarantee is a property of the port rather than a declaration on it
 * (see {@link CommunityCursorSchema} rule 3).
 */
export const CommunityCapabilitiesSchema = z.object({
  /** Adapter type identifier, e.g. `'local' | 'buzz' | 'dorkos-community'`. Must equal `adapter.type`. */
  type: z.string().min(1),

  // --- 1. Room discovery ---------------------------------------------------
  /**
   * How new rooms are learned. `'poll'` is Buzz: channel-created discovery
   * events are stored channel-scoped, so a live global subscription never
   * receives them by fan-out. The difference is latency, not shape —
   * {@link CommunityAdapter.subscribeRoomList} absorbs it so the consumer has
   * one code path.
   */
  roomList: z.enum(['push', 'poll']),
  /** Required when `roomList === 'poll'`; the interval the adapter polls at. Absent on `'push'`. */
  roomListPollIntervalMs: z.number().int().positive().optional(),
  /**
   * `'slug'` — `#general` is unique and archiving frees the name (our partial
   * unique index). `'opaque-id'` — Buzz: a UUID with a freely-editable,
   * non-unique name. A slug-addressing UI must gate on this.
   */
  roomAddressing: z.enum(['slug', 'opaque-id']),

  // --- 2. Writing ----------------------------------------------------------
  /** Can this adapter post an entry? Read-only Buzz: `false`. */
  canPost: z.boolean(),
  /** Can it create, rename or archive a room? Read-only Buzz: `false`. */
  roomAdmin: z.boolean(),

  // --- 3. Membership -------------------------------------------------------
  /**
   * The backend's OWN role vocabulary. Not a shared enum: Buzz has five with
   * `Bot` explicitly outside the hierarchy, the community server has three, and
   * a single-person local install has none. Mirrors
   * `RuntimeCapabilities.permissionModes` exactly, `default` included.
   */
  roles: z.object({
    /** Whether this backend has roles at all. `false` requires `values: []`. */
    supported: z.boolean(),
    /** Role a newly-admitted member receives. Must reference a declared `values[].id`. */
    default: z.string().optional(),
    /** Every role this backend declares. */
    values: z.array(CommunityRoleDescriptorSchema),
  }),
  /**
   * How a new member gets in.
   *
   * - `'open'` — a valid credential is sufficient (a local install; a
   *   default-config relay).
   * - `'out-of-band'` — the credential is valid but an operator must admit it,
   *   and there is NO in-protocol way to ask (every published Buzz deployment).
   * - `'invite'` — the adapter can present a redeemable invite.
   */
  admission: z.enum(['open', 'out-of-band', 'invite']),
  /**
   * What {@link CommunityAdapter.createInvite} can offer.
   *
   * - `'room'` — offer a specific person a specific room.
   * - `'community'` — admit to the community only; a room-scoped request is
   *   REFUSED rather than silently widened.
   * - `'none'` — no invite primitive.
   */
  invite: z.enum(['none', 'community', 'room']),
  /**
   * `'owner-vouched'` — an agent gets its own community identity, vouched for
   * by the member who brought it, and its admission is DERIVED from that
   * member's (re-evaluated, never copied into a row that must be kept in sync).
   * `'none'` — this adapter cannot admit agents.
   */
  agentAdmission: z.enum(['none', 'owner-vouched']),

  // --- 4. Per-member state -------------------------------------------------
  /**
   * - `'server'` — the backend stores the cursor and can compute an unread count.
   * - `'client-opaque'` — the backend stores a blob only this member can read.
   *   The adapter round-trips its OWN cursor; a server-computed unread count is
   *   **impossible**, not merely unimplemented, and no other member's cursor
   *   exists even in principle. {@link CommunityRoom.unreadCount} is `null`
   *   everywhere.
   * - `'none'` — no cursor at all (read-only Buzz v1: writing one is a write).
   */
  readCursor: z.enum(['server', 'client-opaque', 'none']),
  /**
   * Whether a membership carries a per-room agent addressing override
   * ({@link ResponseModeSchema}). Ours does and Buzz has no counterpart; the
   * fields are orthogonal to roles, so they are separate optional fields on the
   * member rather than one merged "permission" abstraction that would
   * misrepresent both.
   */
  responseMode: z.boolean(),

  // --- 5. Threads ----------------------------------------------------------
  /**
   * `1` — one level, enforced: a reply to an entry that is already inside a
   * thread is REFUSED. `'unbounded'` — arbitrary depth (Buzz's thread metadata
   * carries a depth column and its module doc says "infinitely nested").
   *
   * The RELATION is entry-level on this port for **every** backend; only the
   * ceiling differs. A room-level relation cannot represent arbitrary depth
   * without inventing a synthetic child room per thread and discarding
   * ancestry beyond level one.
   */
  threadDepth: z.union([z.literal(1), z.literal('unbounded')]),

  // --- 6. Ephemeral --------------------------------------------------------
  /**
   * `'both'` — can emit and observe typing/presence. `'none'` — neither.
   *
   * There is deliberately no `'receive'`. An adapter that can observe a remote
   * community's typing indicators but cannot post into it has nothing to show
   * anyone; read-only Buzz declares `'none'` and gains a real capability the
   * day it gains the write path. Room working-presence rides this same flag —
   * no separate `presence` capability is minted, because for every backend this
   * port has or plans, presence is fully determined by `signals`.
   */
  signals: z.enum(['none', 'both']),

  // --- 7. Credential -------------------------------------------------------
  /**
   * - `'none'` — a local install; nothing to hold.
   * - `'machine-managed'` — the server mints and holds it in a `0600` file.
   *   Nothing user-facing exists; there is nothing to write down and nothing to
   *   lose.
   * - `'user-account'` — the member signs in (email + password, Google,
   *   GitHub). Still no key.
   */
  credential: z.enum(['none', 'machine-managed', 'user-account']),

  /**
   * Adapter-specific metadata that does not merit a first-class field (cf.
   * `RuntimeCapabilities.features`). Consumers must validate what they read.
   */
  features: z.record(z.string(), z.unknown()).default(() => ({})),
});
/** Static capability descriptor for one community backend. See {@link CommunityCapabilitiesSchema}. */
export type CommunityCapabilities = z.infer<typeof CommunityCapabilitiesSchema>;

/**
 * Every capability that GATES A METHOD, in the order the conformance suite
 * iterates them.
 *
 * This list is the mechanism behind the suite's "every off capability refuses"
 * assertion — "a new flag is covered the day it is added". `communityConformance`
 * builds a `Record<CommunityGatedCapability, …>` of probes, so adding a member
 * here fails the suite's own typecheck until its refusal is asserted.
 *
 * `roles`, `admission`, `roomList`, `roomAddressing`, `threadDepth` and
 * `credential` are deliberately absent: each changes what a caller may *expect*
 * rather than which method it may *call*, so each is asserted by its own
 * branched case instead.
 */
export const COMMUNITY_GATED_CAPABILITIES = [
  'canPost',
  'roomAdmin',
  'invite',
  'agentAdmission',
  'readCursor',
  'responseMode',
  'signals',
] as const;
/** One capability that gates a method. See {@link COMMUNITY_GATED_CAPABILITIES}. */
export type CommunityGatedCapability = (typeof COMMUNITY_GATED_CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// 4. Rooms, members, entries
// ---------------------------------------------------------------------------

/**
 * One room in one community, as the port reports it.
 *
 * `kind` reuses {@link RoomKindSchema} rather than forking it, and the reuse is
 * load-bearing twice over: two of the three backends have direct messages as
 * well as channels, and that enum no longer has a `'thread'` member — a thread
 * is a relation between entries (ADR `260728-022013`), so "`listRooms` never
 * returns a thread" is half enforced by the type.
 *
 * A room's own FILES are deliberately absent, and always have been. That
 * binding names a directory on THIS machine; a remote community has no opinion
 * about a path on someone's laptop, and putting one on the wire would be the
 * same privacy defect the author registry exists to prevent. It lives in a
 * `room-repo.json` sidecar under the DorkOS data directory, cached in
 * `room_repos` (spec `project-rooms` §3.1) — local state the cache carries
 * beside a remote room, never a field of this port. The `workspaceId` column
 * this note used to name was the v1 placeholder for the same idea and is gone
 * (DOR-1591).
 */
export const CommunityRoomSchema = RoomAddressSchema.extend({
  /** Channel or direct message. There is no thread kind: a thread is an entry relation. */
  kind: RoomKindSchema,
  /** Human-facing room name. */
  title: z.string().min(1),
  /** `#name`, or `null` under `roomAddressing: 'opaque-id'` and for direct messages. */
  slug: z.string().nullable(),
  /** Room description, or `null`. */
  topic: z.string().nullable(),
  /** An archived room still reads; it is not an error. */
  archived: z.boolean(),
  /** ISO 8601. */
  createdAt: z.string().min(1),
  /** ISO 8601 — the sort key for a cross-community listing. */
  lastActivityAt: z.string().min(1),
  /**
   * `null` means "not applicable here", never "nothing unread". Any badge,
   * digest or notification must gate on `readCursor === 'server'` or render
   * nothing — and must never render `0`, because a silent room and a room whose
   * unread cannot be computed are different states.
   */
  unreadCount: z.number().int().min(0).nullable(),
});
/** One room in one community. See {@link CommunityRoomSchema}. */
export type CommunityRoom = z.infer<typeof CommunityRoomSchema>;

/**
 * One member of one room.
 *
 * `role`, `responseMode` and `ownerMemberId` are the three fields a capability
 * governs: `role` is `null` unless `roles.supported`, `responseMode` is absent
 * unless the `responseMode` flag is on, and `ownerMemberId` is non-null only
 * for an agent admitted under `agentAdmission: 'owner-vouched'`.
 */
export const CommunityMemberSchema = z.object({
  /** The community that minted this member id. */
  community: CommunityRefSchema,
  /** Opaque member id, as this community knows it. */
  memberId: z.string().min(1),
  /** Human, agent, or the room itself talking. Reused from the rooms model, not forked. */
  kind: AuthorKindSchema,
  /** Render cache — what a roster row shows. */
  displayName: z.string().min(1),
  /**
   * This member's address in this community: what somebody types after an `@`
   * to reach them, or `null` when nothing does.
   *
   * **Not local-only.** A handle is what makes a mention resolvable at all, and
   * a backend whose roster cannot say what reaches a member forces every reader
   * to guess from the display name — which is exactly the failure this field
   * exists to remove. `null` is the honest answer for a backend whose roster
   * event carries no handle, and it is a real state for a local member too: a
   * person who has not chosen one yet has none.
   */
  handle: z.string().nullable(),
  /** Render cache. */
  emoji: z.string().optional(),
  /** Render cache. */
  color: z.string().optional(),
  /**
   * Render cache: this member's photo, when the backend has one for them.
   *
   * The fourth field beside `displayName`, `emoji` and `color`, added the same
   * additive way `responseMode` was — a photo does not replace an emoji, it
   * sits next to it and the renderer picks. Used exactly as the backend gives
   * it: a local community returns a server-relative path and a remote one
   * returns its own absolute URL, so nothing reading this may join a directory
   * or assume the bytes are on this machine.
   */
  imageUrl: z.string().optional(),
  /**
   * A declared `roles.values[].id`, or `null` when this backend has no roles.
   * The product branches on the descriptor's `administers`/`isOwner`, never on
   * this string.
   */
  role: z.string().nullable(),
  /** Present only when the `responseMode` capability is on. */
  responseMode: ResponseModeSchema.optional(),
  /**
   * The member who vouched for this one, for an agent admitted under
   * `agentAdmission: 'owner-vouched'`; `null` for anyone else.
   *
   * It exists so a community server CAN key a quota per owner rather than per
   * identity — the hole a relay leaves open when N agents each buy their own
   * budget. Not enforced by this port.
   */
  ownerMemberId: z.string().nullable(),
  /** ISO 8601. */
  joinedAt: z.string().min(1),
});
/** One member of one room. See {@link CommunityMemberSchema}. */
export type CommunityMember = z.infer<typeof CommunityMemberSchema>;

/**
 * Rolled-up state of one thread, synthesized rather than stored. The same
 * object our "N replies" projection already renders, and the same object Buzz
 * synthesizes at query time — two designs converging on it is good evidence the
 * seam is right.
 */
export const CommunityThreadSummarySchema = z.object({
  /** Replies below the root. Never counts the root itself. */
  replyCount: z.number().int().min(0),
  /** ISO 8601 timestamp of the newest reply. */
  lastReplyAt: z.string().min(1),
});
/** Rolled-up state of one thread. See {@link CommunityThreadSummarySchema}. */
export type CommunityThreadSummary = z.infer<typeof CommunityThreadSummarySchema>;

/**
 * One durable entry in one room.
 *
 * **A thread is a relation between entries**, at every depth and on every
 * backend; only the ceiling differs (`threadDepth`). There is no `seq`: two
 * invariants take its place, and both are conformance-asserted — order is the
 * adapter's emission order (history oldest-first, live in commit order, and
 * `createdAt` is for display and never for sorting, because a wall clock can
 * tie or skew), and **dedupe is by `id`, never by cursor**.
 */
export const CommunityEntrySchema = RoomAddressSchema.extend({
  /** Stable, unique within the room. The dedupe key, and what a reaction would attach to. */
  id: z.string().min(1),
  /**
   * Whoever wrote this — the same id space as
   * {@link CommunityMember.memberId}. An entry authored by an agent NEVER
   * carries its owner's id; it is the cheapest invariant to lose and the
   * conformance suite asserts it.
   */
  authorId: z.string().min(1),
  /** What was said. */
  text: z.string(),
  /**
   * Member ids resolved from `@name` at write time, never re-parsed by a
   * consumer. Carried because `responseMode: 'mention-only'` is unusable
   * without it.
   */
  mentions: z.array(z.string()),
  /** The entry in this same room this one answers, or `null` at top level. */
  parentEntryId: z.string().nullable(),
  /** The entry at the head of this entry's thread, or `null` when top-level. */
  threadRootEntryId: z.string().nullable(),
  /** `0` for top-level; greater than `1` only when `threadDepth === 'unbounded'`. */
  depth: z.number().int().min(0),
  /** Present on a thread root that has replies. */
  thread: CommunityThreadSummarySchema.optional(),
  /** The cursor that resumes AFTER this entry. What replaces a numeric `seq`. */
  cursor: CommunityCursorSchema,
  /** ISO 8601. For display, never for sorting. */
  createdAt: z.string().min(1),
});
/** One durable entry in one room. See {@link CommunityEntrySchema}. */
export type CommunityEntry = z.infer<typeof CommunityEntrySchema>;

/**
 * A page of history, oldest-first within the page.
 *
 * Exhaustion is **declared, never inferred**. Banked directly from Buzz, whose
 * own window-bounds doc says its overlay is "the only authority on exhaustion —
 * clients must not infer `has_more` from row counts", and whose page limit is
 * clamped server-side, so a short page is routine.
 */
export const CommunityEntryPageSchema = z.object({
  /** This page's entries, oldest-first. */
  entries: z.array(CommunityEntrySchema),
  /** `null` is the ONLY authority on exhaustion. Callers MUST NOT infer "no more" from `entries.length < limit`. */
  nextCursor: CommunityCursorSchema.nullable(),
});
/** A page of history. See {@link CommunityEntryPageSchema}. */
export type CommunityEntryPage = z.infer<typeof CommunityEntryPageSchema>;

/** The receipt of a committed entry — its address plus the cursor that resumes after it. */
export const CommunityEntryRefSchema = RoomAddressSchema.extend({
  /** The committed entry's id. */
  entryId: z.string().min(1),
  /** The cursor that resumes after it, so a poster can subscribe without a round-trip. */
  cursor: CommunityCursorSchema,
});
/** The receipt of a committed entry. See {@link CommunityEntryRefSchema}. */
export type CommunityEntryRef = z.infer<typeof CommunityEntryRefSchema>;

// ---------------------------------------------------------------------------
// 5. Inputs
// ---------------------------------------------------------------------------

/** What {@link CommunityAdapter.createRoom} needs. Gated on `roomAdmin`. */
export const CreateCommunityRoomInputSchema = z.object({
  /** Channel or direct message. Defaults to a channel. */
  kind: RoomKindSchema.default('channel'),
  /** Human-facing room name. */
  title: z.string().min(1),
  /** Requested `#name`. Ignored by a `roomAddressing: 'opaque-id'` backend. */
  slug: z.string().min(1).optional(),
  /** Room description. */
  topic: z.string().optional(),
});
/** Input to `createRoom`. See {@link CreateCommunityRoomInputSchema}. */
export type CreateCommunityRoomInput = z.input<typeof CreateCommunityRoomInputSchema>;

/** What {@link CommunityAdapter.updateRoom} may change. Gated on `roomAdmin`. */
export const UpdateCommunityRoomInputSchema = z.object({
  /** New name. */
  title: z.string().min(1).optional(),
  /** New description; `null` clears it. */
  topic: z.string().nullable().optional(),
  /** Archive or restore. An archived room still reads. */
  archived: z.boolean().optional(),
});
/** Input to `updateRoom`. See {@link UpdateCommunityRoomInputSchema}. */
export type UpdateCommunityRoomInput = z.infer<typeof UpdateCommunityRoomInputSchema>;

/**
 * What {@link CommunityAdapter.listEntries} reads.
 *
 * `thread` omitted returns TOP-LEVEL entries only; `thread: <entryId>` returns
 * that thread's replies. This is Buzz's own top-level filter shape and our
 * thread read, expressed once.
 */
export const ListCommunityEntriesOptsSchema = z.object({
  /** Resume point; the page starts after this. Omit for the oldest page. */
  cursor: CommunityCursorSchema.optional(),
  /** Page size hint. An adapter may return fewer — see {@link CommunityEntryPageSchema}. */
  limit: z.number().int().positive().optional(),
  /** Omitted → top-level entries only. Set → that thread's replies. */
  thread: z.string().min(1).optional(),
});
/** Read options for `listEntries`. See {@link ListCommunityEntriesOptsSchema}. */
export type ListCommunityEntriesOpts = z.infer<typeof ListCommunityEntriesOptsSchema>;

/** What {@link CommunityAdapter.post} commits. Gated on `canPost`. */
export const PostCommunityEntryInputSchema = z.object({
  /** What to say. */
  text: z.string().min(1),
  /** Set to make this a threaded reply. Refused when it would exceed `threadDepth`. */
  parentEntryId: z.string().min(1).optional(),
  /** Member ids the writer addressed. Resolved by the caller, not re-parsed by the adapter. */
  mentions: z.array(z.string()).optional(),
});
/** Input to `post`. See {@link PostCommunityEntryInputSchema}. */
export type PostCommunityEntryInput = z.infer<typeof PostCommunityEntryInputSchema>;

/** Options for {@link CommunityAdapter.addMember}. Gated on `roomAdmin`. */
export const AddCommunityMemberOptsSchema = z.object({
  /** A declared `roles.values[].id`. Defaults to `roles.default`. */
  role: z.string().min(1).optional(),
  /** Per-room agent addressing override. Requires the `responseMode` capability. */
  responseMode: ResponseModeSchema.optional(),
});
/** Options for `addMember`. See {@link AddCommunityMemberOptsSchema}. */
export type AddCommunityMemberOpts = z.infer<typeof AddCommunityMemberOptsSchema>;

/**
 * What {@link CommunityAdapter.admitAgent} needs. Gated on
 * `agentAdmission: 'owner-vouched'`.
 *
 * It deliberately carries **no agent-side consent field**: only a member adds
 * their own agents, so there is no third party to refuse, and an agent does not
 * get to decline its owner. What an agent may do is ask to leave, by posting,
 * like anyone else in the room. It carries no filesystem path either — no path
 * crosses this port.
 */
export const AdmitAgentInputSchema = z.object({
  /** The agent's opaque local id. The idempotency key: admitting twice mints one identity. */
  agentId: z.string().min(1),
  /** What the roster shows for it. */
  displayName: z.string().min(1),
  /** Render cache. */
  emoji: z.string().optional(),
  /** Render cache. */
  color: z.string().optional(),
});
/** Input to `admitAgent`. See {@link AdmitAgentInputSchema}. */
export type AdmitAgentInput = z.infer<typeof AdmitAgentInputSchema>;

/**
 * What {@link CommunityAdapter.createInvite} mints. Gated on `invite`.
 *
 * A `'community'`-scoped backend given a `roomId` REFUSES rather than silently
 * widening: "offer a specific person a specific room" and "admit someone to the
 * community" are different acts with different consent semantics.
 */
export const CreateCommunityInviteInputSchema = z.object({
  /** Room to scope the invite to. Requires `invite: 'room'`. */
  roomId: z.string().min(1).optional(),
  /** ISO 8601 expiry the caller wants; an adapter may shorten it. */
  expiresAt: z.string().min(1).optional(),
});
/** Input to `createInvite`. See {@link CreateCommunityInviteInputSchema}. */
export type CreateCommunityInviteInput = z.infer<typeof CreateCommunityInviteInputSchema>;

/**
 * A minted invite — a token meant to be handed to someone else.
 *
 * It is not a credential of ours and carries none: an adapter's own credential
 * never appears here, which the conformance suite checks mechanically.
 */
export const CommunityInviteSchema = z.object({
  /** The community this admits to. */
  community: CommunityRefSchema,
  /** The room this admits to, or `null` for a community-wide invite. */
  roomId: z.string().min(1).nullable(),
  /** The redeemable token. */
  token: z.string().min(1),
  /** A link the recipient can open, when the backend has one. */
  url: z.string().min(1).optional(),
  /** ISO 8601, or `null` when the invite does not expire. */
  expiresAt: z.string().min(1).nullable(),
});
/** A minted invite. See {@link CommunityInviteSchema}. */
export type CommunityInvite = z.infer<typeof CommunityInviteSchema>;

// ---------------------------------------------------------------------------
// 6. Connection and admission
// ---------------------------------------------------------------------------

/**
 * The result of {@link CommunityAdapter.connect}.
 *
 * **Failure is TYPED on the result, never thrown** — callers branch on
 * `status`, they do not catch. Whether a deployment admits our key is a
 * per-deployment fact we cannot discover before trying, so "an operator must
 * admit you" is a normal, user-actionable outcome rather than a programming
 * error.
 *
 * Four statuses and not a boolean, because collapsing them produces the worst
 * available UX: a person told to check a credential they cannot see, for a
 * machine-managed key that is in fact perfectly valid.
 *
 * **`'not-admitted'` invalidates that community's cached rooms.** This is
 * normative, not a cache's discretion: a member who was removed and a member
 * who was never let in reach the same status on their next `connect()`, so one
 * rule covers both and is a no-op for the second. The other three statuses
 * deliberately do NOT invalidate — `'unreachable'` says nothing about
 * membership and the cache is what makes an install readable while a host is
 * down, and `'unauthorized'` carries a ban indistinguishably from an expiry, so
 * acting on it would discard a correct cache on a re-authentication. Nothing
 * leaks by the asymmetry, because the cache is never the access boundary: every
 * adapter re-checks membership on read, so a stale row renders and then
 * refuses.
 */
export const CommunityConnectionSchema = z
  .object({
    /**
     * - `'connected'` — reading and (if `canPost`) writing.
     * - `'not-admitted'` — the credential is VALID and this community has not
     *   admitted it. An operator action is required and there is no in-protocol
     *   way to ask.
     * - `'unauthorized'` — the credential is wrong, expired, rejected, or banned.
     * - `'unreachable'` — the host did not answer.
     */
    status: z.enum(['connected', 'not-admitted', 'unauthorized', 'unreachable']),
    /** The connected identity as this community knows it. Present iff `'connected'`. */
    identity: CommunityMemberRefSchema.optional(),
    /**
     * Plain-language "what happens next", REQUIRED on `'not-admitted'` — e.g.
     * "Ask whoever runs this community to let you in; there is no way to request
     * it from here." Never a raw protocol string.
     */
    disclosure: z.string().min(1).optional(),
    /** Diagnostic detail for the log, present on any non-connected status. Never rendered raw. */
    error: z.string().min(1).optional(),
  })
  .superRefine((connection, ctx) => {
    // "REQUIRED on 'not-admitted'" is enforced, not merely documented. This is
    // the one status whose whole point is that the person can act on it, and the
    // disclosure is the only thing that tells them how — a surface with nothing
    // to render would show an empty state where the next step belongs.
    if (connection.status === 'not-admitted' && !connection.disclosure) {
      ctx.addIssue({
        code: 'custom',
        path: ['disclosure'],
        message: "a 'not-admitted' connection must carry a plain-language disclosure",
      });
    }
  });
/** The result of `connect`. See {@link CommunityConnectionSchema}. */
export type CommunityConnection = z.infer<typeof CommunityConnectionSchema>;

// ---------------------------------------------------------------------------
// 7. Streams
// ---------------------------------------------------------------------------

/** Room lifecycle, as {@link CommunityAdapter.subscribeRoomList} reports it. */
export const CommunityRoomListEventSchema = z.discriminatedUnion('type', [
  z.object({
    /** A room entered this identity's view. */
    type: z.literal('room_added'),
    /** The new room. */
    room: CommunityRoomSchema,
  }),
  z.object({
    /** A room this identity can see changed (renamed, re-topiced, archived). */
    type: z.literal('room_updated'),
    /** The room's new state. */
    room: CommunityRoomSchema,
  }),
  z.object({
    /** A room left this identity's view — ejected, or the community went private. */
    type: z.literal('room_removed'),
    /** The community the room was in. */
    community: CommunityRefSchema,
    /** The room that is gone. */
    roomId: z.string().min(1),
  }),
]);
/** Room lifecycle event. See {@link CommunityRoomListEventSchema}. */
export type CommunityRoomListEvent = z.infer<typeof CommunityRoomListEventSchema>;

/**
 * Why a room stopped being servable mid-subscription.
 *
 * An adapter MUST NOT guess. Buzz emits one reason string from two different
 * causes — archiving a channel evicts every live subscription, and an
 * open-to-private flip evicts non-members the same way — so an adapter that
 * reads it as "archived" would tell a member who just lost access that the room
 * was put away. `'unknown'` exists so an adapter can be honest instead of
 * confident.
 */
export const CommunityRoomClosedReasonSchema = z.enum(['archived', 'access-revoked', 'unknown']);
/** Why a room stopped being servable. See {@link CommunityRoomClosedReasonSchema}. */
export type CommunityRoomClosedReason = z.infer<typeof CommunityRoomClosedReasonSchema>;

/**
 * The room-presence lifecycle a `'progress'` signal carries (spec
 * `room-presence`).
 *
 * The shape mirrors the relay's own signal envelope (`state` + `data`), so the
 * port is not inventing a second vocabulary — it is carrying the one the relay
 * already has. Adapters map it to their native idiom and MUST NOT persist it.
 *
 * `state` is {@link RoomPresenceStateSchema}, shared with the rooms wire rather
 * than restated, so the two can never drift apart. **Everything else here is
 * optional where the rooms event requires it, deliberately**: a local room is the
 * producer and always knows which entry is being worked on and since when, while
 * a remote backend may only be able to say that somebody is working. Read the
 * difference as the capability floor, not as this payload lagging behind.
 */
export const CommunityPresencePayloadSchema = z.object({
  /** Where in the claim lifecycle the emitter is. */
  state: RoomPresenceStateSchema,
  /** Who is working — the emitting side's member for that room. */
  memberId: z.string().min(1).optional(),
  /** The entry being worked on. */
  entryId: z.string().min(1).optional(),
  /** ISO 8601 — when the claim was taken. */
  since: z.string().min(1).optional(),
});
/** The presence payload a `'progress'` signal carries. See {@link CommunityPresencePayloadSchema}. */
export type CommunityPresencePayload = z.infer<typeof CommunityPresencePayloadSchema>;

/** Everything that travels on one room's stream. */
export const CommunityRoomEventSchema = z.discriminatedUnion('type', [
  z.object({
    /** The hydration frame a subscription opens with, before any entry. */
    type: z.literal('snapshot'),
    /** The room, as of the snapshot. */
    room: CommunityRoomSchema,
    /** Recent entries, oldest-first. */
    entries: z.array(CommunityEntrySchema),
    /** The cursor the live subscription resumes from. */
    cursor: CommunityCursorSchema,
  }),
  z.object({
    /** A committed entry arriving live. */
    type: z.literal('entry'),
    /** The entry. */
    entry: CommunityEntrySchema,
  }),
  z.object({
    /** An ephemeral signal. Delivered live, dropped on replay, never durable. */
    type: z.literal('signal'),
    /** Which signal. */
    signal: SignalTypeSchema,
    /** Who emitted it. */
    memberId: z.string().min(1),
    /** ISO 8601. */
    at: z.string().min(1),
    /** The room-presence lifecycle, on a `'progress'` signal. */
    payload: CommunityPresencePayloadSchema.optional(),
  }),
  z.object({
    /**
     * Terminal. A room that becomes unservable mid-subscription says so on the
     * stream — never a thrown error, never a silent end.
     */
    type: z.literal('room_closed'),
    /** Why, honestly. */
    reason: CommunityRoomClosedReasonSchema,
  }),
]);
/** Everything that travels on one room's stream. See {@link CommunityRoomEventSchema}. */
export type CommunityRoomEvent = z.infer<typeof CommunityRoomEventSchema>;

// ---------------------------------------------------------------------------
// 8. Degradation
// ---------------------------------------------------------------------------

/**
 * One community that could not contribute to a listing (ADR-0310's shape, with
 * the nouns changed).
 *
 * The `label` is here and on no other payload but
 * {@link CommunityDescriptorSchema}: a warning is the one place the community is
 * itself the subject, so it must be renderable without a lookup back into the
 * registry.
 */
export const CommunityWarningSchema = z.object({
  /** The community that degraded. */
  community: CommunityRefSchema,
  /** {@link CommunityDescriptor.label} — what a person calls this community. */
  label: z.string().min(1),
  /** Plain language, already safe to render. A `'not-admitted'` community carries its `disclosure` here. */
  message: z.string().min(1),
});
/** One community that could not contribute to a listing. See {@link CommunityWarningSchema}. */
export type CommunityWarning = z.infer<typeof CommunityWarningSchema>;

// ---------------------------------------------------------------------------
// 9. Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown EAGERLY by {@link CommunityAdapter.subscribeRoom} when a cursor cannot
 * be served gap-free — it belongs to a different room or community, or it is
 * from a superseded epoch. Callers MUST catch it and fall back to a cold
 * snapshot.
 *
 * "Eagerly" is load-bearing and is asserted by construction: the throw must
 * happen at call time, before the first `next()`. An adapter whose
 * `subscribeRoom` is an `async function*` cannot satisfy that — the body does
 * not run until the first pull — so validate the cursor in a plain method and
 * return a generator from it.
 */
export class StaleCommunityCursorError extends Error {
  /**
   * Build a refusal naming the cursor that could not be served, and why.
   *
   * @param community - The community whose resume was rejected.
   * @param roomId - The room whose resume was rejected.
   * @param reason - Plain-language detail for the log (e.g. `'cursor belongs to another room'`).
   */
  constructor(
    readonly community: CommunityRef,
    readonly roomId: string,
    readonly reason: string
  ) {
    super(`Cursor for room '${roomId}' in community '${community}' cannot be served: ${reason}`);
    this.name = 'StaleCommunityCursorError';
  }
}

/**
 * Thrown EAGERLY by {@link CommunityAdapter.subscribeRoom} when `roomId` is not
 * a room this identity can stream — it does not exist, or it exists and is not
 * visible here.
 *
 * **Those two cases throw the identical refusal**, which is why this class takes
 * no `reason` parameter where the other two errors do: a room id is an address,
 * not an authorization, and any detail that told them apart would let anyone
 * holding an id confirm that somebody else's direct message exists. The shipped
 * `requireVisibleRoom` collapses them for exactly this reason, and an adapter
 * MUST NOT widen the message with a cause.
 *
 * "Eagerly" carries the same weight it does on
 * {@link StaleCommunityCursorError}, and the conformance suite asserts it the
 * same way — by construction, awaiting nothing. Check the room before returning
 * the generator; an `async function*` cannot satisfy it. Check it **before the
 * cursor** as well — {@link CommunityAdapter.subscribeRoom} states why that
 * order is part of the contract rather than an implementation detail.
 *
 * **Why `getRoom` answers `null` and this throws.** The asymmetry is in what
 * each return type can express, not in what either discloses. A method whose
 * return type has an empty value uses it: `getRoom` answers `null`,
 * `listMembers` an empty roster, `listEntries` an empty page. `subscribeRoom`
 * returns a stream, and no stream means "no room" — every ROOM stream this port
 * hands out opens with a snapshot OF a room (`subscribeRoomList` is a different
 * stream with no snapshot at all, and no room to be about).
 * Each alternative is worse than throwing:
 * an immediate `room_closed` would report that a room went away to a caller that
 * never had one, and would make the terminal event ambiguous between "you lost
 * it" and "there was never one"; a stream that simply never yields is
 * indistinguishable from a quiet room, so the caller parks forever — the very
 * failure the eager cursor throw exists to prevent; and a nullable return would
 * put a null check at every call site for a case the caller must ALSO handle as
 * a throw, since a room can vanish between `getRoom` and `subscribeRoom`. What
 * never differs across those shapes is what the caller learns about WHY:
 * unknown and invisible are indistinguishable on every one of them.
 */
export class CommunityRoomNotFoundError extends Error {
  /**
   * Build the refusal, naming only the address that could not be streamed.
   *
   * @param community - The community that refused.
   * @param roomId - The room that is not available to this identity. Whether it
   *   is absent or merely invisible is deliberately not reported.
   */
  constructor(
    readonly community: CommunityRef,
    readonly roomId: string
  ) {
    super(`Room '${roomId}' is not available in community '${community}'`);
    this.name = 'CommunityRoomNotFoundError';
  }
}

/**
 * Thrown when a method is handed a `memberId` this community has nobody for —
 * unknown, or known and not in the room the call names.
 *
 * **Those two cases throw the identical refusal**, and this class takes no
 * `reason` parameter for the same argument {@link CommunityRoomNotFoundError}
 * makes at length: a member id is an address, not an authorization, and any
 * detail that told them apart would let anyone holding an id confirm who is in a
 * room they cannot see.
 *
 * It exists because the alternative was every backend inventing its own answer.
 * The methods that need it — {@link CommunityAdapter.setResponseMode}, and
 * {@link CommunityAdapter.publishSignal} on a backend whose members are its own
 * install's identities — were rejecting with backend-native errors that no
 * out-of-process consumer could match on except by duck-typing a `.code`. A
 * third backend would have written a third answer.
 *
 * **`removeMember` deliberately does NOT throw it.** That method is contractually
 * idempotent: removing somebody who is not there is the outcome the caller asked
 * for, not a refusal.
 */
export class CommunityMemberNotFoundError extends Error {
  /**
   * Build the refusal, naming only the address that could not be resolved.
   *
   * @param community - The community that refused.
   * @param memberId - The member this community has nobody for. Whether they are
   *   unknown or merely not in the room is deliberately not reported.
   */
  constructor(
    readonly community: CommunityRef,
    readonly memberId: string
  ) {
    super(`Member '${memberId}' is not available in community '${community}'`);
    this.name = 'CommunityMemberNotFoundError';
  }
}

/**
 * Rejected by any capability-gated method whose capability is off. Never a
 * silent no-op and never a partial write — a required method with a typed
 * refusal is what an optional method cannot be: visible to the compiler and
 * checkable by the conformance suite.
 */
export class CommunityUnsupportedError extends Error {
  /**
   * Build a refusal naming the capability that gated it and the method it gates.
   *
   * @param community - The community that refused.
   * @param capability - The capability that gated the call, e.g. `'canPost'`.
   * @param method - The method that was called, e.g. `'post'`.
   * @param reason - What is actually wrong, when "the capability is off" would
   *   be untrue. A `'community'`-scoped backend refusing a room-scoped invite is
   *   the case this exists for: `invite` is not off, it is a narrower scope than
   *   the caller asked for, and a message saying otherwise would send a reader
   *   looking for a flag that is already set.
   */
  constructor(
    readonly community: CommunityRef,
    readonly capability: CommunityGatedCapability,
    readonly method: string,
    readonly reason?: string
  ) {
    super(
      `'${method}' is not supported by community '${community}': ${
        reason ?? `capability '${capability}' is off`
      }`
    );
    this.name = 'CommunityUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// 10. The port
// ---------------------------------------------------------------------------

/**
 * Universal contract for a community backend — the fourth swappable seam beside
 * `AgentRuntime`, `Transport` and `ConnectorProvider`. Local rooms, a Buzz relay
 * and `apps/community` each implement it; `communityConformance` gates every
 * one.
 *
 * Why every method earns its place: `connect`/`disconnect` are the admission
 * boundary; `listRooms`/`getRoom`/`subscribeRoomList` are discovery, with the
 * poll/push difference absorbed inside `subscribeRoomList` so the consumer never
 * forks; `subscribeRoom`/`listEntries` are the durable stream, split exactly as
 * the shipped room API splits its event stream from its entry list; `post` is
 * the one write every non-read-only backend has; the roster four are the
 * membership surface; `admitAgent`/`revokeAgent` are kept separate from
 * `addMember` because minting an identity and putting it in a room are two acts;
 * read cursor and invite are two of the four backend mismatches this port
 * exists to absorb; and `publishSignal` reuses the relay's signal vocabulary
 * rather than forking it.
 */
export interface CommunityAdapter {
  /** Adapter type identifier; must equal `getCapabilities().type`. */
  readonly type: string;
  /** The one community this instance serves. Every address it emits carries this. */
  readonly community: CommunityRef;

  /** Return this backend's static capability descriptor. */
  getCapabilities(): CommunityCapabilities;

  // --- Connection ----------------------------------------------------------

  /**
   * Establish the adapter's own connection, resolving its credential from the
   * server-side store — a credential is NEVER passed across this port.
   *
   * Failure is TYPED on the result, never thrown: whether a deployment admits
   * us is a per-deployment fact we cannot discover before trying, and "an
   * operator must admit you" is a user-actionable outcome rather than a bug.
   *
   * @param signal - Aborts a connect attempt that is taking too long.
   */
  connect(signal?: AbortSignal): Promise<CommunityConnection>;

  /** Tear down. Idempotent — disconnecting a never-connected adapter resolves. */
  disconnect(): Promise<void>;

  // --- Rooms ---------------------------------------------------------------

  /** Every room this identity may see. NEVER includes a thread — threads are entry-level. */
  listRooms(): Promise<CommunityRoom[]>;

  /**
   * One room, or `null` when it does not exist or is not visible to this
   * identity. Never throws for either: a room id is an address, not an
   * authorization, and reporting the two apart would let a probe distinguish
   * them.
   *
   * {@link CommunityAdapter.subscribeRoom} answers the same pair by throwing
   * {@link CommunityRoomNotFoundError}, and is no more forthcoming about which
   * of the two holds — only the shape of the answer differs, because a stream
   * has no empty value the way a nullable room does.
   *
   * @param roomId - The room's id within this community.
   */
  getRoom(roomId: string): Promise<CommunityRoom | null>;

  /**
   * Room lifecycle as a stream. A `roomList: 'poll'` adapter satisfies this by
   * polling at its declared interval — the difference is latency, not shape, so
   * the consumer has one code path. The adapter polls once per community and
   * fans out internally: N subscribers must not become N polls.
   *
   * @param signal - Aborts the stream so a parked consumer terminates promptly.
   */
  subscribeRoomList(signal?: AbortSignal): AsyncIterable<CommunityRoomListEvent>;

  /**
   * Create a room. Gated on `roomAdmin`; otherwise rejects with
   * {@link CommunityUnsupportedError}.
   *
   * @param input - The room to create.
   */
  createRoom(input: CreateCommunityRoomInput): Promise<CommunityRoom>;

  /**
   * Rename, re-topic or archive a room. Gated on `roomAdmin`. An archived room
   * still reads; archiving is not a delete.
   *
   * @param roomId - The room to change.
   * @param patch - The fields to change.
   */
  updateRoom(roomId: string, patch: UpdateCommunityRoomInput): Promise<CommunityRoom>;

  // --- Entries -------------------------------------------------------------

  /**
   * The durable stream for one room: snapshot → gap-free replay → live.
   *
   * Throws {@link StaleCommunityCursorError} EAGERLY (at call time, before any
   * iteration) when `sinceCursor` cannot be served gap-free. Callers MUST catch
   * it and fall back to a cold snapshot. Gap-free-or-throw is universal, not
   * capability-gated: there is no flag that lets an adapter offer a weaker
   * resume.
   *
   * Throws {@link CommunityRoomNotFoundError} EAGERLY, by that same discipline,
   * when `roomId` is not a room this identity can stream — unknown and invisible
   * alike, indistinguishably. `getRoom` answers `null` for the same pair; the
   * asymmetry is in what each return type can express and not in what either
   * discloses, which {@link CommunityRoomNotFoundError} argues in full.
   *
   * **The room is checked BEFORE the cursor, and the order is contractual.** A
   * cursor's validity is usually a function of the room's own state — an adapter
   * that bounds a resume against what a room holds finds nothing to bound
   * against in a room that is not there — so an adapter that validated the
   * cursor first answers {@link StaleCommunityCursorError} for a room that does
   * not exist and {@link CommunityRoomNotFoundError} for one that exists and is
   * hidden. Two typed refusals that differ IS the probe the identical message
   * closes, re-opened one line earlier. Neither error's message can leak it;
   * only the order can.
   *
   * A room that becomes unservable mid-subscription yields a terminal
   * `room_closed` event — never a thrown error, never a silent end. That is a
   * room this stream WAS serving; the refusal above is a room it never could.
   *
   * @param roomId - The room to stream.
   * @param sinceCursor - Resume point; emit only what follows it.
   * @param signal - Aborts the stream so a parked consumer terminates promptly.
   */
  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal
  ): AsyncIterable<CommunityRoomEvent>;

  /**
   * A page of history, oldest-first within the page.
   *
   * @param roomId - The room to read.
   * @param opts - Cursor, page size, and the thread filter.
   */
  listEntries(roomId: string, opts?: ListCommunityEntriesOpts): Promise<CommunityEntryPage>;

  /**
   * Commit an entry. Gated on `canPost`. `parentEntryId` makes it a threaded
   * reply, and a `threadDepth: 1` backend refuses a reply to an entry that is
   * already inside a thread rather than flattening it.
   *
   * @param roomId - The room to post into.
   * @param input - What to say, and what it replies to.
   */
  post(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntryRef>;

  // --- Roster --------------------------------------------------------------

  /**
   * A room's members. Universal — all three backends enumerate a roster, so
   * there is no `hasRoster` flag; what differs is roles, and those have one.
   * An unknown or invisible room returns `[]`, never a throw.
   *
   * @param roomId - The room whose roster to read.
   */
  listMembers(roomId: string): Promise<CommunityMember[]>;

  /**
   * Add an existing community member to a room. Gated on `roomAdmin`.
   *
   * @param roomId - The room to add them to.
   * @param memberId - The member to add.
   * @param opts - Role and per-room addressing override.
   */
  addMember(
    roomId: string,
    memberId: string,
    opts?: AddCommunityMemberOpts
  ): Promise<CommunityMember>;

  /**
   * Remove a member from a room. Gated on `roomAdmin` (or the member's own
   * owner). Idempotent — removing someone who is not in the room resolves.
   *
   * @param roomId - The room to remove them from.
   * @param memberId - The member to remove.
   */
  removeMember(roomId: string, memberId: string): Promise<void>;

  /**
   * Set a membership's per-room agent addressing override. Gated on
   * `responseMode`.
   *
   * Rejects with {@link CommunityMemberNotFoundError} when `memberId` names
   * nobody this room holds — unknown and merely-absent alike, indistinguishably.
   * The capability refusal comes first: a backend with no addressing override at
   * all has no roster question to answer.
   *
   * @param roomId - The room the override applies to.
   * @param memberId - Whose membership to change.
   * @param mode - The addressing mode.
   */
  setResponseMode(roomId: string, memberId: string, mode: ResponseMode): Promise<CommunityMember>;

  // --- Agent admission -----------------------------------------------------

  /**
   * Mint this agent's OWN identity in the community, vouched for by the
   * connected member. Gated on `agentAdmission: 'owner-vouched'`. Idempotent per
   * agent.
   *
   * Three properties are contractual, not incidental: the returned member's
   * `ownerMemberId` is the connected identity; its role NEVER administers,
   * whatever its owner's role is; and its admission is DERIVED from its owner's,
   * re-evaluated on use rather than copied into a row a cleanup job must find.
   * Removing the human removes their agents; the agent inherits none of its
   * owner's powers; an admin can eject an agent without removing its owner.
   *
   * @param input - The agent to vouch for.
   */
  admitAgent(input: AdmitAgentInput): Promise<CommunityMember>;

  /**
   * Revoke an agent's community identity entirely. Gated on
   * `agentAdmission: 'owner-vouched'`. Idempotent.
   *
   * @param memberId - The agent member to revoke.
   */
  revokeAgent(memberId: string): Promise<void>;

  // --- Read cursor ---------------------------------------------------------

  /**
   * The connected identity's own read cursor for one room, or `null` when none
   * is set. Gated on `readCursor !== 'none'`.
   *
   * @param roomId - The room whose cursor to read.
   */
  getReadCursor(roomId: string): Promise<CommunityCursor | null>;

  /**
   * Set the connected identity's own read cursor. Gated on
   * `readCursor !== 'none'`. Under `'client-opaque'` the backend stores a blob
   * only this member can read, so a server-computed unread count is impossible
   * and no other member's cursor exists even in principle.
   *
   * @param roomId - The room whose cursor to set.
   * @param cursor - Where this identity has read to.
   */
  setReadCursor(roomId: string, cursor: CommunityCursor): Promise<void>;

  // --- Invites -------------------------------------------------------------

  /**
   * Mint an invite. Gated on `invite !== 'none'`.
   *
   * A `'community'`-scoped backend given a `roomId` REFUSES with
   * {@link CommunityUnsupportedError}. It must not silently widen to a community
   * invite and must not substitute "an admin adds you": those are different acts
   * with different consent semantics, and papering over the difference is
   * exactly the weakening this port exists to prevent.
   *
   * @param input - What the invite should admit to.
   */
  createInvite(input: CreateCommunityInviteInput): Promise<CommunityInvite>;

  // --- Ephemeral -----------------------------------------------------------

  /**
   * Emit an ephemeral signal. Gated on `signals: 'both'`. Live only; never
   * durable.
   *
   * `payload` carries the room-presence lifecycle when `signal === 'progress'`:
   * who is working, on which entry, since when, and in which phase. Adapters map
   * it to their native idiom and MUST NOT persist it. Who may call this — the
   * rule that a presence signal exists only while a real claim is held — is
   * enforced at the producer that owns the claim, not here: a port-level fake
   * cannot know whether a claim was real.
   *
   * `payload.memberId` is deliberately unvalidated AT THIS PORT, because a
   * backend with a foreign identity model has nothing to check it against. An
   * adapter whose members ARE this install's own identities owes the check
   * itself: whatever this field says is what every subscriber will be shown as
   * "who is working", so an id naming nobody must be refused — with
   * {@link CommunityMemberNotFoundError} — rather than published or silently
   * re-attributed to the caller.
   *
   * @param roomId - The room to signal in.
   * @param signal - Which signal.
   * @param payload - The presence lifecycle, on a `'progress'` signal.
   */
  publishSignal(
    roomId: string,
    signal: SignalType,
    payload?: CommunityPresencePayload
  ): Promise<void>;
}
