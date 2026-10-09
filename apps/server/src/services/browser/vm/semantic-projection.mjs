import { BrowserReferenceSchema } from '@dorkos/shared/browser-schemas';
import { SemanticSnapshotV1Schema } from '@dorkos/shared/browser-semantic-schemas';
/** Content validation only. Original host authority/lifetime is checked by the
 * constructor-owned dispatcher before and after invoking this projection. */
export function projectOriginalVMSemanticSnapshot(value, identity) {
  const required = [
    'guestLease',
    'treeRef',
    'revision',
    'capturedAt',
    'expiresInMs',
    'rootRefs',
    'nodes',
    'focusedRef',
    'focusState',
    'focusRevision',
    'completeness',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && key !== 'reason')
  )
    throw new Error('VM_SEMANTIC_SNAPSHOT_FIELDS');
  const { guestLease, treeRef, revision, ...fields } = value;
  BrowserReferenceSchema.parse(guestLease);
  BrowserReferenceSchema.parse(treeRef);
  const snapshot = SemanticSnapshotV1Schema.parse({
    ...identity,
    treeRevision: revision,
    ...fields,
  });
  return Object.freeze({ snapshot, guestLease, treeRef });
}
