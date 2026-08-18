/**
 * The six kinds of row a conversation can hold, for every surface at once.
 *
 * A session transcript and a room's history draw the same six things: messages,
 * the day boundary, the "new messages" rule, the room speaking about itself, a
 * milestone, and the quiet line under a thread's root. They were six kinds in
 * two places; this is the one union.
 *
 * **`payload` is `unknown` on purpose.** It is only ever handed back to the
 * host's own body renderer. Forcing `ChatMessage` (`shared/model`) and
 * `RoomEntry` (`@dorkos/shared/room-schemas`) into one type would merge two
 * things that have nothing in common but the fact that somebody said them: the
 * CHROME unifies here, and the content stays typed at its own end.
 *
 * @module features/conversation/lib/row-kinds
 */
import type { ReactNode } from 'react';
import type { MessageAuthor, MessageGrouping } from '@/layers/shared/model';

/** One row of a conversation, whichever surface is drawing it. */
export type ConversationRow =
  | {
      /** Something somebody said. */
      kind: 'message';
      /** The row's stable id — the message id or the entry id. */
      id: string;
      /** The host's own message object, handed straight back to its `renderBody`. */
      payload: unknown;
      /** Where the row sits in its author group. */
      grouping: MessageGrouping;
      /** Who said it, already resolved against the roster or the session. */
      author: MessageAuthor;
      /** When it was said, ISO 8601. */
      at: string;
    }
  | {
      /** The rule between one calendar day and the next. */
      kind: 'day-divider';
      /** Stable key for the boundary. */
      id: string;
      /**
       * What the divider's chip says — "Today", "Yesterday", "Monday, July 21".
       *
       * The label rather than the day itself, because the label is what the two
       * producers can honestly hand over: `buildTimelineRows` phrases it once,
       * against the "now" it was given, so both surfaces say the same words on
       * the same day. Asking for a timestamp and re-phrasing it here would be a
       * second copy of that rule.
       */
      label: string;
    }
  | {
      /** The rule marking where the reader left off. */
      kind: 'unread-divider';
      /** Stable key for the rule. */
      id: string;
    }
  | {
      /** The conversation speaking about itself. */
      kind: 'notice';
      /** The entry id. */
      id: string;
      /** When it was posted, ISO 8601. */
      at: string;
      /** What it says, rendered by the host. */
      body: ReactNode;
    }
  | {
      /** A milestone worth marking. */
      kind: 'moment';
      /** The entry id. */
      id: string;
      /** When it happened, ISO 8601. */
      at: string;
      /** What it says, rendered by the host. */
      body: ReactNode;
    }
  | {
      /** The quiet line under a thread's root: "↳ 3 replies · last 9:45 AM". */
      kind: 'thread-reply';
      /** Stable key for the line. */
      id: string;
      /** The entry heading the thread this line summarises. */
      rootId: string;
      /** How many replies hang off it. */
      replyCount: number;
      /** When the newest reply landed, ISO 8601. */
      lastAt: string;
    };

/** What a row is told about where it is being drawn. */
export interface ConversationRowContext {
  /**
   * Where this row sits in the list it was handed in.
   *
   * The host builds `rows` from its own richer row model, so this is how it
   * reads the rest of that model back — `hostRows[ctx.index]` is the same row,
   * by construction.
   */
  index: number;
  /**
   * Open this row's thread, or `undefined` when the conversation has none.
   *
   * Gated on `capabilities.threads` here rather than at every call site, so a
   * surface without threads cannot grow a reply row by accident.
   */
  onOpenThread?: (rootId: string) => void;
}

/** Draws one row of a conversation. */
export type ConversationRowRenderer = (
  row: ConversationRow,
  context: ConversationRowContext
) => ReactNode;
