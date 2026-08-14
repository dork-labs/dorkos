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
import type { AuthorOrigin } from './room-schemas.js';
import { UiStateSchema, type UiState } from './schemas.js';

/** Kinds of additional context DorkOS can attach to a turn. */
export type ContextKind =
  | 'git_status'
  | 'ui_state'
  | 'queue_note'
  | 'env'
  | 'relay_context'
  | 'room_context'
  | 'seed_context';

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
   * On this machine, or on a platform outside it (chats-as-channels spec §4.3).
   *
   * The sibling of {@link RoomContextMember.isPerson} and read for the same kind
   * of decision: `isPerson` says whether to treat a member as a colleague,
   * `origin` says whether that colleague is somebody the operator knows or a
   * stranger who found a public bot. Derived from the stored author key, so it
   * describes who they ARE — it does not change with whatever message is being
   * processed when the roster is rendered.
   */
  origin: AuthorOrigin;
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
   * The sanitized forum-topic label this entry was posted under, or `null` for
   * an entry with none (chats-as-channels spec §5.6, §9.2). Phase 1 folds every
   * Telegram forum topic into one room (D-6 Q1), so this is what keeps a folded
   * room's log readable as more than one interleaved conversation.
   *
   * Read off the external ref's stored `threadName`, already sanitized once at
   * write time (`ingest.ts`) — carried through here unsanitized so the renderer
   * can sanitize it AGAIN at render, because §9.2 requires both.
   */
  topicLabel: string | null;
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
  /**
   * Whether the author was on this machine or outside it, at the grain that
   * matters per line (chats-as-channels spec §9.2).
   *
   * Coarser than {@link RoomContextMember.origin} on purpose. A roster line is
   * read once a turn and can afford to name the platform; an entry line rides
   * every message, and the only thing a model has to decide from it is whether
   * these are the operator's own words or a stranger's. So this is the trust
   * bit, spelled as one word by the renderer.
   *
   * **Established at write time and carried, never inferred from the text and
   * never re-derived at render time** — it comes off the stored author's natural
   * key, which was written when the author was minted (spec §9.1).
   */
  authorOrigin: 'local' | 'external';
  /** Someone talking (`post`) or the room reporting on itself (`notice`). */
  kind: 'post' | 'notice';
  /** ISO timestamp the entry was written. */
  at: string;
  /** The entry body — UNTRUSTED text when the author is not the agent itself. */
  text: string;
  /** True when this entry mentioned the agent receiving the context. */
  mentionsMe: boolean;
  /**
   * The files posted with this entry, as paths relative to the agent's own
   * working directory. Empty for an entry with none.
   *
   * Relative, so this module stays pure: the path is a function of the entry id
   * and the stored filename, identical for every agent, and never of a cwd this
   * builder must not know.
   *
   * **Required rather than optional, and that is the safety property.** Every
   * builder of a `RoomContextEntry` is in this repo, and an optional field here
   * would let a path silently go missing — which is exactly the failure this
   * feature cannot have, since a path the model is told about must be one it
   * can open.
   */
  attachments: { name: string; path: string }[];
}

/**
 * Somebody reacted to something this agent said — the costless acknowledgment
 * (`specs/room-messaging-design` §2.5).
 *
 * **It arrives in a turn the agent was already taking, and never causes one.**
 * A reaction takes no turn, writes no entry, sends no notice and starts no
 * cascade; it lands here, on the next turn something else triggered, and that is
 * the whole of its reach. A person can thank an agent for free, in both
 * directions: it costs them one click and it costs the agent nothing.
 *
 * **It is an endpoint, not a prompt** (`meta/agent-etiquette.md` E16b). An agent
 * never replies to one and never thanks anybody for one, which the rendered
 * block says out loud rather than leaving to inference.
 */
export interface RoomContextAcknowledgment extends RoomContextAuthor {
  /**
   * Whether a person left it. True for every one of them today — no path lets a
   * non-human react — and carried anyway, because the reader is an agent
   * deciding how to treat it and "who said this" is never something to infer.
   */
  isPerson: boolean;
  /** The emoji, exactly as it was sent. */
  emoji: string;
  /**
   * ISO timestamp of the agent's OWN entry that was reacted to — deliberately
   * not of the reaction. It is the clock the entry renders under in
   * {@link RoomContextData.ownRecent}, which is how the two lines join up.
   */
  entryAt: string;
  /**
   * The opening words of that entry, so an agent holding five recent posts can
   * tell which one this is about. The agent's own text, so it renders where
   * `ownRecent` does — outside the untrusted fence.
   */
  entryExcerpt: string;
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
  room: {
    id: string;
    kind: 'channel' | 'dm';
    name: string;
    topic?: string;
    /**
     * True when this room projects an external chat (chats-as-channels §3.1),
     * which is what earns the standing line in the untrusted fence: messages
     * here can come from people who are not on this machine and were never
     * invited by anyone.
     *
     * A property of the ROOM, not of who happens to have spoken. A bridged group
     * whose strangers have not posted yet still says so, because the sentence is
     * about what the channel receives rather than about what is in this page of
     * it.
     */
    bridged: boolean;
    /**
     * How much of a bridged GROUP's traffic actually reaches this room
     * (chats-as-channels spec §8) — `'full'` when Telegram's privacy mode is
     * off for this bot, `'partial'` when it is on (the shipped default) or has
     * never been confirmed. Absent for an unbridged room and for a bridged DM:
     * privacy mode is a group-only switch, and Telegram delivers every
     * private-chat message regardless of it, so there is nothing partial to
     * report there (§8: "a DM has no badge").
     *
     * A model that believes it saw a whole conversation it saw a tenth of will
     * confidently describe a group it cannot read — this is what stops that.
     */
    visibility?: 'partial' | 'full';
    /**
     * The far-end platform's formatting guidance for a bridged room, or absent
     * when unbridged (chats-as-channels spec §15) — the same information the
     * adapter already puts on an inbound envelope's
     * `responseContext.formattingInstructions`, now available to a turn a ROOM
     * triggered rather than one envelope did.
     *
     * **Guidance, not enforcement.** This rides in the labels region so an
     * agent answering here knows what the far end renders; the outbound
     * adapter remains the sole enforcement backstop for splitting and
     * escaping, unchanged by this field's presence.
     */
    formatting?: { instructions: string; maxLength: number };
  };
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
  /**
   * Entries this membership has not read, oldest first, excluding its own.
   *
   * **Scoped to whatever the turn is answering in.** For a top-level turn that
   * is the whole room; for a turn inside a thread it is that THREAD's unread
   * replies and nothing else, because a thread reply is answered into the thread
   * and the engaged window that kept the agent listening was opened there too.
   * All three questions — do I stay engaged, what do I read, where does my
   * answer land — now have one answer.
   *
   * The channel a thread turn is not reading rides separately, bounded, as
   * {@link RoomContextData.channelTail}.
   */
  pending: RoomContextEntry[];
  /** True when `pending` was capped and older entries were dropped. */
  pendingTruncated: boolean;
  /**
   * The last few TOP-LEVEL messages of the channel a thread turn is happening
   * in, oldest first — background, never the conversation being answered.
   *
   * Present only for a turn inside a thread, where {@link RoomContextData.pending}
   * is scoped to the thread: an agent that can see nothing but its own aside
   * will re-raise something the channel settled two minutes ago. Absent for a
   * top-level turn, where the channel IS the scope and there is no "rest of the
   * room" to name.
   *
   * **Unread first, recent as the fallback**, and the order matters for a reason
   * beyond relevance. The claim advances ONE read cursor for the whole room, so
   * a thread turn moves it past channel messages it never showed. Filling this
   * with the unread ones first is what keeps the loss bounded rather than
   * arbitrary; what could not fit is counted in
   * {@link RoomContextData.channelTailOmitted} rather than dropped in silence.
   * When nothing there is unread, it falls back to the newest few, because "you
   * are up to date" is not a reason to know nothing about the room.
   *
   * **Disjoint from `pending` by construction, and from the thread's opener too.**
   * A thread reply is never top-level, and the entry the thread hangs off is
   * excluded here because it is already quoted as
   * {@link RoomContextData.thread}'s `rootExcerpt` — so no message reaches the
   * model twice under two different headings.
   *
   * Posts only: a machine notice must not eat one of the five slots. Deliberately
   * NOT governed by `ambientMaxEntries` — that cap sizes the conversation an
   * agent is answering, and this is the glance sideways.
   */
  channelTail?: RoomContextEntry[];
  /**
   * How many UNREAD top-level channel messages did not fit in
   * {@link RoomContextData.channelTail}. Absent when none were left out.
   *
   * **It exists because the loss is real and must not be silent.** A thread turn
   * advances the room's single read cursor past channel messages it did not
   * show, so those messages are gone from every future turn's unread window.
   * The tail bounds that; this number discloses it, and the rendered block says
   * it out loud — an agent that knows it is missing five messages can ask,
   * where one that was told nothing cannot.
   *
   * Counted over the same window the tail was read from, so the two are one
   * statement rather than two estimates.
   */
  channelTailOmitted?: number;
  /** This agent's own recent posts here, so it does not repeat itself. */
  ownRecent: RoomContextEntry[];
  /**
   * Reactions currently standing on those same recent posts, newest first.
   *
   * Scoped to {@link RoomContextData.ownRecent} on purpose, and that scope is
   * what ages them out: once the agent has said five more things here, an old
   * acknowledgment stops riding every turn. Empty is the common case and costs
   * nothing to render.
   */
  acknowledgments: RoomContextAcknowledgment[];
  /**
   * The files posted with the message this turn is ANSWERING, as paths relative
   * to the agent's own working directory. Empty when it carried none.
   *
   * Separate from every entry's own `attachments` because the triggering entry
   * is deliberately not in `pending`: it reaches the model as the turn's
   * content, not as history (`excludeEntryId`). Without this field the most
   * ordinary case there is — "@agent look at this file" — delivered the words
   * and silently dropped the file, because the roll-up only ever looked at the
   * window.
   *
   * It cannot ride on the content itself: the prompt is the message byte for
   * byte (ADR-0273), so anything DorkOS has to say about it belongs here.
   */
  triggerAttachments: { name: string; path: string }[];
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
 * Background whoever STARTED a turn attached to it — the agent reads it, the
 * person never sees it (`SendMessageRequest.seedContext`).
 *
 * The case it exists for: a surface that opens a conversation already knowing
 * something the person would otherwise have to type. "Ask DorkBot" from the
 * Marketplace knows which page they were on; a docs try-it link knows which
 * guide sent them. Putting that in the message itself would make the person
 * appear to have written words they did not write, every time, forever, in a
 * transcript they can read back.
 *
 * **It carries no authority, and the rendered block says so.** It is parsed off
 * the wire, so it is exactly as trusted as `content` — anything that can post a
 * message can already put any words in it. What is genuinely different is that
 * a seed is INVISIBLE to the person, which is why the block tells the reader
 * that: an agent that mistakes background for the person's own instruction will
 * act on something nobody asked for and the person cannot even see.
 *
 * Deliberately NOT part of {@link ClientContext}. That bag is structured signals
 * the server renders (a UI snapshot, a queue flag); this is prose a caller wrote
 * for a model to read, and the two are different enough that folding them
 * together would make "never pre-formatted prose" untrue of the bag.
 */
export interface SeedContextData {
  /** The background text, exactly as the caller wrote it. */
  text: string;
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
  | { kind: 'room_context'; scope: 'per-turn'; data: RoomContextData }
  | { kind: 'seed_context'; scope: 'per-turn'; data: SeedContextData };

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
  seed_context: 'seed_context',
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

/**
 * The shape of `room-schemas.ts`'s `AuthorOriginSchema`, inlined rather than
 * imported.
 *
 * A VALUE import of that schema back into this file closes a real circular
 * import: `room-schemas.ts` imports `SignalTypeSchema` from
 * `relay-envelope-schemas.ts`, which imports `schemas.ts`, which imports
 * `ClientContextSchema` from THIS file. Adding a value edge from here back to
 * `room-schemas.ts` completes the cycle, and depending on which module a test
 * happens to import first, `SignalTypeSchema` can still be `undefined` at the
 * point `room-schemas.ts` builds `RoomSignalEventSchema` — observed as
 * `zod-to-openapi` throwing `Invalid element at key "signal"` while generating
 * the OpenAPI document. The shape is a two-armed literal union with nothing to
 * drift out of sync; keep it identical to `AuthorOriginSchema` if that one
 * changes.
 */
const RoomContextOriginSchema = z.union([
  z.literal('local'),
  z.object({ platform: z.string().min(1) }),
]);

/** Zod schema for {@link RoomContextAuthor}. */
export const RoomContextAuthorSchema = z.object({
  handle: z.string().nullable(),
  displayName: z.string(),
});

/** Zod schema for {@link RoomContextMember}. */
export const RoomContextMemberSchema = RoomContextAuthorSchema.extend({
  isPerson: z.boolean(),
  isSelf: z.boolean(),
  origin: RoomContextOriginSchema,
  responseMode: ResponseModeSchema.optional(),
});

/** Zod schema for {@link RoomContextEntry}. */
export const RoomContextEntrySchema = z.object({
  authorHandle: z.string().nullable(),
  authorDisplayName: z.string(),
  authorIsPerson: z.boolean(),
  authorOrigin: z.enum(['local', 'external']),
  kind: z.enum(['post', 'notice']),
  at: z.string(),
  text: z.string(),
  mentionsMe: z.boolean(),
  topicLabel: z.string().nullable(),
  attachments: z.array(z.object({ name: z.string(), path: z.string() })),
});

/** Zod schema for {@link RoomContextAcknowledgment}. */
export const RoomContextAcknowledgmentSchema = RoomContextAuthorSchema.extend({
  isPerson: z.boolean(),
  emoji: z.string(),
  entryAt: z.string(),
  entryExcerpt: z.string(),
});

/** Zod schema for {@link RoomContextData}. */
export const RoomContextDataSchema = z.object({
  room: z.object({
    id: z.string(),
    kind: z.enum(['channel', 'dm']),
    name: z.string(),
    topic: z.string().optional(),
    bridged: z.boolean(),
    visibility: z.enum(['partial', 'full']).optional(),
    formatting: z.object({ instructions: z.string(), maxLength: z.number().int() }).optional(),
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
  channelTail: z.array(RoomContextEntrySchema).optional(),
  channelTailOmitted: z.number().int().nonnegative().optional(),
  ownRecent: z.array(RoomContextEntrySchema),
  acknowledgments: z.array(RoomContextAcknowledgmentSchema),
  triggerAttachments: z.array(z.object({ name: z.string(), path: z.string() })),
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

/** Zod schema for {@link SeedContextData}. */
export const SeedContextDataSchema = z.object({ text: z.string().min(1) });

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
  z.object({
    kind: z.literal('seed_context'),
    scope: z.literal('per-turn'),
    data: SeedContextDataSchema,
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
