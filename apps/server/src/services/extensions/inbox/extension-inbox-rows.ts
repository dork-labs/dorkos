/**
 * Reading a stored `extension_decisions` row back into the shapes each
 * reader wants (spec `flow-multiproject` §7.2, §11): the extension's own
 * {@link RaisedDecision}, the inbox's {@link ExtensionDecisionDTO}, and the
 * `extension.decision` notification payload the bell, the history row and the
 * escalation ladder are built from.
 *
 * @module services/extensions/extension-inbox-rows
 */
import path from 'path';
import type { ExtensionDecisionRow } from '@dorkos/db';
import type {
  DecisionActions,
  DecisionOffer,
  DecisionWatch,
  ProjectRef,
  RaisedDecision,
} from '@dorkos/extension-api/server';
import type { ExtensionDecisionDTO } from '@dorkos/shared/extension-decision-schemas';
import type { NotificationPayload } from '../../notifications/notification-registry.js';

/** A person's answer the extension kept open, held until the row resolves. */
export interface PendingAction {
  /** The `pendingActionId` handed to the extension. */
  id: string;
  /** What they chose. */
  action: 'approve' | 'reject' | 'word' | 'choice';
  /** The chosen chip, for a question. */
  choiceId: string | null;
  /** What was chosen, in words, for the history row. */
  choiceLabel: string | null;
  /** The note or typed answer. */
  note: string | null;
  /** When they answered. */
  at: string;
}

/** An offer as stored, with when it was made. */
export interface StoredOffer extends DecisionOffer {
  /** When the offer was made (it lapses 15 minutes later). */
  createdAt: string;
  /**
   * `answer`: made in reply to an answer, returned to the client that gave
   * it and never listed. `answering`: made when the extension settled a kept
   * answer later, so it is listed for the person's next open app.
   */
  via: 'answer' | 'answering';
}

/** Parse a JSON column, or null when empty or unreadable. */
export function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * A row's actions as the reader should see them. `actions_json` holds them as
 * the extension asked; a question's deadline shown is the one in effect (the
 * `decide_by` column, clamped once when the question was first asked). Once
 * the deadline is dealt with (a person answered, or the extension kept the
 * row open, settled it, or could not be reached), it is dropped, so the
 * deadline line goes away.
 *
 * @param row - The stored row.
 */
export function actionsOf(row: ExtensionDecisionRow): DecisionActions {
  const actions = parseJson<DecisionActions>(row.actionsJson) ?? {
    kind: 'word',
    label: 'Open',
  };
  if (actions.kind !== 'choice') return actions;
  const { decideBy: _asked, ...rest } = actions;
  return row.decideBy && row.deadlineState === null ? { ...rest, decideBy: row.decideBy } : rest;
}

/**
 * The project a stored root names, with the registry's stable name when it
 * knows it, else the folder's own name.
 *
 * @param root - The stored project root, or null.
 * @param lookup - The registry's lookup by root.
 */
export function projectOf(
  root: string | null,
  lookup: (root: string) => { name: string } | undefined
): ProjectRef | null {
  if (!root) return null;
  return { root, name: lookup(root)?.name ?? path.basename(root) };
}

/**
 * The decision as the extension that raised it sees it.
 *
 * @param row - The stored row.
 * @param project - Its project.
 */
export function toRaisedDecision(
  row: ExtensionDecisionRow,
  project: ProjectRef | null
): RaisedDecision {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    why: row.why,
    detail: row.detail,
    project,
    projectLabel: row.projectLabel,
    since: row.since,
    actions: actionsOf(row),
    link: row.link,
    raisedAt: row.raisedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The decision as the inbox draws it.
 *
 * @param row - The stored row.
 * @param project - Its project.
 */
export function toDecisionDTO(
  row: ExtensionDecisionRow,
  project: ProjectRef | null
): ExtensionDecisionDTO {
  return {
    id: row.id,
    extensionId: row.extensionId,
    extensionName: row.extensionName,
    key: row.key,
    title: row.title,
    why: row.why,
    detail: row.detail,
    project,
    projectLabel: row.projectLabel,
    since: row.since,
    actions: actionsOf(row),
    link: row.link,
    raisedAt: row.raisedAt,
    needsYou: row.deadlineState === 'failed',
    watch: parseJson<DecisionWatch>(row.watchJson),
    revision: row.revision,
  };
}

/**
 * The `extension.decision` payload for a row: the raise edge without a
 * resolution, the history edge with one.
 *
 * @param row - The stored row (after its resolution was written, for the history edge).
 * @param openProjects - In how many projects the extension has open decisions.
 */
export function payloadOf(
  row: ExtensionDecisionRow,
  openProjects: number
): NotificationPayload<'extension.decision'> {
  const payload: NotificationPayload<'extension.decision'> = {
    decisionId: row.id,
    extensionId: row.extensionId,
    extensionName: row.extensionName,
    key: row.key,
    title: row.title,
    why: row.why,
    link: row.link,
    openProjects,
  };
  if (row.resolvedAt && row.outcome && row.resolvedBy) {
    payload.resolution = {
      outcome: row.outcome as NonNullable<typeof payload.resolution>['outcome'],
      resolvedBy: row.resolvedBy,
      resolvedByLabel: row.resolvedByLabel,
      choiceLabel: row.choiceLabel,
      recorded: row.recorded === 1,
      watch: parseJson<DecisionWatch>(row.watchJson),
    };
  }
  return payload;
}

/**
 * What was chosen, in words, for the history row: the button's own label for
 * a yes-or-no, the chip for a question.
 *
 * @param actions - The decision's actions.
 * @param outcome - How it ended.
 * @param choiceId - The chosen chip, when one was.
 */
export function choiceWords(
  actions: DecisionActions,
  outcome: string,
  choiceId: string | null
): string | null {
  if (actions.kind === 'yes-no') {
    if (outcome === 'approved') return actions.approveLabel;
    if (outcome === 'rejected') return actions.rejectLabel;
    return null;
  }
  if (actions.kind === 'choice') {
    if (choiceId) return actions.choices.find((c) => c.id === choiceId)?.label ?? null;
    return null;
  }
  return null;
}
