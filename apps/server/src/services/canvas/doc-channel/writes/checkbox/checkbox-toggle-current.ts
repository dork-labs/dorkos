import { open, rename } from 'node:fs/promises';
import type { DocChannelActor } from '../../authorization.js';
import {
  CanonicalFileIdentityChangedError,
  withRecognizedCanonicalFiles,
} from '../canonical-writer.js';
import {
  assertCheckboxReplacement,
  cleanCheckboxTemporary,
  readOriginalCheckboxFileCloseFailure,
  verifyCheckboxTemporary,
} from '../checkbox-file.js';
import { prepareCheckboxBytes, rawByteHash } from '../checkbox-bytes.js';
import {
  assertRecognizedCheckboxAdmission,
  assertRecognizedCheckboxOwnedAdmission,
} from '../checkbox-fence.js';
import {
  VerifiedCheckboxAuthoritySchema,
  CheckboxEvidenceError,
  freezeCheckboxData,
  observedCheckboxIntent,
  type CheckboxRequest,
  type CheckboxReceipt,
} from '../checkbox-evidence.js';
import { readOriginalCheckboxWriteOperationContext } from '../checkbox-service.js';
/** Original live toggle operation; genuine private constructor membership precedes effects. */
export async function runOriginalCheckboxToggleCurrent(
  engineOwner: object,
  request: CheckboxRequest,
  actor: DocChannelActor
): Promise<CheckboxReceipt> {
  const facet = readOriginalCheckboxWriteOperationContext(engineOwner);
  facet.boundary();
  await facet.authority.preflight(request.documentId, actor);
  facet.boundary();
  const digest = rawByteHash(Buffer.from(JSON.stringify(request)));
  const previous = facet.find(request.documentId, request.eventId);
  if (previous) return facet.duplicate(previous, digest, actor);
  const approved = freezeCheckboxData(
    VerifiedCheckboxAuthoritySchema.parse(await facet.authority.prepare(request, actor))
  );
  facet.boundary();
  let entered = false;
  return withRecognizedCanonicalFiles(
    facet.coordinator,
    [approved.binding.canonicalPath],
    async (identities, lease) => {
      entered = true;
      facet.boundary();
      const existing = facet.find(request.documentId, request.eventId);
      if (existing) return facet.duplicate(existing, digest, actor);
      const granted = identities[0]!;
      if (granted.canonicalPath !== approved.binding.canonicalPath)
        throw new CheckboxEvidenceError('Checkbox source changed.');
      const assertUnfenced = () => {
        facet.boundary();
        assertRecognizedCheckboxAdmission(facet.writeFence, facet.db, facet.store, granted);
      };
      const file = await facet.readSource(approved, assertUnfenced);
      if (file.device !== granted.device || file.inode !== granted.inode)
        throw new CheckboxEvidenceError('Checkbox granted source identity changed.');
      let edit: ReturnType<typeof prepareCheckboxBytes> | undefined;
      try {
        edit = prepareCheckboxBytes(file.bytes, request);
      } catch {
        /* A parser/version refusal has no physical effect. */
      }
      const observed = observedCheckboxIntent(
        request,
        approved,
        digest,
        facet.time(),
        rawByteHash(file.bytes),
        { device: file.device, inode: file.inode },
        edit
      );
      const freshSnapshot = await facet.authority.refreshCurrent(request, actor, approved);
      const checked = await facet.readSource(approved, assertUnfenced);
      if (
        checked.device !== file.device ||
        checked.inode !== file.inode ||
        checked.rootIdentity !== file.rootIdentity ||
        rawByteHash(checked.bytes) !== rawByteHash(file.bytes)
      )
        throw new CheckboxEvidenceError('Checkbox observed source changed.');
      const subject = facet.live(request, actor, approved);
      const terminal = facet.authority.transaction((tx) => {
        const raced = facet.find(request.documentId, request.eventId, tx);
        if (raced) return facet.duplicate(raced, digest, actor, tx);
        const input = { candidate: observed.intent, liveSubject: subject, freshSnapshot };
        if (observed.receipt?.status === 'no_op')
          return facet.completion.insertNoOpInTransaction(input, tx);
        if (observed.receipt?.status === 'conflict')
          return facet.completion.insertConflictInTransaction(input, tx);
        facet.completion.insertPreparedInTransaction(input, tx);
        return undefined;
      });
      if (terminal) return terminal;
      let current = facet.store.getWriteIntent(observed.intent.intentId)!;
      const assertOwned = () => {
        facet.boundary();
        assertRecognizedCheckboxOwnedAdmission(
          facet.writeFence,
          facet.db,
          facet.store,
          granted,
          current
        );
      };
      let temp: string | undefined, ownedTemp: { device: string; inode: string } | undefined;
      try {
        await facet.checkpoint('prepared', current);
        assertOwned();
        const candidate = facet.validate(current).tempPath!;
        const handle = await open(candidate, 'wx', file.mode & 0o777);
        temp = candidate;
        // Join this scope to its captured cleanup before returning or reporting failure.
        const drainOriginalCleanup = async () => {
          try {
            await handle.close();
          } catch (cause) {
            facet.retainCloseFailure(cause);
            throw cause;
          }
        };
        try {
          assertOwned();
          const temporary = await handle.stat({ bigint: true });
          ownedTemp = { device: String(temporary.dev), inode: String(temporary.ino) };
          const stagedSnapshot = await facet.authority.refreshCurrent(request, actor, approved);
          assertOwned();
          current = facet.authority.transaction((tx) =>
            facet.completion.stageInTransaction(
              {
                expected: current,
                subject,
                freshSnapshot: stagedSnapshot,
                replacement: ownedTemp!,
              },
              tx
            )
          );
          await handle.writeFile(edit!.after);
          assertOwned();
          await handle.chmod(file.mode & 0o777);
          assertOwned();
          await handle.sync();
        } finally {
          await drainOriginalCleanup();
        }
        await facet.checkpoint('staged', current);
        const adopted = await lease.reserveReplacement(temp);
        assertOwned();
        const expectedTemp = facet.validate(current).tempIdentity!;
        if (
          adopted.canonicalPath !== temp ||
          adopted.device !== expectedTemp.device ||
          adopted.inode !== expectedTemp.inode
        )
          throw new CheckboxEvidenceError('Checkbox replacement identity changed.');
        // Authority observation precedes the final real source and owned-temp byte/path proofs.
        const renameSnapshot = await facet.authority.refreshCurrent(request, actor, approved);
        const final = await facet.readSource(approved, assertOwned);
        if (
          final.device !== file.device ||
          final.inode !== file.inode ||
          final.rootIdentity !== file.rootIdentity ||
          rawByteHash(final.bytes) !== current.beforeHash
        )
          throw new CheckboxEvidenceError('Checkbox source changed before replacement.');
        try {
          await verifyCheckboxTemporary(current, assertOwned);
        } finally {
          const failure = readOriginalCheckboxFileCloseFailure(assertOwned);
          if (failure) facet.retainCloseFailure(failure.cause);
        }
        assertOwned();
        facet.completion.requireEffect({
          expected: current,
          subject,
          freshSnapshot: renameSnapshot,
        });
        await rename(temp, current.canonicalPath);
        temp = undefined;
        await facet.checkpoint('replaced', current);
        const written = await facet.readSource(approved, assertOwned);
        assertCheckboxReplacement(current, written);
        const replacedSnapshot = await facet.authority.refreshCurrent(request, actor, approved);
        const rechecked = await facet.readSource(approved, assertOwned);
        assertCheckboxReplacement(current, rechecked);
        assertOwned();
        current = facet.authority.transaction((tx) =>
          facet.completion.replaceInTransaction(
            { expected: current, subject, freshSnapshot: replacedSnapshot },
            tx
          )
        );
        await facet.checkpoint('verified', current);
        return await facet.complete(current, subject, assertOwned, lease);
      } catch (error) {
        // Lost current authority never manufactures a no-effect conflict or frees the reservation.
        if (facet.authorityRefused(error) || error instanceof CheckboxEvidenceError)
          facet.quarantine(current, 'write_unverified');
        throw error;
      } finally {
        if (temp)
          await cleanCheckboxTemporary(
            {
              ...current,
              evidence: {
                ...facet.validate(current),
                tempIdentity: ownedTemp ?? facet.validate(current).tempIdentity,
              },
            },
            () => {
              if (facet.db.$client.inTransaction) throw new Error('FS inside SQL');
            }
          ).catch(() => {
            /* Unknown/unowned cleanup remains fenced; never unlink a substituted inode. */
          });
      }
    }
  ).catch(async (error: unknown) => {
    if (entered || !(error instanceof CanonicalFileIdentityChangedError)) throw error;
    facet.boundary();
    return facet.preEffectConflict(request, actor, approved, digest);
  });
}
