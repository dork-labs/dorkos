/** Pure verified checkbox DATA projection; no completion owner or transaction authority. */
import {
  CanvasChannelCheckboxRequestSchema,
  StoredPageEventSchema,
  type StoredPageEvent,
} from '@dorkos/shared/canvas-channel-schemas';
import type { DocWriteIntentRow } from '../store.js';
import { envelopeIdentity } from '../envelope.js';
import {
  CheckboxEvidenceError,
  freezeCheckboxData,
  validateCheckboxEvidence,
} from './checkbox-evidence.js';

/** Fixed host input, independent of the original write-request fingerprint. */
export interface VerifiedCheckboxProjection {
  intent: DocWriteIntentRow;
  event: StoredPageEvent;
  identity: { hash: string; bytes: number };
  provenance: { transport: 'host'; producer: 'verified_checkbox'; intentId: string };
}

/** Derive only the fixed host envelope; physical byte verification remains a caller obligation. */
export function projectVerifiedCheckbox(intent: DocWriteIntentRow): VerifiedCheckboxProjection {
  const evidence = validateCheckboxEvidence(intent);
  if (evidence.v !== 2 || evidence.receipt || evidence.preEffectRefusal)
    throw new CheckboxEvidenceError('Checkbox completion requires current physical evidence.');
  const request = CanvasChannelCheckboxRequestSchema.parse(intent.input);
  const event = StoredPageEventSchema.parse({
    v: 1,
    id: intent.eventId,
    type: 'md.task.toggled',
    payload: {
      line: request.line,
      done: request.done,
      textHash: request.textHash,
      beforeFileVersion: intent.beforeHash,
      afterFileVersion: intent.afterHash,
    },
  });
  return freezeCheckboxData({
    intent: structuredClone(intent),
    event,
    identity: envelopeIdentity(event),
    provenance: { transport: 'host', producer: 'verified_checkbox', intentId: intent.intentId },
  });
}
