/**
 * The work graph's reads (W4, DOR-4970): an agent's chats, ended ones too; a
 * chat's tree of chats that started each other; the pull requests and
 * tickets an agent, or a chat and the chats below it, opened, claimed or
 * works on; and the chats that claimed one ticket or pull request, and when
 * (DOR-4972). One shape for the REST paths and the agent tools.
 *
 * What a reader sees follows the audit read side (spec `audit-trail` §3.4):
 * the owner reads everything; an agent never sees a person's own chat. Each
 * shape below says how a chat it may not read is left out.
 *
 * @module shared/work-graph-reads
 */
import { z } from 'zod';

/** The most chats one page of an agent's chats holds. */
export const AGENT_CHATS_PAGE_LIMIT = 200;

/** The most items one page of work holds. */
export const WORK_PAGE_LIMIT = 200;

/** The most chats below the asked one that one page of a tree holds. */
export const CHAT_TREE_PAGE_LIMIT = 500;

/** The most spans one page of a work item's chats holds. */
export const WORK_ITEM_CHATS_PAGE_LIMIT = 200;

/** One chat of an agent. */
export const AgentChatSchema = z.object({
  /** The chat's id. */
  id: z.string(),
  /** Its `dork:chat:` reference, for a `/r/` link, or null for an id that cannot be one. */
  ref: z.string().nullable(),
  /** A ready markdown link to the chat. */
  link: z.string(),
  /** Its title, or null when it has none or it can't be read. */
  title: z.string().nullable(),
  /** When this DorkOS first bound it (ISO 8601). */
  createdAt: z.string(),
  /** The runtime it runs on, or null before its first turn. */
  runtime: z.string().nullable(),
  /** Another chat started this one. */
  spinOff: z.boolean(),
  /** The chat that started it, when the reader may see that chat. */
  startedBy: z.object({ id: z.string(), title: z.string().nullable() }).nullable(),
});

/** One chat of an agent. */
export type AgentChat = z.infer<typeof AgentChatSchema>;

/** One page of an agent's chats, newest first. */
export const AgentChatsPageSchema = z.object({
  /** The chats this reader may see, newest first. */
  chats: z.array(AgentChatSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});

/** One page of an agent's chats. */
export type AgentChatsPage = z.infer<typeof AgentChatsPageSchema>;

/** How a chat came from the one above it: started by it, or carried on from it to another account. */
export const ChatTreeViaSchema = z.enum(['started', 'carried']);

/** What a reader may show of a chat in a tree. */
export const ChatTreeStateSchema = z.discriminatedUnion('kind', [
  /** It ran. It can be opened. */
  z.object({ kind: z.literal('chat') }),
  /** Only a start record proves it. It cannot be opened. */
  z.object({ kind: z.literal('unknown') }),
  /** It has not run yet, and its last run is still in line or starting. */
  z.object({
    kind: z.literal('launching'),
    runId: z.string(),
    status: z.enum(['queued', 'starting']),
  }),
  /** It never ran: its last run ended before its turn started, for `reason`. */
  z.object({ kind: z.literal('never-started'), runId: z.string(), reason: z.string() }),
]);

/** What a reader may show of a chat in a tree. */
export type ChatTreeState = z.infer<typeof ChatTreeStateSchema>;

/**
 * A chat the reader may not read, kept only because a chat it may read hangs
 * below it: no id, no time, no agent and no count.
 */
export const ChatTreeJointSchema = z.object({
  chatId: z.null(),
  state: z.object({ kind: z.literal('private') }),
});

/** One chat above the asked one. */
export const ChatTreeAncestorSchema = z.union([
  z.object({
    /** The chat, by the id it has now. */
    chatId: z.string(),
    /** How many steps up: 1 is the chat that started (or was carried into) the asked one. */
    depth: z.number().int().positive(),
    /** How the chat one step below came from this one. */
    via: ChatTreeViaSchema,
    /** What a reader may show of it. */
    state: ChatTreeStateSchema,
  }),
  ChatTreeJointSchema.extend({ depth: z.number().int().positive() }),
]);

/** One chat above the asked one. */
export type ChatTreeAncestor = z.infer<typeof ChatTreeAncestorSchema>;

/** One chat below the asked one. */
export const ChatTreeDescendantSchema = z.union([
  z.object({
    /** The chat, by the id it has now. */
    chatId: z.string(),
    /** The chat it hangs under, or null when that one is a private joint. */
    parentId: z.string().nullable(),
    /** How many steps down: 1 is a chat the asked one started or was carried to. */
    depth: z.number().int().positive(),
    /** How it came from its parent. */
    via: ChatTreeViaSchema,
    /** What a reader may show of it. */
    state: ChatTreeStateSchema,
  }),
  ChatTreeJointSchema.extend({
    /** The chat it hangs under, or null when that one is a private joint too. */
    parentId: z.string().nullable(),
    /** How many steps down. */
    depth: z.number().int().positive(),
  }),
]);

/** One chat below the asked one. */
export type ChatTreeDescendant = z.infer<typeof ChatTreeDescendantSchema>;

/** A chat's place in the tree of chats that started each other. */
export const ChatTreeSchema = z.object({
  /** The asked chat, by the id it has now. */
  chatId: z.string(),
  /** What a reader may show of it. */
  state: ChatTreeStateSchema,
  /** Nearest first, up to the chat nothing started. */
  ancestors: z.array(ChatTreeAncestorSchema),
  /**
   * Depth first: each chat followed by its own subtree, siblings oldest first.
   * One page of them; the next page goes on where this one stops.
   */
  descendants: z.array(ChatTreeDescendantSchema),
  /** True when a bound on the walk left chats out. */
  truncated: z.boolean(),
  /** Pass as `cursor` for the next page of descendants; null on the last one. */
  nextCursor: z.string().nullable(),
});

/** A chat's place in the tree. */
export type ChatTree = z.infer<typeof ChatTreeSchema>;

/** The kinds of work these reads list. */
export const WorkKindSchema = z.enum(['pr', 'ticket']);

/** A kind of work. */
export type WorkKind = z.infer<typeof WorkKindSchema>;

/** One link from a chat to an item of work. */
export const WorkItemLinkSchema = z.union([
  z.object({
    /** What the chat is to the item, as the work graph stores it (`opened`, `works_on`, ...). */
    relation: z.string(),
    /** The chat. */
    chatId: z.string(),
    /** When it was recorded (ISO 8601). */
    recordedAt: z.string(),
  }),
  z.object({
    /** What a chat the reader may not read is to the item, as stored. */
    relation: z.string(),
    /** Left out: the reader may not read that chat. */
    chatId: z.null(),
    /** The day it was recorded (`YYYY-MM-DD`), never finer. */
    recordedOn: z.string(),
  }),
]);

/** One link from a chat to an item of work. */
export type WorkItemLink = z.infer<typeof WorkItemLinkSchema>;

/** One pull request or ticket. */
export const WorkItemSchema = z.object({
  /** The item, as an entity reference. */
  ref: z.object({ kind: WorkKindSchema, id: z.string() }),
  /** How people write it: `owner/repo#42`, `PR #42` or `DOR-1234`. */
  text: z.string(),
  /** The day its first link was recorded (`YYYY-MM-DD`): the order items list in. */
  firstRecordedOn: z.string(),
  /** Every link to it from the chats asked about, oldest first. */
  links: z.array(WorkItemLinkSchema),
});

/** One pull request or ticket. */
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** One page of work, newest first by the day it was first linked. */
export const WorkPageSchema = z.object({
  /** The items. */
  items: z.array(WorkItemSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});

/** One page of work. */
export type WorkPage = z.infer<typeof WorkPageSchema>;

/**
 * How a claim's span ended: the chat released it, it lapsed when the chat went
 * idle, it was handed to another chat, or a second claim began before any end
 * was recorded (`unknown`).
 */
export const ClaimSpanEndSchema = z.enum(['released', 'lapsed', 'handed-over', 'unknown']);

/** How a claim's span ended. */
export type ClaimSpanEnd = z.infer<typeof ClaimSpanEndSchema>;

/** One span of time a chat held a claim on a ticket or pull request (DOR-4972). */
export const WorkItemSpanSchema = z.union([
  z.object({
    /** Always `claims`: the span of a claim. */
    relation: z.literal('claims'),
    /** The chat, by the id it has now. */
    chatId: z.string(),
    /** When the chat claimed it (ISO 8601). */
    claimedAt: z.string(),
    /**
     * When the claim ended (ISO 8601), or null while the chat holds it. The day
     * only (`YYYY-MM-DD`) when it was handed over to a chat the reader may not
     * read, so nothing here times that chat.
     */
    endedAt: z.string().nullable(),
    /** How it ended, or null while the chat holds it. */
    endedBy: ClaimSpanEndSchema.nullable(),
  }),
  z
    .object({
      /** Always `claims`: a span of a chat the reader may not read. */
      relation: z.literal('claims'),
      /** The day it began (`YYYY-MM-DD`), never finer. */
      startDay: z.string(),
      /** The day it ended (`YYYY-MM-DD`), or null while it is held. */
      endDay: z.string().nullable(),
    })
    .strict(),
]);

/** One span of a claim. */
export type WorkItemSpan = z.infer<typeof WorkItemSpanSchema>;

/**
 * One page of the chats that claimed a ticket or pull request, and when.
 * Spans list by the day they began, oldest first; within a day, the spans of
 * chats the reader may read by `claimedAt` then `chatId`, then the others by
 * the day they ended, so their place says no finer time.
 */
export const WorkItemChatsPageSchema = z.object({
  /** The item asked about, in its canonical spelling. */
  ref: z.object({ kind: WorkKindSchema, id: z.string() }),
  /** The spans. */
  spans: z.array(WorkItemSpanSchema),
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: z.string().nullable(),
});

/** One page of a work item's chats. */
export type WorkItemChatsPage = z.infer<typeof WorkItemChatsPageSchema>;
