import type { DbTransaction } from '@dorkos/db';
import type { DocChannelActor } from '../../authorization.js';
import {
  sameDocOwnerAuthority,
  docInstallationOwner,
  readDocSourceDescriptor,
} from '../../current/doc-source-policy.js';
import {
  requireCheckboxEditor,
  readCheckboxCurrentRows,
  readCheckboxPhysicalId,
} from './authority-policy.js';
import {
  CheckboxAuthorityRefusal,
  checkboxAuthoritySync,
  withCheckboxReadOnlyGate,
  type CheckboxSourceObservation,
} from './authority-snapshot.js';
import type { VerifiedCheckboxAuthority } from '../checkbox-evidence.js';
import { readOriginalCheckboxAuthorityOperationView } from '../authority.js';

/** Original current SQL policy, selected only by the constructor-private key. */
export function requireOriginalCheckboxEditor(
  owner: object,
  documentId: string,
  actor: DocChannelActor | undefined,
  tx: DbTransaction,
  options: { grantId?: string; time?: number } = {}
): void {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  const time = options.time ?? facet.now().getTime();
  requireCheckboxEditor(facet.deps, documentId, actor, tx, { grantId: options.grantId, time });
}

/** Original current SQL policy, selected only by the constructor-private key. */
export function checkOriginalCheckboxRows(
  owner: object,
  documentId: string,
  grantId: string,
  revision: number,
  observation: CheckboxSourceObservation,
  tx: DbTransaction,
  actor?: DocChannelActor
): VerifiedCheckboxAuthority {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  return withCheckboxReadOnlyGate(facet.deps.db, () => {
    const time = facet.now().getTime();
    facet.transactions.captureCheckedTime(tx, new Date(time).toISOString());
    return readCheckboxCurrentRows(
      facet.deps,
      documentId,
      grantId,
      revision,
      observation,
      tx,
      actor,
      time
    );
  });
}

/** Original current SQL policy, selected only by the constructor-private key. */
export function accessOriginalCheckboxRows(
  owner: object,
  documentId: string,
  actor: DocChannelActor,
  tx: DbTransaction
): undefined {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  const time = facet.now().getTime();
  if (
    !sameDocOwnerAuthority(
      actor.principal.claims.owner,
      docInstallationOwner(facet.deps.installationId)
    )
  )
    throw new CheckboxAuthorityRefusal('ORIGINAL_OWNER_CHANGED');
  const physical = readCheckboxPhysicalId(tx, documentId);
  const channel = facet.deps.store.getChannel(documentId, tx);
  if (!physical || !channel || channel.closedAt !== null)
    throw new CheckboxAuthorityRefusal('DOCUMENT_CLOSED');
  checkboxAuthoritySync(facet.deps.authorization.requireCurrent(documentId, actor, true, tx));
  facet.editor(documentId, actor, tx, { time });
  return undefined;
}

/** Repeat original grant descriptor and manifest SQL gates using only the actual private key. */
export function requireOriginalCheckboxGrantDescriptor(
  owner: object,
  id: string,
  observation: CheckboxSourceObservation,
  tx: DbTransaction
): void {
  const facet = readOriginalCheckboxAuthorityOperationView(owner);
  return withCheckboxReadOnlyGate(facet.deps.db, () => {
    if (
      !facet.deps.db.$client.inTransaction ||
      JSON.stringify(readDocSourceDescriptor(facet.deps, id, tx)) !==
        JSON.stringify(observation.descriptor)
    )
      throw new CheckboxAuthorityRefusal('SOURCE_DESCRIPTOR_CHANGED');
    const channel = facet.deps.store.getChannel(id, tx);
    if (!channel || channel.closedAt !== null || channel.manifestHash !== observation.manifestHash)
      throw new CheckboxAuthorityRefusal('MANIFEST_CHANGED');
  });
}
