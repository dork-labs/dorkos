/**
 * The parts of a notification DTO that are rebuilt from a stored row's payload
 * on read rather than stored: its actions, who decided, and a failing run's
 * mark. Split out of `notification-store.ts` to keep it under its size limit.
 *
 * @module services/notifications/stored-dto-parts
 */
import type { NotificationDTO, NotificationKind } from '@dorkos/shared/notification-schemas';
import { notificationEntry, type NotificationPayload } from './notification-registry.js';
import { logger } from '../../lib/logger.js';
import { runCompletedMark } from './run-completed-copy.js';
import { secretFilesMeta } from './secret-file-notifications.js';

/**
 * The mark a failing scheduled run's notice draws, read back from its payload
 * (DOR-3123). Nothing for any other kind, or a payload it cannot read.
 */
function buildRunMark(
  kind: NotificationKind,
  dataJson: string | null
): { mark: NonNullable<NotificationDTO['mark']> } | undefined {
  if (kind !== 'run.completed' || !dataJson) return undefined;
  try {
    const mark = runCompletedMark(JSON.parse(dataJson) as NotificationPayload<'run.completed'>);
    return mark ? { mark } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files an `agent.secret_files` notice names, as its meta line (DOR-3292).
 * Nothing for any other kind, one file (the title names it), or a payload it
 * cannot read.
 */
function buildSecretFilesMeta(
  kind: NotificationKind,
  dataJson: string | null
): { meta: string } | undefined {
  if (kind !== 'agent.secret_files' || !dataJson) return undefined;
  try {
    const meta = secretFilesMeta(JSON.parse(dataJson) as NotificationPayload<'agent.secret_files'>);
    return meta ? { meta } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who decided an `extension.decision` history row, read back from its payload
 * so the inbox can tell "you answered" from "decided while you were away"
 * (spec `flow-multiproject` §7.9). Nothing for any other kind, or a payload
 * it cannot read.
 */
function buildDecision(
  kind: NotificationKind,
  dataJson: string | null
): { decision: NonNullable<NotificationDTO['decision']> } | undefined {
  if (kind !== 'extension.decision' || !dataJson) return undefined;
  try {
    const payload = JSON.parse(dataJson) as NotificationPayload<'extension.decision'>;
    const r = payload.resolution;
    if (!r) return undefined;
    return {
      decision: {
        extensionId: payload.extensionId,
        resolvedBy: r.resolvedBy,
        resolvedByLabel: r.resolvedByLabel,
        recorded: r.recorded,
        watch: r.watch,
      },
    };
  } catch (err) {
    logger.debug('[Notifications] Could not read a decision row', { err });
    return undefined;
  }
}

/**
 * Every read-only fact a stored row's payload adds to its DTO — who decided, a
 * failing run's mark, the files a secret-files notice names — as one
 * spreadable fragment. Each part is absent unless its kind has it.
 *
 * @param kind - The row's notification kind.
 * @param dataJson - The row's stored payload.
 */
export function buildPayloadFacts(
  kind: NotificationKind,
  dataJson: string | null
): Pick<NotificationDTO, 'decision' | 'mark' | 'meta'> {
  return {
    ...(buildDecision(kind, dataJson) ?? {}),
    ...(buildRunMark(kind, dataJson) ?? {}),
    ...(buildSecretFilesMeta(kind, dataJson) ?? {}),
  };
}

/**
 * Rebuild a row's action buttons from the registry, or nothing at all.
 *
 * Returns a spreadable fragment rather than an array so the caller never puts an
 * `actions: undefined` key on a DTO that has none.
 */
export function buildActions(
  kind: NotificationKind,
  dataJson: string | null
): { actions: NotificationDTO['actions'] } | undefined {
  const build = notificationEntry(kind).actions;
  if (!build || !dataJson) return undefined;
  try {
    const actions = build(JSON.parse(dataJson) as NotificationPayload<typeof kind>);
    return actions.length > 0 ? { actions } : undefined;
  } catch (err) {
    logger.debug('[Notifications] Could not rebuild actions for a stored row', { err, kind });
    return undefined;
  }
}
