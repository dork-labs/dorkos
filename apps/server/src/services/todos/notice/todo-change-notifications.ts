/**
 * The Inbox event raised when an agent moves or drops a promise it made to a person (DOR-3034).
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

/** The longest stretch of a promise's words a title quotes before it trims. */
const WHAT_IN_TITLE_MAX = 60;

/** The payload of the promise-changed kind, joined into `NotificationPayloads`. */
export interface TodoChangePayloads {
  /** An agent moved or dropped a promise it made to a person. */
  'todo.changed': {
    /** The to-do. */
    todoId: string;
    /** The agent that made the promise and changed it. */
    agentId: string;
    /** That agent's name, as the team knows it. */
    agentName: string;
    /** The promise, in its own words. */
    what: string;
    /** What happened to it. */
    change: 'moved' | 'dropped';
    /** The reason the agent gave, or null when it gave none. */
    note: string | null;
    /** A moved promise's new date in the person's own words ("Fri, Nov 20"), or null. */
    newDue: string | null;
    /** ISO time of the change. */
    at: string;
  };
}

/** The promise's words, short enough for a title. */
function quoted(what: string): string {
  const words = what.length > WHAT_IN_TITLE_MAX ? `${what.slice(0, WHAT_IN_TITLE_MAX - 1)}…` : what;
  return `“${words}”`;
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
    title: (p) => `${p.agentName} ${p.change} ${quoted(p.what)}`,
    body: (p) => {
      const why = p.note ? `Why: ${p.note}` : 'No reason given.';
      if (p.change !== 'moved') return why;
      return `${p.newDue ? `Now due ${p.newDue}.` : 'Now with no date.'} ${why}`;
    },
    dedupeKey: (p) => `todo-changed:${p.todoId}:${p.at}`,
    relay: 'never',
  },
};
