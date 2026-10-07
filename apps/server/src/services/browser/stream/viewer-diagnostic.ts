import { logger } from '../../../lib/logger.js';
/** Private diagnostic vocabulary. Never accepts request data or error properties. */
export type BrowserViewerDiagnosticStage =
  | 'router.binding-parse'
  | 'router.binding-select'
  | 'router.binding-dispatch'
  | 'router.ticket-parse'
  | 'router.ticket-select'
  | 'router.ticket-dispatch'
  | 'issue.origin-or-config'
  | 'issue.binding'
  | 'issue.auth'
  | 'issue.grant'
  | 'issue.current.admission'
  | 'issue.current.registry'
  | 'issue.current.binding'
  | 'issue.current.final-admission'
  | 'issue.current.config'
  | 'issue.current.actor'
  | 'issue.final-origin'
  | 'issue.pixels'
  | 'publication.origin-or-config'
  | 'publication.auth'
  | 'publication.actor'
  | 'publication.pixels'
  | 'publication.headers'
  | 'publication.publish'
  | 'selection.mode-before'
  | 'selection.identity'
  | 'selection.absent'
  | 'selection.multiple'
  | 'selection.mode-selected'
  | 'selection.current'
  | 'selection.mode-after'
  | 'session.closed'
  | 'session.mode'
  | 'session.grant'
  | 'session.acquired'
  | 'session.network'
  | 'network.stopped'
  | 'network.acquired'
  | 'network.native-before'
  | 'network.authorize'
  | 'network.peer'
  | 'network.issuer'
  | 'network.native-after'
  | 'authority.original'
  | 'authority.active'
  | 'authority.owner'
  | 'authority.workspace'
  | 'authority.ordinary'
  | 'authority.current'
  | 'authority.native'
  | 'authority.origins'
  | 'authority.runtime'
  | 'authority.inventory'
  | 'facts.stopped'
  | 'facts.revoked'
  | 'facts.epoch'
  | 'facts.auth'
  | 'facts.runtime'
  | 'facts.session-id'
  | 'facts.owner-read'
  | 'facts.session-read'
  | 'facts.workspace-read'
  | 'facts.owner'
  | 'facts.session'
  | 'facts.session-owner'
  | 'facts.session-expired'
  | 'facts.session-changed'
  | 'facts.workspace'
  | 'facts.workspace-status'
  | 'facts.workspace-changed'
  | 'facts.clock'
  | 'authority.clock';
/** Keeps exact first operational cause boxed privately, including falsy values.
 * Emission is bounded and failure-isolated; only literal stage/ordinal leaves. */
export function createBrowserViewerDiagnostic(
  emit: (row: Readonly<{ stage: BrowserViewerDiagnosticStage; ordinal: number }>) => void
) {
  let count = 0;
  let first: Readonly<{ value: unknown }> | undefined;
  const note = (stage: BrowserViewerDiagnosticStage) => {
    if (count >= 16) return;
    const row = Object.freeze({ stage, ordinal: ++count });
    try {
      emit(row);
    } catch {
      /* Diagnostic failure cannot replace the actual authority/custody result. */
    }
  };
  return Object.freeze({
    note,
    failure(stage: BrowserViewerDiagnosticStage, value: unknown): unknown {
      first ??= Object.freeze({ value }); // Retain original before entering a logger/observer.
      note(stage);
      return value;
    },
    originalFailure: () => first,
  });
}

/** Capture the initialized original logger once; only bounded fixed stage codes are emitted. */
export function createOriginalBrowserViewerDiagnostic() {
  let info: typeof logger.info | undefined;
  try {
    const original = logger;
    info = original.info.bind(original);
  } catch {
    /* Non-authoritative sink. */
  }
  return createBrowserViewerDiagnostic((row) =>
    info?.('Browser viewer original refusal stage', row)
  );
}
