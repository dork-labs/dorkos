/**
 * Runtime-neutral additional-context model (ADR-0273).
 *
 * The canonical, backend-agnostic representation of per-turn context DorkOS
 * attaches to a message. Entries carry STRUCTURED `data` — never pre-formatted
 * prose — so any runtime adapter can render them in whatever shape its backend
 * expects. The server owns WHAT context exists (the assembler); each adapter
 * owns HOW it is rendered (e.g. the Claude adapter's `renderContextEntry`).
 *
 * Two layers exist:
 * - {@link ClientContext}: the thin client-sourced signal bag (ui_state, queued)
 *   sent on the wire. The client contributes only what it knows.
 * - {@link AdditionalContext}: the server-assembled, fully-derived entry list the
 *   runtime receives. The server derives git_status/env and normalizes the
 *   client signals into discriminated {@link AdditionalContextEntry} members.
 *
 * @module shared/additional-context
 */
import { z } from 'zod';
import { ResponseModeSchema, type ResponseMode } from './mesh-schemas.js';
import { UiStateSchema, type UiState } from './schemas.js';

/** Kinds of additional context DorkOS can attach to a turn. */
export type ContextKind =
  | 'git_status'
  | 'ui_state'
  | 'queue_note'
  | 'env'
  | 'relay_context'
  | 'room_context';

/** Lifetime of an entry — informs adapter placement, not yet load-bearing. */
export type ContextScope = 'per-turn' | 'per-session';

/**
 * Structured git status the server derives once (in the assembler) and the
 * adapter formats. Modeled on the fields the legacy `buildGitBlock` consumed
 * from `GitStatusResponse`. For a non-git directory only `isRepo: false` is set.
 */
export interface GitStatusData {
  /** Whether `cwd` is inside a git repository. */
  isRepo: boolean;
  /** Current branch name (or HEAD SHA when detached). */
  branch?: string;
  /** Commits ahead of the remote tracking branch. */
  ahead?: number;
  /** Commits behind the remote tracking branch. */
  behind?: number;
  /** Whether HEAD is detached. */
  detached?: boolean;
  /** Whether the working tree is clean. */
  clean?: boolean;
  /** Count of modified files (staged + unstaged). */
  modified?: number;
  /** Count of staged files. */
  staged?: number;
  /** Count of untracked files. */
  untracked?: number;
  /** Count of files with merge conflicts. */
  conflicted?: number;
}

/**
 * Stable environment metadata the server can attach as a per-session entry.
 * Mirrors the fields the Claude adapter's `buildEnvBlock` renders.
 *
 * NOTE (ADR-0273 G2): env currently flows via `systemPrompt.append`, NOT this
 * entry — the assembler does not emit an `env` entry today. The kind/type are
 * retained so a future runtime that cannot suppress its preset env block can
 * carry env through the bag instead.
 */
export interface EnvData {
  /** Working directory for the session. */
  workingDirectory: string;
  /** Product name (e.g. "DorkOS"). */
  product: string;
  /** Server version string. */
  version: string;
  /** API port the server listens on. */
  port: number;
  /** Host platform (`os.platform()`). */
  platform: string;
  /** OS release string (`os.release()`). */
  osVersion: string;
  /** Node.js runtime version (`process.version`). */
  nodeVersion: string;
  /** Host machine name (`os.hostname()`). */
  hostname: string;
}

/**
 * Relay metadata that today wraps the `<relay_context>` block (sender, budget,
 * reply routing). Retained as a typed hook so the assembler can carry relay
 * context through the bag in future; relay delivery currently builds its own
 * block in `@dorkos/relay` and does NOT flow through the assembler.
 */
export interface RelayContextData {
  /** The recipient agent's id. */
  agentId: string;
  /** The backend session id the relay message resumed. */
  sessionId: string;
  /** Sender endpoint subject. */
  from: string;
  /** Relay message id. */
  messageId: string;
  /** Subject the message was sent on. */
  subject: string;
  /** ISO timestamp the message was created. */
  sent: string;
  /** Hops used out of the budget maximum. */
  hopsUsed?: number;
  /** Hop budget maximum. */
  hopsMax?: number;
  /** Seconds of TTL remaining. */
  ttlSecondsRemaining?: number;
  /** Remaining call/turn budget. */
  callBudgetRemaining?: number;
  /** Reply-to endpoint subject, when a reply is expected. */
  replyTo?: string;
}

/**
 * How one author is named to a model: the address that reaches them, and the
 * name they render under.
 *
 * **`handle` is a promise, and `null` is how it is kept.** Every `@handle`
 * rendered from this shape must resolve — through the same resolver a posted
 * message runs through, against the same roster — to exactly this author. Three
 * ordinary names break that promise: one with a space in it, which the mention
 * grammar truncates at the space; one an earlier member of the same roster
 * already answers to; and one ending in `.`, `-` or `_`, which the resolver
 * matches exactly before it shaves anything, so it quietly takes the
 * sentence-ending mentions of the member without the punctuation. So `null` is
 * not "we did not look it up", it is "nothing anyone can type reaches this
 * author", and a renderer must say that rather than print the name with an `@`
 * in front of it.
 *
 * Getting it wrong is not a cosmetic bug. A handle that reaches nobody invites a
 * message that reaches nobody; a handle that reaches somebody ELSE is worse,
 * because the wrong member answers and the intended one stays silent, which from
 * inside the room is indistinguishable from a broken agent
 * (`meta/agent-etiquette.md` E1). An agent handed a name it cannot be addressed
 * by has no way to notice, the way a person would.
 */
export interface RoomContextAuthor {
  /** What an `@mention` resolves to this author, or `null` when nothing does. */
  handle: string | null;
  /** The name this author renders under. Always present, and never an address. */
  displayName: string;
}

/**
 * One member of a room, as the agent sees them.
 *
 * No `authorId`. The ULIDs are opaque and useless to a model; what a model needs
 * is the name it can address this member by, which {@link RoomContextAuthor}
 * carries — so leaving ids out saves tokens and removes a value the model could
 * hallucinate into a message body.
 */
export interface RoomContextMember extends RoomContextAuthor {
  /**
   * A person, or a machine. THE field of this whole entry: an agent that cannot
   * tell a colleague from a bot cannot follow any of the room-etiquette rules
   * about who to answer and who to leave alone (`meta/agent-etiquette.md` E2,
   * E3, E18). Derived from the stored author kind, which already carries it.
   */
  isPerson: boolean;
  /** True for the one member whose turn this is. */
  isSelf: boolean;
  /**
   * Agents only — absent for people and for the room's own system voice. Lets an
   * agent see that another member is set not to reply here, so it does not wait
   * on an answer that is never coming.
   */
  responseMode?: ResponseMode;
}

/** One room entry, flattened for the model. */
export interface RoomContextEntry {
  /**
   * What an `@mention` resolves to this entry's author, or `null` when nothing
   * does — see {@link RoomContextAuthor.handle}.
   *
   * `null` far more often than for a member, and for one extra reason: the
   * author of an old message may have LEFT the room. Mentions resolve against
   * the room's current roster, so no string reaches somebody who is no longer on
   * it, whatever they used to be called here.
   */
  authorHandle: string | null;
  /** The name the author renders under — how a handle-less author is named. */
  authorDisplayName: string;
  /** Whether a person wrote this, or a machine did. */
  authorIsPerson: boolean;
  /** Someone talking (`post`) or the room reporting on itself (`notice`). */
  kind: 'post' | 'notice';
  /** ISO timestamp the entry was written. */
  at: string;
  /** The entry body — UNTRUSTED text when the author is not the agent itself. */
  text: string;
  /** True when this entry mentioned the agent receiving the context. */
  mentionsMe: boolean;
}

/**
 * Where a room turn is happening, who is in it, and what it missed.
 *
 * Structured data only — never pre-formatted prose. Each runtime adapter renders
 * it, and every one of them renders the other members' text inside a nonced
 * untrusted-data fence, because a room puts text written by other people in
 * front of a model that also holds the filesystem and the credentials.
 *
 * Server-derived, never client-supplied: {@link ClientContext} is Zod-parsed off
 * the wire, and a roster a caller could supply would be a roster a caller could
 * forge.
 */
export interface RoomContextData {
  /**
   * The room itself — a channel or a direct message, never a thread. A thread is
   * a position inside a room rather than a room of its own
   * (ADR 260728-022013), so a thread turn reports the channel it happened in.
   */
  room: { id: string; kind: 'channel' | 'dm'; name: string; topic?: string };
  /**
   * Non-null when this turn was triggered inside a thread: which entry the
   * thread hangs off, its opening words, and how many replies it already has.
   * Read off the triggering entry's own pointer.
   */
  thread: { rootEntryId: string; rootExcerpt: string; replyCount: number } | null;
  /** The roster, self included. */
  members: RoomContextMember[];
  /**
   * Agents holding a turn claim right now, so an agent knows somebody is already
   * on it. Presence, NOT arbitration: it orders nobody, waits for nobody, and
   * decides nothing (ADR 260726-170125 — no referee, no speaker election, no
   * room-scoped turn lock). Excludes the agent reading it.
   */
  working: Array<RoomContextAuthor & { since: string }>;
  /** Entries this membership has not read, oldest first, excluding its own. */
  pending: RoomContextEntry[];
  /** True when `pending` was capped and older entries were dropped. */
  pendingTruncated: boolean;
  /** This agent's own recent posts here, so it does not repeat itself. */
  ownRecent: RoomContextEntry[];
  /** How this agent is addressed here, and whether it was addressed now. */
  addressing: {
    /** This room's stored override, not the agent's manifest default. */
    responseMode: ResponseMode;
    /**
     * ISO timestamp an `engaged` window expires, or `null` when there is none.
     *
     * `null` for every mode other than `engaged`, which is not the same claim as
     * "not engaged": the other four have no window, so reporting one would
     * describe a bound nothing applies.
     */
    engagedUntil: string | null;
    /**
     * How many more messages from other members that same window survives, or
     * `null` alongside {@link RoomContextData.addressing.engagedUntil}.
     *
     * The window ends on whichever of the two runs out first, so a deadline on
     * its own is half a rule. Remaining rather than the configured ceiling: an
     * agent cannot see how much of the window has already been spent, so a
     * ceiling is a number it could not place itself against. `0` means the next
     * message from anybody else closes it.
     */
    engagedPostsLeft: number | null;
    /** True when the triggering entry mentioned this agent by name. */
    addressedNow: boolean;
  };
  /**
   * What is left to spend, on the precedent {@link RelayContextData} set with
   * `hopsUsed` / `callBudgetRemaining`: an agent that can see its budget can
   * spend it deliberately.
   */
  budget: {
    /** Automatic turns this room may still run this hour. */
    automaticRepliesLeftInThisRoomThisHour: number;
    /** Automatic turns the whole install may still run this hour. */
    automaticRepliesLeftInTotalThisHour: number;
    /** The cascade ceiling minus this turn's depth. */
    repliesLeftInThisChain: number;
  };
}

/**
 * Discriminated union of the canonical server-assembled entries. Each member
 * pairs a {@link ContextKind} with its structured `data` payload and a
 * {@link ContextScope}.
 */
export type AdditionalContextEntry =
  | { kind: 'git_status'; scope: 'per-turn'; data: GitStatusData }
  | { kind: 'ui_state'; scope: 'per-turn'; data: UiState }
  | { kind: 'queue_note'; scope: 'per-turn'; data: { composedDuringPrevTurn: true } }
  | { kind: 'env'; scope: 'per-session'; data: EnvData }
  | { kind: 'relay_context'; scope: 'per-turn'; data: RelayContextData }
  | { kind: 'room_context'; scope: 'per-turn'; data: RoomContextData };

/** The per-turn bag a runtime receives via `MessageOpts.additionalContext`. */
export type AdditionalContext = AdditionalContextEntry[];

/**
 * Client-sourced signals. The client contributes only what it knows; the
 * SERVER derives git_status/env and normalizes everything into entries.
 * Signals + data only — NEVER pre-formatted prose.
 */
export interface ClientContext {
  /** Snapshot of the client UI state for agent situational awareness. */
  uiState?: UiState;
  /** True when composed while the agent was responding to the previous turn. */
  queued?: boolean;
  // room for: editorSelection, openFile, …
}

/**
 * XML wrapper tag per kind — the SINGLE source of truth for tag names, used by
 * BOTH the adapter formatter (`renderContextEntry`) and the render-strip
 * (`stripSystemTags`). Keying both off this map makes drift impossible: adding
 * a {@link ContextKind} extends this map and both sides pick it up automatically.
 */
export const CONTEXT_TAG = {
  git_status: 'git_status',
  ui_state: 'ui_state',
  queue_note: 'queue_note',
  env: 'env',
  relay_context: 'relay_context',
  room_context: 'room_context',
} satisfies Record<ContextKind, string>;

/** Zod schema for {@link GitStatusData}. */
export const GitStatusDataSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  detached: z.boolean().optional(),
  clean: z.boolean().optional(),
  modified: z.number().int().optional(),
  staged: z.number().int().optional(),
  untracked: z.number().int().optional(),
  conflicted: z.number().int().optional(),
});

/** Zod schema for {@link EnvData}. */
export const EnvDataSchema = z.object({
  workingDirectory: z.string(),
  product: z.string(),
  version: z.string(),
  port: z.number(),
  platform: z.string(),
  osVersion: z.string(),
  nodeVersion: z.string(),
  hostname: z.string(),
});

/** Zod schema for {@link RelayContextData}. */
export const RelayContextDataSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  from: z.string(),
  messageId: z.string(),
  subject: z.string(),
  sent: z.string(),
  hopsUsed: z.number().int().optional(),
  hopsMax: z.number().int().optional(),
  ttlSecondsRemaining: z.number().int().optional(),
  callBudgetRemaining: z.number().int().optional(),
  replyTo: z.string().optional(),
});

/** Zod schema for {@link RoomContextAuthor}. */
export const RoomContextAuthorSchema = z.object({
  handle: z.string().nullable(),
  displayName: z.string(),
});

/** Zod schema for {@link RoomContextMember}. */
export const RoomContextMemberSchema = RoomContextAuthorSchema.extend({
  isPerson: z.boolean(),
  isSelf: z.boolean(),
  responseMode: ResponseModeSchema.optional(),
});

/** Zod schema for {@link RoomContextEntry}. */
export const RoomContextEntrySchema = z.object({
  authorHandle: z.string().nullable(),
  authorDisplayName: z.string(),
  authorIsPerson: z.boolean(),
  kind: z.enum(['post', 'notice']),
  at: z.string(),
  text: z.string(),
  mentionsMe: z.boolean(),
});

/** Zod schema for {@link RoomContextData}. */
export const RoomContextDataSchema = z.object({
  room: z.object({
    id: z.string(),
    kind: z.enum(['channel', 'dm']),
    name: z.string(),
    topic: z.string().optional(),
  }),
  thread: z
    .object({
      rootEntryId: z.string(),
      rootExcerpt: z.string(),
      replyCount: z.number().int(),
    })
    .nullable(),
  members: z.array(RoomContextMemberSchema),
  working: z.array(RoomContextAuthorSchema.extend({ since: z.string() })),
  pending: z.array(RoomContextEntrySchema),
  pendingTruncated: z.boolean(),
  ownRecent: z.array(RoomContextEntrySchema),
  addressing: z.object({
    responseMode: ResponseModeSchema,
    engagedUntil: z.string().nullable(),
    engagedPostsLeft: z.number().int().nullable(),
    addressedNow: z.boolean(),
  }),
  budget: z.object({
    automaticRepliesLeftInThisRoomThisHour: z.number().int(),
    automaticRepliesLeftInTotalThisHour: z.number().int(),
    repliesLeftInThisChain: z.number().int(),
  }),
});

/** Zod schema for {@link AdditionalContextEntry} (discriminated on `kind`). */
export const AdditionalContextEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git_status'),
    scope: z.literal('per-turn'),
    data: GitStatusDataSchema,
  }),
  z.object({
    kind: z.literal('ui_state'),
    scope: z.literal('per-turn'),
    data: z.lazy(() => UiStateSchema),
  }),
  z.object({
    kind: z.literal('queue_note'),
    scope: z.literal('per-turn'),
    data: z.object({ composedDuringPrevTurn: z.literal(true) }),
  }),
  z.object({
    kind: z.literal('env'),
    scope: z.literal('per-session'),
    data: EnvDataSchema,
  }),
  z.object({
    kind: z.literal('relay_context'),
    scope: z.literal('per-turn'),
    data: RelayContextDataSchema,
  }),
  z.object({
    kind: z.literal('room_context'),
    scope: z.literal('per-turn'),
    data: RoomContextDataSchema,
  }),
]);

/** Zod schema for {@link AdditionalContext}. */
export const AdditionalContextSchema = z.array(AdditionalContextEntrySchema);

/**
 * Zod schema for {@link ClientContext}. Strict-ish: only `uiState` and `queued`
 * are accepted (extra keys are stripped by Zod's default object parsing).
 */
export const ClientContextSchema = z.object({
  uiState: z.lazy(() => UiStateSchema).optional(),
  queued: z.boolean().optional(),
});
