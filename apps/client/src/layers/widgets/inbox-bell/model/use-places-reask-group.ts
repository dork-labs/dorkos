/**
 * The Inbox's one card for apps that ask again only because they now say
 * where they show (DOR-4282): which rows it holds, which were answered here,
 * and which waiting apps keep their own cards.
 *
 * @module widgets/inbox-bell/model/use-places-reask-group
 */
import { useEffect, useState } from 'react';
import type { PendingExtensionApproval } from '@dorkos/shared/extension-approval-schemas';
import { MIN_PLACES_GROUP, isPlacesOnlyReask, reaskKeyOf } from '../lib/places-reask';

/** How a row of the card was answered here. */
export type PlacesRowAnswer = 'allowed' | 'not-now';

/** One row of the card. */
export interface PlacesGroupRow {
  /** The waiting copy, as the server last listed it. */
  approval: PendingExtensionApproval;
  /** How it was answered here, or `null` while it still waits. */
  answer: PlacesRowAnswer | null;
}

/** What {@link usePlacesReaskGroup} hands the list. */
export interface PlacesReaskGroup {
  /** The card's rows in the order they first showed, or none when there is no card. */
  rows: PlacesGroupRow[];
  /** The waiting apps that keep their own cards. */
  rest: PendingExtensionApproval[];
  /**
   * Record one row's answer as the person gives it, before it is sent, so the
   * row collapses in place and the card keeps its shape while it is sent.
   */
  answered: (approval: PendingExtensionApproval, answer: PlacesRowAnswer) => void;
  /** The server took that row's answer. */
  confirmed: (approval: PendingExtensionApproval) => void;
  /** The server refused that row's answer: it waits again, where it stood. */
  retracted: (approval: PendingExtensionApproval) => void;
}

/** A row answered here, with where it stood when it was. */
interface AnsweredRow {
  approval: PendingExtensionApproval;
  answer: PlacesRowAnswer;
  index: number;
  /** Whether the server took the answer yet. */
  sent: boolean;
}

/**
 * Group the places-only re-asks into one card once there are
 * {@link MIN_PLACES_GROUP} or more. A row collapses in place the moment it
 * is answered, while its answer is sent, and the card stays while any row
 * still waits: the last answer hides it. One places-only re-ask alone keeps
 * its normal card.
 *
 * @param approvals - Every waiting app, oldest first.
 * @param focusId - The app a link singled out: it keeps its own card, which
 *   the link rings and focuses.
 */
export function usePlacesReaskGroup(
  approvals: readonly PendingExtensionApproval[],
  focusId?: string
): PlacesReaskGroup {
  const [done, setDone] = useState<Record<string, AnsweredRow>>({});
  const groupable = (approval: PendingExtensionApproval) =>
    isPlacesOnlyReask(approval) && approval.id !== focusId;
  const waiting = approvals.filter(
    (approval) => groupable(approval) && !done[reaskKeyOf(approval)]
  );
  const answeredRows = Object.values(done).sort((a, b) => a.index - b.index);
  const open = waiting.length > 0 && waiting.length + answeredRows.length >= MIN_PLACES_GROUP;

  // Once every row is answered and the server took each answer and stopped
  // listing it, the card has left; a later batch starts afresh.
  const settled =
    waiting.length === 0 &&
    answeredRows.length > 0 &&
    answeredRows.every((row) => row.sent) &&
    !approvals.some((approval) => done[reaskKeyOf(approval)]);
  useEffect(() => {
    if (settled) setDone({});
  }, [settled]);

  const rows: PlacesGroupRow[] = open
    ? waiting.map((approval) => ({ approval, answer: null }))
    : [];
  if (open) {
    for (const row of answeredRows) {
      rows.splice(Math.min(row.index, rows.length), 0, {
        approval: row.approval,
        answer: row.answer,
      });
    }
  }
  const grouped = new Set(rows.map((row) => reaskKeyOf(row.approval)));
  // A row answered here never falls back to its own card while it is sent.
  const rest = approvals.filter(
    (approval) => !grouped.has(reaskKeyOf(approval)) && !done[reaskKeyOf(approval)]
  );

  const answered = (approval: PendingExtensionApproval, answer: PlacesRowAnswer) =>
    setDone((current) => {
      const key = reaskKeyOf(approval);
      if (current[key]) return current;
      // Where it stood among the rows, so it collapses in place.
      const index = rowIndexOf(approvals.filter(groupable), current, key);
      return { ...current, [key]: { approval, answer, index, sent: false } };
    });

  const confirmed = (approval: PendingExtensionApproval) =>
    setDone((current) => {
      const row = current[reaskKeyOf(approval)];
      return row ? { ...current, [reaskKeyOf(approval)]: { ...row, sent: true } } : current;
    });

  const retracted = (approval: PendingExtensionApproval) =>
    setDone((current) => {
      const { [reaskKeyOf(approval)]: _refused, ...kept } = current;
      return kept;
    });

  return { rows, rest, answered, confirmed, retracted };
}

/** Where a row stands among the card's rows, answered ones included. */
function rowIndexOf(
  grouped: readonly PendingExtensionApproval[],
  done: Record<string, AnsweredRow>,
  key: string
): number {
  const order = grouped.map(reaskKeyOf);
  const answered = Object.values(done).sort((a, b) => a.index - b.index);
  const rows = order.filter((k) => !done[k]);
  for (const row of answered) {
    rows.splice(Math.min(row.index, rows.length), 0, reaskKeyOf(row.approval));
  }
  const index = rows.indexOf(key);
  return index === -1 ? rows.length : index;
}
