/**
 * The one scrub for what the work graph's reads show of a chat the reader may
 * not read (Security, DOR-4970 and DOR-4972; the audit scrub rule,
 * `audit/audit-session-scrub.ts`). A private row is its relation and its days,
 * and nothing more: no chat, no time finer than the day, no source, no end
 * reason. Two private rows that read the same are one row, and nothing says
 * how many there were, so a private row can never count or point back at a chat.
 *
 * Both reads build their private rows here: a link of `work_for_*`
 * ({@link PrivateRows.link}) and a span of `work_item_chats`
 * ({@link PrivateRows.span}).
 *
 * @module services/work-graph/reads/private-rows
 */
import type { WorkItemLink, WorkItemSpan } from '@dorkos/shared/work-graph-reads';

/** A private link: its relation and the day it was recorded. */
export type PrivateLink = Extract<WorkItemLink, { chatId: null }>;

/** A private span: its start and end days. */
export type PrivateSpan = Exclude<WorkItemSpan, { chatId: string }>;

/** The day (`YYYY-MM-DD`) an ISO 8601 time falls on. */
function dayOf(at: string): string {
  return at.slice(0, 10);
}

/** Builds a read's private rows, one per distinct row, never counted. */
export class PrivateRows {
  private readonly seen = new Set<string>();

  /**
   * The private row for a chat's link to an item, or `null` when the same
   * row is already shown.
   *
   * @param item - How the item is written: rows are kept apart per item.
   * @param relation - The link's relation.
   * @param recordedAt - When it was recorded (ISO 8601); only its day is kept.
   */
  link(item: string, relation: string, recordedAt: string): PrivateLink | null {
    const recordedOn = dayOf(recordedAt);
    return this.admit(['link', item, relation, recordedOn])
      ? { relation, chatId: null, recordedOn }
      : null;
  }

  /**
   * The private row for a claim's span, or `null` when the same row is
   * already shown: the same start day, end day and open state.
   *
   * @param claimedAt - When it began (ISO 8601); only its day is kept.
   * @param endedAt - When it ended, or `null` while held; only its day is kept.
   */
  span(claimedAt: string, endedAt: string | null): PrivateSpan | null {
    const startDay = dayOf(claimedAt);
    const endDay = endedAt === null ? null : dayOf(endedAt);
    return this.admit(['span', startDay, endDay ?? 'open'])
      ? { relation: 'claims', startDay, endDay }
      : null;
  }

  /** Whether a row with this key is the first one; a later one is dropped. */
  private admit(key: readonly string[]): boolean {
    const joined = key.join('\n');
    if (this.seen.has(joined)) return false;
    this.seen.add(joined);
    return true;
  }
}
