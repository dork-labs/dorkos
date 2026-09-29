/**
 * Reading an answered `extension.approval` history row back (DOR-2517).
 *
 * The server files that kind under the exact copy the person was asked about
 * (`extensionApprovalSubjectId`: id, path, plugin and version). The inbox's
 * "Turn it on" link on a history row reads it back, decides whether it can
 * still turn that same copy on from there, and sends all four with the
 * approval so the server refuses any copy that took its place.
 *
 * @module entities/extension/lib/approval-subject
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  parseExtensionApprovalSubjectId,
  type ExtensionCopyIdentity,
} from '@dorkos/shared/extension-approval-schemas';

/** The copy an `extension.approval` row is about. */
export type ExtensionApprovalSubject = ExtensionCopyIdentity;

/**
 * Read an `extension.approval` subject id back into the copy it names.
 *
 * @param subjectId - The row's `subject.id`.
 * @returns The copy, or `null` when it is not in that form.
 */
export function parseExtensionApprovalSubject(subjectId: string): ExtensionApprovalSubject | null {
  return parseExtensionApprovalSubjectId(subjectId);
}

/** Statuses of an extension the inbox never offers to turn on. */
const NOT_OFFERED = new Set(['disabled', 'invalid', 'incompatible']);

/**
 * Whether the inbox can still offer to turn this copy on in place: the same
 * extension is installed from the same plugin at the same version, still off,
 * and not turned off in Settings. Otherwise the link opens Settings →
 * Extensions.
 *
 * The browser is never told a copy's path, so the path half of "the same
 * copy" is the server's to check: the approval carries it, and a copy at
 * another path is refused with `409 stale_approval`.
 *
 * @param subject - What the history row was about.
 * @param extensions - Every discovered extension, as the list query returns it.
 */
export function canTurnOnInPlace(
  subject: ExtensionApprovalSubject,
  extensions: readonly ExtensionRecordPublic[] | undefined
): boolean {
  const record = extensions?.find((extension) => extension.id === subject.id);
  if (!record) return false;
  return (
    record.origin === 'user' &&
    !record.approvedToRun &&
    !NOT_OFFERED.has(record.status) &&
    (record.sourcePlugin ?? null) === subject.plugin &&
    record.manifest.version === subject.version
  );
}
