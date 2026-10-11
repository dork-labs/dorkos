import type { openNativeConsumerStore } from '../channel-store.js';
import { requireOriginalHostOperations } from '../server-host.js';
import type { NativeRoomScenarioData } from '../server.js';
import type { NativeEmissionIntegrityData } from '../native-emission-integrity-control.js';
/** Original finite host scenario-data controls, selected only by private constructor key. */
export function createOriginalHostScenarioData(ownerKey: object) {
  const context = requireOriginalHostOperations(ownerKey);
  const { ready, integrityCase, readOwnedEvidence } = context;
  type CheckboxPairData = Awaited<
    ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalCheckboxPairData']>
  >;
  type SelectionData = Awaited<
    ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalSelectionData']>
  >;
  type McpAppData = Awaited<
    ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalMcpAppData']>
  >;

  const readOriginalRoomScenarioData = () =>
    readOwnedEvidence(
      'read-room-scenario-data',
      'room-scenario-data',
      (value): value is NativeRoomScenarioData => {
        const data = value as NativeRoomScenarioData | undefined;
        return (
          !!data &&
          data.documentId === ready.documentId &&
          data.scope === 'room:' + ready.roomId &&
          data.meaning === 'PROVIDER_BOUNDARY_DATA_ONLY_ABSENCE_UNKNOWN' &&
          typeof data.targetSessionId === 'string' &&
          /^[0-9a-f-]{36}$/i.test(data.targetSessionId) &&
          typeof data.targetLocked === 'boolean' &&
          Array.isArray(data.batches) &&
          data.batches.length <= 32
        );
      }
    );
  const startNativeEmissionIntegrityObservation = () =>
    readOwnedEvidence(
      'start-native-integrity-observation',
      'native-integrity-started',
      (value): value is { started: true } =>
        !!value &&
        typeof value === 'object' &&
        Object.keys(value).length === 1 &&
        (value as { started?: unknown }).started === true
    );
  const readNativeEmissionIntegrityData = () =>
    readOwnedEvidence(
      'read-native-integrity-data',
      'native-integrity-data',
      (value): value is NativeEmissionIntegrityData => {
        if (!value || typeof value !== 'object') return false;
        const data = value as NativeEmissionIntegrityData;
        return (
          data.caseName === integrityCase &&
          ['waiting', 'armed', 'restored'].includes(data.phase) &&
          (data.ackId === null ||
            (typeof data.ackId === 'string' &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                data.ackId
              ))) &&
          Number.isSafeInteger(data.replacementCalls) &&
          data.replacementCalls >= 0 &&
          (data.retired === null || typeof data.retired === 'boolean') &&
          typeof data.observerFailed === 'boolean' &&
          (data.observerFailure === null ||
            (typeof data.observerFailure === 'string' && data.observerFailure.length <= 512)) &&
          data.observerFailed === (data.observerFailure !== null)
        );
      }
    );
  const readCanonicalRecoveryData = () =>
    readOwnedEvidence(
      'read-canonical-recovery-data',
      'canonical-recovery-data',
      (value): value is { canonicalId: string; closed: boolean } =>
        !!value &&
        typeof value === 'object' &&
        typeof (value as { canonicalId?: unknown }).canonicalId === 'string' &&
        typeof (value as { closed?: unknown }).closed === 'boolean'
    );
  const readOriginalCheckboxPairData = () =>
    readOwnedEvidence<CheckboxPairData>(
      'read-checkbox-pair-data',
      'checkbox-pair-data',
      (value): value is CheckboxPairData => {
        if (!value || typeof value !== 'object') return false;
        const data = value as CheckboxPairData;
        return (
          typeof data.documentId === 'string' &&
          typeof data.baselineRestored === 'boolean' &&
          Array.isArray(data.events) &&
          data.events.length <= 2 &&
          Array.isArray(data.receipts) &&
          data.receipts.length <= 2 &&
          Array.isArray(data.savedEvents) &&
          data.savedEvents.length <= 1 &&
          Array.isArray(data.deliveries) &&
          data.deliveries.length <= 2 &&
          Array.isArray(data.batches) &&
          data.batches.length <= 2 &&
          [data.admissions, data.spend, data.privateAdmissions, data.scenarioStarts].every(
            (n) => Number.isSafeInteger(n) && n >= 0
          ) &&
          typeof data.targetLocked === 'boolean'
        );
      }
    );
  type SavedData = Awaited<
    ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalSavedData']>
  >;
  type PresenceData = Awaited<
    ReturnType<Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalPresenceData']>
  >;
  const readOriginalPresenceData = () =>
    readOwnedEvidence<PresenceData>(
      'read-presence-data',
      'presence-data',
      (value): value is PresenceData => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('documentId' in value) ||
          typeof value.documentId !== 'string' ||
          !('events' in value) ||
          !Array.isArray(value.events) ||
          value.events.length > 32 ||
          !('batches' in value) ||
          typeof value.batches !== 'number' ||
          !Number.isSafeInteger(value.batches) ||
          value.batches < 0 ||
          !('admissions' in value) ||
          typeof value.admissions !== 'number' ||
          !Number.isSafeInteger(value.admissions) ||
          value.admissions < 0
        )
          return false;
        return value.events.every(
          (event) =>
            event &&
            typeof event === 'object' &&
            'type' in event &&
            ['host.opened', 'host.closed', 'doc.viewers', 'host.focus'].includes(event.type) &&
            'payload' in event
        );
      }
    );
  const readOriginalSavedData = () =>
    readOwnedEvidence<SavedData>('read-saved-data', 'saved-data', (value): value is SavedData => {
      if (!value || typeof value !== 'object') return false;
      const data = value as SavedData;
      return (
        typeof data.documentId === 'string' &&
        /^[a-f0-9]{64}$/.test(data.fileHash) &&
        /^[a-f0-9]{64}$/.test(data.baselineHash) &&
        typeof data.failureArmed === 'boolean' &&
        Array.isArray(data.events) &&
        data.events.length <= 1 &&
        Array.isArray(data.deliveries) &&
        data.deliveries.length <= 1 &&
        Array.isArray(data.admissions) &&
        data.admissions.length <= 1 &&
        Number.isSafeInteger(data.scenarioStarts) &&
        data.scenarioStarts >= 0
      );
    });
  const readOriginalSelectionData = () =>
    readOwnedEvidence<SelectionData>(
      'read-selection-data',
      'selection-data',
      (value): value is SelectionData => {
        if (!value || typeof value !== 'object') return false;
        const data = value as SelectionData;
        return (
          typeof data.documentId === 'string' &&
          typeof data.fileUnchanged === 'boolean' &&
          Array.isArray(data.events) &&
          data.events.length <= 1 &&
          Array.isArray(data.deliveries) &&
          data.deliveries.length <= 1 &&
          Array.isArray(data.admissions) &&
          data.admissions.length <= 1 &&
          Number.isSafeInteger(data.scenarioStarts) &&
          data.scenarioStarts >= 0
        );
      }
    );
  type ReviewedReplayData = Awaited<
    ReturnType<
      Awaited<ReturnType<typeof openNativeConsumerStore>>['readOriginalReviewedReplayData']
    >
  >;
  const readOriginalReviewedReplayData = () =>
    readOwnedEvidence<ReviewedReplayData>(
      'read-reviewed-replay-data',
      'reviewed-replay-data',
      (value): value is ReviewedReplayData => {
        if (!value || typeof value !== 'object') return false;
        const data = value as ReviewedReplayData;
        return (
          typeof data.documentId === 'string' &&
          typeof data.baselineUnchanged === 'boolean' &&
          Array.isArray(data.events) &&
          data.events.length <= 1 &&
          Array.isArray(data.batches) &&
          data.batches.length <= 2 &&
          Array.isArray(data.deliveries) &&
          data.deliveries.length <= 1 &&
          Array.isArray(data.receipts) &&
          data.receipts.length <= 1 &&
          Number.isSafeInteger(data.scenarioStarts) &&
          data.scenarioStarts >= 0
        );
      }
    );
  const readOriginalMcpAppData = () =>
    readOwnedEvidence<McpAppData>(
      'read-mcp-app-data',
      'mcp-app-data',
      (value): value is McpAppData =>
        !!value &&
        typeof value === 'object' &&
        'documentId' in value &&
        typeof value.documentId === 'string' &&
        'events' in value &&
        Array.isArray(value.events) &&
        value.events.length <= 6
    );

  return {
    readOriginalRoomScenarioData,
    startNativeEmissionIntegrityObservation,
    readNativeEmissionIntegrityData,
    readCanonicalRecoveryData,
    readOriginalCheckboxPairData,
    readOriginalPresenceData,
    readOriginalSavedData,
    readOriginalSelectionData,
    readOriginalReviewedReplayData,
    readOriginalMcpAppData,
  };
}
