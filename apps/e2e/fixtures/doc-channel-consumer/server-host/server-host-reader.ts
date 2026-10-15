import type { OwnedEvidenceReader } from '../server-host.js';
import { requireOriginalHostOperations } from '../server-host.js';

/** Original finite host reader controls, selected only by private constructor key. */
export function createOriginalHostReader(ownerKey: object): {
  readOwnedEvidence: OwnedEvidenceReader;
} {
  const context = requireOriginalHostOperations(ownerKey);
  const { launched, target } = context;
  let evidenceSequence = 0,
    evidencePending = false;
  const readOwnedEvidence = <T>(
    kind:
      | 'read-room-scenario-data'
      | 'read-native-integrity-data'
      | 'start-native-integrity-observation'
      | 'read-checkbox-pair-data'
      | 'read-canonical-recovery-data'
      | 'read-selection-data'
      | 'read-reviewed-replay-data'
      | 'read-saved-data'
      | 'read-presence-data'
      | 'read-mcp-app-data',
    responseKind: string,
    validate: (value: unknown) => value is T
  ) =>
    new Promise<T>((resolve, reject) => {
      if (
        (target !== 'room' &&
          !(
            target === 'session' &&
            ((kind === 'read-checkbox-pair-data' && responseKind === 'checkbox-pair-data') ||
              (kind === 'read-selection-data' && responseKind === 'selection-data') ||
              (kind === 'read-reviewed-replay-data' && responseKind === 'reviewed-replay-data') ||
              (kind === 'read-saved-data' && responseKind === 'saved-data') ||
              (kind === 'read-presence-data' && responseKind === 'presence-data') ||
              (kind === 'read-mcp-app-data' && responseKind === 'mcp-app-data'))
          )) ||
        context.retired ||
        context.failed ||
        !launched.connected ||
        evidencePending ||
        evidenceSequence >= 96
      ) {
        reject(new Error('Owned Room evidence control unavailable'));
        return;
      }
      evidencePending = true;
      const id = ++evidenceSequence;
      const cleanup = () => {
        evidencePending = false;
        launched.off('message', receive);
        launched.off('close', unavailable);
      };
      const unavailable = () => {
        cleanup();
        reject(new Error('Owned Room evidence child closed'));
      };
      const receive = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const row = value as {
          kind?: unknown;
          id?: unknown;
          data?: unknown;
          ok?: unknown;
          failureMessage?: unknown;
          undefinedCause?: unknown;
        };
        if (row.kind !== responseKind || row.id !== id) return;
        cleanup();
        if (row.ok !== true || !validate(row.data)) {
          console.error(
            'ORIGINAL_NATIVE_EVIDENCE_FAILURE',
            JSON.stringify({
              responseKind,
              nativeReadSucceeded: row.ok === true,
              rawUndefined: row.undefinedCause === true,
              reason:
                typeof row.failureMessage === 'string'
                  ? row.failureMessage.slice(0, 512)
                  : undefined,
            })
          );
          reject(new Error('Owned original Room evidence mismatch'));
          return;
        }
        resolve(row.data);
      };
      launched.on('message', receive);
      launched.once('close', unavailable);
      try {
        launched.send({ kind, id }, (cause) => {
          if (cause) {
            cleanup();
            reject(cause);
          }
        });
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    });

  return { readOwnedEvidence };
}
