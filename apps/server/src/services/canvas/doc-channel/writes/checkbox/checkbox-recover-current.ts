import { ZodError } from 'zod';
import { CanvasChannelCheckboxRequestSchema } from '@dorkos/shared/canvas-channel-schemas';
import { DocChannelCorruptionError } from '../../store.js';
import { withRecognizedCanonicalFiles } from '../canonical-writer.js';
import { assertCheckboxReplacement, cleanCheckboxTemporary } from '../checkbox-file.js';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';
import { assertRecognizedCheckboxRecoveryRead } from '../checkbox-fence.js';
import {
  UNRESOLVED_CHECKBOX_STATUSES,
  CheckboxEvidenceError,
  freezeCheckboxData,
  requireSameCheckboxAuthority,
  type CheckboxReceipt,
} from '../checkbox-evidence.js';
import { readOriginalCheckboxWriteOperationContext } from '../checkbox-service.js';
/** Original recorded-effect recovery operation; genuine private constructor membership precedes effects. */
export function runOriginalCheckboxRecoverCurrent(
  engineOwner: object,
  id: string
): Promise<CheckboxReceipt> {
  const facet = readOriginalCheckboxWriteOperationContext(engineOwner);
  return facet.track(async () => {
    facet.boundary();
    const row = freezeCheckboxData(facet.store.getWriteIntent(id));
    if (!row) throw new Error('Checkbox intent is absent.');
    facet.validate(row);
    if (
      !UNRESOLVED_CHECKBOX_STATUSES.includes(
        row.status as (typeof UNRESOLVED_CHECKBOX_STATUSES)[number]
      ) ||
      row.status === 'in_doubt'
    )
      return facet.receipt(row);
    const approved = facet.validate(row).authority;
    try {
      const prepared = await facet.authority.prepareRecovery(row);
      requireSameCheckboxAuthority(approved, prepared);
      facet.boundary();
      return await withRecognizedCanonicalFiles<CheckboxReceipt>(
        facet.coordinator,
        [row.canonicalPath],
        async (identities, lease) => {
          facet.boundary();
          let current = facet.store.getWriteIntent(id)!;
          facet.validate(current);
          if (current.status === 'committed') return facet.receipt(current);
          if (JSON.stringify(current) !== JSON.stringify(row))
            throw new CheckboxEvidenceError('Checkbox recovery raced.');
          const assertFs = () => {
            facet.boundary();
            assertRecognizedCheckboxRecoveryRead(
              facet.writeFence,
              facet.db,
              facet.store,
              identities[0]!,
              current
            );
          };
          const snapshot = await facet.authority.refreshRecoveryCurrent(current, approved);
          const file = await facet.readSource(approved, assertFs);
          if (file.device !== identities[0]!.device || file.inode !== identities[0]!.inode)
            throw new CheckboxEvidenceError('Checkbox recovery source identity changed.');
          facet.authority.transaction((tx) =>
            facet.authority.requireRecoveryCurrent(current, approved, snapshot, tx)
          );
          await cleanCheckboxTemporary(current, assertFs);
          assertFs();
          const checked = await facet.readSource(approved, assertFs);
          const hash = rawByteHash(checked.bytes);
          if (hash === current.beforeHash) return facet.receipt(current);
          if (hash !== current.afterHash || current.beforeHash === current.afterHash) {
            facet.quarantine(current, 'unknown_file_state');
            return facet.receipt(facet.store.getWriteIntent(id) ?? current);
          }
          const evidence = facet.validate(current),
            before = Buffer.from(checked.bytes);
          before[evidence.markerOffset!] = evidence.beforeMarker!;
          assertCheckboxReplacement(current, checked);
          let edit: ReturnType<typeof prepareCheckboxBytes>;
          try {
            edit = prepareCheckboxBytes(
              before,
              CanvasChannelCheckboxRequestSchema.parse(current.input)
            );
          } catch (cause) {
            throw new CheckboxEvidenceError('Checkbox reconstructed source differs.', { cause });
          }
          if (edit.markerOffset !== evidence.markerOffset || !edit.after.equals(checked.bytes))
            throw new CheckboxEvidenceError('Checkbox reconstructed source differs.');
          if (current.status === 'prepared') {
            const replacedSnapshot = await facet.authority.refreshRecoveryCurrent(
              current,
              approved
            );
            const verified = await facet.readSource(approved, assertFs);
            assertCheckboxReplacement(current, verified);
            assertFs();
            current = facet.authority.transaction((tx) =>
              facet.completion.replaceInTransaction(
                {
                  expected: current,
                  subject: { kind: 'recovery', intent: current, approved },
                  freshSnapshot: replacedSnapshot,
                },
                tx
              )
            );
          }
          // Changed-row recovery obtains a NEW full-row snapshot, never the prepared token.
          return facet.complete(
            current,
            { kind: 'recovery', intent: current, approved },
            assertFs,
            lease
          );
        }
      );
    } catch (error) {
      if (
        error instanceof CheckboxEvidenceError ||
        error instanceof ZodError ||
        error instanceof DocChannelCorruptionError ||
        facet.authorityRefused(error)
      )
        facet.quarantine(row, 'recovery_authority_unavailable');
      throw error;
    }
  });
}
