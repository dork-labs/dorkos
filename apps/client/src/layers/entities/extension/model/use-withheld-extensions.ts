/**
 * Mini apps held back because their code changed since a person approved it
 * (DOR-3068), for the places they would otherwise draw.
 *
 * A changed mini app does not run, so it registers nothing: its tab, its
 * section, its page all vanish. This names them instead, so the slot says why
 * rather than going blank.
 *
 * @module entities/extension/model/use-withheld-extensions
 */
import { useMemo } from 'react';
import { usePendingExtensionApprovals } from './use-pending-extension-approvals';
import { useExtensionList } from './use-extension-list';

/** A mini app waiting for a person because its code changed. */
export interface WithheldExtension {
  /** The extension id. */
  id: string;
  /** Its display name. */
  name: string;
}

/** Shared empty list, so a slot with nothing held back never mints a fresh array. */
const NONE: readonly WithheldExtension[] = [];

/**
 * The mini apps held back for a changed copy (an edit or an update) that
 * declare `slot` in their manifest, oldest first.
 *
 * A mini app that was never turned on is not listed: it never drew here, so
 * nothing vanished.
 *
 * @param slot - The manifest contribution key, e.g. `right-panel`.
 */
export function useWithheldExtensions(slot: string): readonly WithheldExtension[] {
  const { approvals } = usePendingExtensionApprovals();
  const { data: extensions } = useExtensionList();
  return useMemo(() => {
    if (!extensions || approvals.length === 0) return NONE;
    const declared = new Set(
      extensions.filter((ext) => ext.manifest.contributions?.[slot]).map((ext) => ext.id)
    );
    const held = approvals
      .filter(
        (approval) => (approval.changedFiles || approval.updatedFrom) && declared.has(approval.id)
      )
      .map((approval) => ({ id: approval.id, name: approval.name }));
    return held.length === 0 ? NONE : held;
  }, [approvals, extensions, slot]);
}
