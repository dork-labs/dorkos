/**
 * The place gate on `ctx.inbox` (DOR-4282): an app gets Inbox cards only when
 * its manifest declares them and a person's stored yes covers them.
 *
 * @module services/extensions/inbox/inbox-place-gate
 */
import type { InboxApi } from '@dorkos/extension-api/server';
import { logger } from '../../../lib/logger.js';

/** What every `ctx.inbox` call says to an app that did not declare Inbox cards. */
export const INBOX_NOT_DECLARED =
  'This app has not declared Inbox cards. Add "inbox": true to contributions in extension.json.';

/** What `ctx.inbox` says while the person has not allowed this app's Inbox cards yet. */
export const INBOX_NOT_ALLOWED =
  'Inbox cards for this app wait for a person to allow them. The rest of the app keeps running.';

/**
 * A declared inbox gated on the person's yes, checked on every call: while
 * `allowed()` says no, raising, resolving, recording and listing are refused,
 * and an action handler is kept but hears nothing.
 */
function allowedInbox(inbox: InboxApi, allowed: () => boolean): InboxApi {
  const refused = async (): Promise<never> => {
    throw new Error(INBOX_NOT_ALLOWED);
  };
  return {
    raise: (input) => (allowed() ? inbox.raise(input) : refused()),
    resolve: (key, opts) => (allowed() ? inbox.resolve(key, opts) : refused()),
    record: (input) => (allowed() ? inbox.record(input) : refused()),
    list: () => (allowed() ? inbox.list() : refused()),
    // Kept, so a yes given while it runs works without a restart; an event
    // while it is not allowed leaves the card as it was.
    onAction: (handler) =>
      inbox.onAction((event) => (allowed() ? handler(event) : { keepOpen: true })),
  };
}

/** The one line an undeclared `onAction` logs. Fixed text: nothing the app wrote goes in it. */
export const INBOX_ON_ACTION_UNDECLARED_LOG =
  'An app without declared Inbox cards set an Inbox action handler. It was not registered.';

/** Apps whose undeclared `onAction` was logged since this server started. */
const loggedUndeclaredOnAction = new Set<string>();

/**
 * An inbox for an app whose manifest does not declare `inbox`: its approval
 * card never named Inbox cards. Raising, resolving, recording and listing
 * reject. `onAction` registers nothing and returns a no-op disposer, so an
 * app written before places were declared still starts; the refusal is
 * logged once per app per server start.
 */
function undeclaredInbox(extensionId: string): InboxApi {
  const refuse = async (): Promise<never> => {
    throw new Error(INBOX_NOT_DECLARED);
  };
  return {
    raise: refuse,
    resolve: refuse,
    record: refuse,
    list: refuse,
    onAction: () => {
      if (!loggedUndeclaredOnAction.has(extensionId)) {
        loggedUndeclaredOnAction.add(extensionId);
        logger.warn(INBOX_ON_ACTION_UNDECLARED_LOG);
      }
      return () => undefined;
    },
  };
}

/** What {@link gateInboxByPlace} needs to decide. */
export interface InboxPlaceGate {
  /** The app's id, so an undeclared `onAction` is logged once per app. It is never logged. */
  extensionId: string;
  /** Whether the manifest's `contributions` declares `inbox: true`. */
  declared: boolean;
  /** Whether the stored approval covers `inbox` now, read on every call. */
  allowed: () => boolean;
}

/**
 * Wrap an app's inbox in the place gate. Undeclared: every call but
 * `onAction` rejects. Declared: calls pass only while `allowed()` says yes.
 *
 * @param inbox - The inbox the app would get with no gate.
 * @param gate - Whether it is declared and allowed.
 */
export function gateInboxByPlace(inbox: InboxApi, gate: InboxPlaceGate): InboxApi {
  return gate.declared ? allowedInbox(inbox, gate.allowed) : undeclaredInbox(gate.extensionId);
}
