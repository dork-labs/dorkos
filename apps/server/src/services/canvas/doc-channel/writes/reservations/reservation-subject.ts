import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import type { CheckboxReservationSubject } from '../authority.js';
import { checkboxAuthoritySync } from '../authority/authority-snapshot.js';
import {
  freezeCheckboxData,
  validateCheckboxEvidence,
  VerifiedCheckboxAuthoritySchema,
} from '../checkbox-evidence.js';

/** Validate and freeze a live or recovery subject before reserving checkbox writes. */
export function captureSubject(subject: CheckboxReservationSubject): CheckboxReservationSubject {
  checkboxAuthoritySync(subject);
  const approved = freezeCheckboxData(VerifiedCheckboxAuthoritySchema.parse(subject.approved));
  if (subject.kind === 'live')
    return freezeCheckboxData({
      kind: 'live',
      request: CanvasChannelCheckboxRequestSchema.parse(subject.request),
      actor: { principal: subject.actor.principal, surface: subject.actor.surface },
      approved,
    });
  if (subject.kind !== 'recovery') throw new Error('Unknown checkbox reservation subject.');
  const original = structuredClone(subject.intent);
  validateCheckboxEvidence(original);
  return freezeCheckboxData({ kind: 'recovery', intent: original, approved });
}
