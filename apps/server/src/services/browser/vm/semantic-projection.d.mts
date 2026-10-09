import type {
  SemanticSnapshotV1,
  SemanticIdentityV1,
} from '@dorkos/shared/browser-semantic-schemas';
export function projectOriginalVMSemanticSnapshot(
  value: unknown,
  identity: Omit<SemanticIdentityV1, 'treeRevision'>
): Readonly<{ snapshot: SemanticSnapshotV1; guestLease: string; treeRef: string }>;
