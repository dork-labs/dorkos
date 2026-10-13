/**
 * What an `extension.decision` notification says: the phone push that names
 * only who and how many projects, and the history row's "what was chosen · who";
 * and where an `extension.approval` row files itself. Split from the registry,
 * whose entries for the two kinds call these.
 *
 * @module services/notifications/extension-decision-copy
 */
import { extensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';
import type { NotificationLocation, NotificationPayload } from './notification-registry.js';

/** Counts an extension's projects with open decisions right now, when the inbox is up. */
let openProjectCounter: ((extensionId: string) => number) | null = null;

/**
 * Let the inbox answer "in how many projects?" live, so a push sent minutes
 * after the first decision counts every project open by then.
 *
 * @param counter - The live count, or null to fall back to the payload's.
 */
export function setOpenProjectCounter(counter: ((extensionId: string) => number) | null): void {
  openProjectCounter = counter;
}

/** One phone push per extension per hour, whatever number of its decisions stand. */
export const EXTENSION_DECISION_PUSH_WINDOW_MS = 60 * 60 * 1000;

/**
 * What a phone is told about an extension's decisions: who, and in how many
 * projects, never the title, key or project name (spec `flow-multiproject`
 * §7.1). The row in the app carries the detail.
 *
 * @param p - That kind's payload.
 */
export function extensionDecisionEscalation(p: NotificationPayload<'extension.decision'>): {
  title: string;
} {
  const open = openProjectCounter?.(p.extensionId) ?? p.openProjects;
  if (open <= 0) return { title: `${p.extensionName} needs you` };
  const projects = open === 1 ? '1 project' : `${open} projects`;
  return { title: `${p.extensionName} needs you in ${projects}` };
}

/**
 * Who decided, in the words a history row uses (spec §7.9): "you", "decided by
 * the agent", or the label the extension gave ("the reviewer agent"). The
 * time is added by the surface, in the viewer's zone.
 *
 * @param resolution - How the decision was settled.
 * @param extensionName - The extension's manifest name.
 */
function decidedByWords(
  resolution: NonNullable<NotificationPayload<'extension.decision'>['resolution']>,
  extensionName: string
): string {
  switch (resolution.resolvedBy) {
    case 'person':
      return 'you';
    case 'deadline':
      return 'decided by the agent';
    case 'extension':
      return resolution.resolvedByLabel ? `answered ${resolution.resolvedByLabel}` : extensionName;
    default:
      return resolution.resolvedByLabel ?? extensionName;
  }
}

/**
 * The second part of an `extension.decision` history row (spec §7.4): "Resolved
 * on its own", "No longer needed", or "<what was chosen> · <who>".
 *
 * @param p - That kind's payload, with its resolution.
 */
export function extensionDecisionHistoryBody(
  p: NotificationPayload<'extension.decision'>
): string | undefined {
  const r = p.resolution;
  if (!r) return p.why;
  if (r.outcome === 'cleared') return 'Resolved on its own';
  if (r.outcome === 'cancelled') return 'No longer needed';
  const who = decidedByWords(r, p.extensionName);
  return r.choiceLabel ? `${r.choiceLabel} · ${who}` : who;
}

/**
 * Where an `extension.approval` row files itself: the exact copy.
 *
 * @param p - That kind's payload.
 * @returns The row's subject.
 */
export function subjectIdForCopy(
  p: NotificationPayload<'extension.approval'>
): NotificationLocation {
  return {
    subjectId: extensionApprovalSubjectId({
      id: p.id,
      path: p.path,
      plugin: p.plugin,
      version: p.version,
    }),
  };
}
