/**
 * The mini app lists a page at a time (DOR-4982): the installed mini apps,
 * those waiting for a first yes, the approvals left behind, and the plugins
 * whose mini apps wait together. Each answers through `answerPage`
 * (`lib/paging/hand-route-page.ts`), newest first on its key, the id breaking
 * a tie.
 *
 * None of these rows carries a time that never changes, so each key says what
 * it is: the installed list keeps its own order, the others go by id or plugin. Mini apps and approvals come and go with a rescan or an answer, so
 * one can repeat or be missed across pages; the OpenAPI descriptions say so.
 *
 * Two lists show a reader that is not the person (an agent) the same rows
 * with no folder paths. Their cursor names the reader's kind, so a cursor the
 * person was given is refused to an agent and the other way round.
 *
 * @module services/extensions/listing/extension-list-pages
 */
import type { Context } from 'hono';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { ExtensionApprovalSet } from '@dorkos/shared/extension-approval-schemas';
import type { StaleExtensionApproval } from '@dorkos/shared/extension-list-schemas';
import { answerPage } from '../../../lib/paging/hand-route-page.js';
import { listPosition, type PageKey } from '../../../lib/paging/keyset-page.js';
import type { ExtensionManager } from '../extension-manager.js';

/** The empty first part of a key, for a list whose rows have no time: the order is by id alone. */
const NO_TIME = '';

/**
 * Answer one page of `GET /api/extensions`, in the order the whole list has
 * always come in: every copy that runs, in discovery order, then each older
 * copy a newer one of the same trusted source shadows. The key is each row's
 * place in that order, so a reader of every page gets the same array the list
 * answered before it paged. A rescan between pages can repeat or miss a row.
 *
 * @param c - The Hono context.
 * @param manager - The extension manager.
 */
export function answerExtensionList(
  c: Context,
  manager: Pick<ExtensionManager, 'listPublic' | 'listShadowedPublic'>
): Promise<Response> {
  return answerPage(c, {
    list: 'extensions',
    noun: 'extensions',
    read: () =>
      [...manager.listPublic(), ...manager.listShadowedPublic()].map((record, index) => ({
        record,
        index,
      })),
    keyOf: ({ record, index }): PageKey => [listPosition(index), record.id],
    show: ({ record }): ExtensionRecordPublic => record,
  });
}

/**
 * The list name a reader-shaped list binds into its cursor.
 *
 * @param list - The list.
 * @param forPerson - Whether the reader is the person (paths shown) or not.
 */
export function readerList(list: string, forPerson: boolean): string {
  return `${list}:${forPerson ? 'person' : 'agent'}`;
}

/** A waiting copy's key: when it was first seen waiting, then its id. */
export const pendingApprovalKey = (row: { since: string; id: string }): PageKey => [
  row.since,
  row.id,
];

/** An approval left behind has no time: by id, Z to A. */
export const staleApprovalKey = (row: StaleExtensionApproval): PageKey => [NO_TIME, row.id];

/** A plugin's waiting set has no time: by plugin, Z to A. */
export const approvalSetKey = (row: ExtensionApprovalSet): PageKey => [NO_TIME, row.plugin];
