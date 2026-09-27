/**
 * What an app lets agents do, sorted the way its side panel shows it: a Look
 * bucket and a Change bucket, tied to the access level the person picked.
 *
 * Look and Change come straight from the safety classification the grant
 * review enforces: `read` is Look, anything else is Change. Which actions a
 * level includes comes from {@link levelIncludes}, the same rule the level
 * presets grant with, so the panel can never promise more or less than a
 * level actually allows.
 *
 * @module features/connections/lib/app-actions
 */
import type { ConnectorAppAction } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorOperationClassification } from '@dorkos/shared/connector-schemas';
import type { CardAccessLevel } from './access-card-selection';
import { actionName } from './app-panel-copy';
import { levelIncludes } from './reconciliation-selection';

/** The two buckets an action falls into. */
export type ActionKind = 'look' | 'change';

/** How many actions a bucket shows before "See all". */
export const BUCKET_LIMIT = 6;

/**
 * Look or Change for one safety classification: only `read` is Look.
 *
 * @param classification - The action's stored safety classification.
 */
export function actionKind(classification: ConnectorOperationClassification): ActionKind {
  return classification === 'read' ? 'look' : 'change';
}

/**
 * A service's own action name in plain sentence case: "Send Email" reads
 * "Send email", while names like "GitHub" and "PR" keep their capitals. With
 * no name from the service, the name is read from the action's id.
 *
 * @param action - One listed action.
 * @param toolkit - The app's service id.
 */
export function plainActionName(action: ConnectorAppAction, toolkit: string): string {
  const name = action.displayName?.trim();
  if (!name) return actionName(action.operationSlug, toolkit);
  const words = name.split(/\s+/u).map((word, index) => {
    if (index === 0) return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    // An acronym ("PR", "URL") or a brand with an inner capital ("GitHub") keeps its shape.
    return /[A-Z]/u.test(word.slice(1)) ? word : word.toLowerCase();
  });
  return words.join(' ');
}

/** The main ones first (the service's own "important" mark), then the service's order. */
function byImportance(actions: readonly ConnectorAppAction[]): ConnectorAppAction[] {
  return [...actions.filter((a) => a.important), ...actions.filter((a) => !a.important)];
}

/** What the panel shows for one level. */
export interface ActionBuckets {
  /** Read actions the level allows, main ones first. */
  look: ConnectorAppAction[];
  /** Changing actions the level allows, main ones first. Empty on "Read". */
  change: ConnectorAppAction[];
  /**
   * Changing actions the picked level leaves out but the other level would
   * add (only on "Read", and only when the app has any).
   */
  addedByReadWrite: ConnectorAppAction[];
  /**
   * Changing actions that neither level includes, such as deleting. They can
   * only be allowed one by one through exact actions.
   */
  outsideLevels: ConnectorAppAction[];
}

/**
 * Sort an app's actions into what a level lets agents do.
 *
 * With no level (before an app is connected, or while agents hold different
 * levels) the buckets describe the app itself: every read action is Look and
 * every other action is Change, with nothing promised about a level.
 *
 * @param actions - The app's listed actions.
 * @param level - The level the person picked, or `null` for none.
 */
export function actionBuckets(
  actions: readonly ConnectorAppAction[],
  level: CardAccessLevel | null
): ActionBuckets {
  const ranked = byImportance(actions);
  const look = ranked.filter((a) => actionKind(a.capabilityClassification) === 'look');
  const changing = ranked.filter((a) => actionKind(a.capabilityClassification) === 'change');
  if (level === null) {
    return { look, change: changing, addedByReadWrite: [], outsideLevels: [] };
  }
  return {
    look: look.filter((a) => levelIncludes(a.capabilityClassification, level)),
    change: changing.filter((a) => levelIncludes(a.capabilityClassification, level)),
    addedByReadWrite: changing.filter(
      (a) =>
        !levelIncludes(a.capabilityClassification, level) &&
        levelIncludes(a.capabilityClassification, 'read-write')
    ),
    outsideLevels: changing.filter((a) => !levelIncludes(a.capabilityClassification, 'read-write')),
  };
}

/**
 * Whether an app offers the "Read and write" level at all: only when it has
 * an action that level adds to "Read". The access card offers the level by
 * the same rule.
 *
 * @param actions - The app's listed actions.
 */
export function offersReadWrite(actions: readonly ConnectorAppAction[]): boolean {
  return actions.some(
    (a) =>
      levelIncludes(a.capabilityClassification, 'read-write') &&
      !levelIncludes(a.capabilityClassification, 'read')
  );
}

/**
 * "send email and draft replies", "send email, draft replies and 3 more":
 * the first two plain names, lowercased, as a phrase inside a sentence.
 *
 * @param actions - The actions to name, main ones first.
 * @param toolkit - The app's service id.
 */
export function examplePhrase(actions: readonly ConnectorAppAction[], toolkit: string): string {
  const names = actions.slice(0, 2).map((a) => lowerFirst(plainActionName(a, toolkit)));
  const rest = actions.length - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} more`;
  return names.join(' and ');
}

function lowerFirst(name: string): string {
  const first = name.split(' ')[0] ?? '';
  // "PR reviews" stays as is; "Send email" becomes "send email".
  return /[A-Z]/u.test(first.slice(1)) ? name : `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}
