/** Public card state and diagnostic state share records but serve different reads. */
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import type { SupervisedServerStatus } from './isolated-restarts.js';

const ERROR_STATUSES = new Set(['invalid', 'incompatible', 'compile_error', 'activate_error']);

/** Cards say Restarting; diagnostics retain the stopped reason during that backoff. */
export function withSupervisedStatus<T extends ExtensionRecord | ExtensionRecordPublic>(
  record: T,
  supervised: SupervisedServerStatus,
  diagnostic = false
): T {
  if (!supervised.serverError && !supervised.restartingAt) return record;
  return {
    ...record,
    serverError:
      supervised.restartingAt && !diagnostic
        ? undefined
        : (supervised.serverError ?? record.serverError),
    restartingAt: supervised.restartingAt ?? null,
  };
}

/** Every broken extension, including a stopped server whose client bundle still loads. */
export function extensionErrors(
  records: ExtensionRecordPublic[],
  statusOf: (id: string) => SupervisedServerStatus
): ExtensionRecordPublic[] {
  return records
    .map((record) => withSupervisedStatus(record, statusOf(record.id), true))
    .filter((record) => ERROR_STATUSES.has(record.status) || !!record.serverError);
}
