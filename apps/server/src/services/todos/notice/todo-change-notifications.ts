/**
 * The Inbox event raised when an agent moves, drops or keeps a promise it made to a person
 * (DOR-3034). A kept one asks the person to confirm it (`todo-confirm.ts`).
 * The emitter is `todo-recipient-notice.ts`, wired in `todo-wiring.ts`. It is notable: nothing
 * waits on the person, but a promise to them changed, and they hear it with the agent's reason.
 *
 * Declared beside its emitter and spread into the registry through
 * `notifications/declared-entries.ts`. Types only: importing it never loads the notification
 * service.
 *
 * @module services/todos/notice/todo-change-notifications
 */
import type { NotificationRegistryEntry } from '../../notifications/notification-registry.js';

/** The payload of the promise-changed kind, joined into `NotificationPayloads`. */
export interface TodoChangePayloads {
  /** An agent moved, dropped or kept a promise it made to a person. */
  'todo.changed': {
    /** The to-do. */
    todoId: string;
    /** The agent that made the promise and changed it. */
    agentId: string;
    /** That agent's name, as the team knows it. */
    agentName: string;
    /** What happened to it. */
    change: 'moved' | 'dropped' | 'kept';
    /** The reason the agent gave, or null when it gave none. */
    note: string | null;
    /** A moved promise's new date in the person's own words ("Fri, Nov 20"), or null. */
    newDue: string | null;
    /** A kept promise's link to what was delivered, or null. */
    delivered?: string | null;
    /** ISO time of the change. */
    at: string;
  };
}

/** The site a delivered link points at ("github.com"), or null for anything but a web address. */
function hostOf(delivered: string | null | undefined): string | null {
  if (!delivered) return null;
  try {
    const url = new URL(delivered);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host : null;
  } catch {
    return null;
  }
}

/** The promise-changed entry, spread into the registry's `ENTRIES`. */
export const TODO_CHANGE_ENTRIES: {
  [K in keyof TodoChangePayloads]: NotificationRegistryEntry<K>;
} = {
  'todo.changed': {
    kind: 'todo.changed',
    tier: 'notable',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId }),
    // Fixed words, never the promise's own: they can be somebody else's (a to-do a guest's message
    // made), so the person opens the promise to read it, as the heartbeat gatherer does.
    title: (p) => `${p.agentName} ${p.change} a promise to you`,
    body: (p) => {
      if (p.change === 'kept') {
        const ask = `Done? Answer Yes or Not yet on ${p.agentName}’s to-dos within a day.`;
        const host = hostOf(p.delivered);
        return host ? `${ask} Delivered · ${host}` : ask;
      }
      const why = p.note ? `Why: ${p.note}` : 'No reason given.';
      if (p.change !== 'moved') return why;
      return `${p.newDue ? `Now due ${p.newDue}.` : 'Now with no date.'} ${why}`;
    },
    // One ask per promise, however often it is kept again; each move or drop is its own news.
    dedupeKey: (p) =>
      p.change === 'kept' ? `todo-kept:${p.todoId}` : `todo-changed:${p.todoId}:${p.at}`,
    relay: 'never',
  },
};
