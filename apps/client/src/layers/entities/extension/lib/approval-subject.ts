/**
 * Reading an `extension.approval` history row back (DOR-2517).
 *
 * The server files that kind under the subject `<id>@<version>`: the question
 * was about this version of this extension, and a "Not now" holds until the
 * version changes. The inbox's "Turn it on" link on a history row reads both
 * halves back off it to decide whether it can still turn that same extension
 * on from there, or has to send the person to Settings.
 *
 * @module entities/extension/lib/approval-subject
 */
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

/** The extension and version an `extension.approval` row is about. */
export interface ExtensionApprovalSubject {
  /** Extension id. */
  id: string;
  /** The version the person was asked about. */
  version: string;
}

/**
 * Split an `extension.approval` subject id into its extension id and version.
 *
 * @param subjectId - The row's `subject.id`, e.g. `flow@1.2.0`.
 * @returns Both halves, or `null` when it is not in that form.
 */
export function parseExtensionApprovalSubject(subjectId: string): ExtensionApprovalSubject | null {
  const at = subjectId.lastIndexOf('@');
  if (at <= 0 || at === subjectId.length - 1) return null;
  return { id: subjectId.slice(0, at), version: subjectId.slice(at + 1) };
}

/** Statuses of an extension the inbox never offers to turn on. */
const NOT_OFFERED = new Set(['disabled', 'invalid', 'incompatible']);

/**
 * Whether the inbox can still turn this extension on in place: it is still
 * installed at the version the person was asked about, still off, and not
 * turned off in Settings. Otherwise the link opens Settings → Extensions.
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
    record.manifest.version === subject.version
  );
}
