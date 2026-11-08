/**
 * Remove, last in an open row: a quiet destructive link that asks once,
 * in place, before it deletes anything (DOR-3541).
 *
 * @module features/extensions/ui/RemoveExtensionControl
 */
import { useState } from 'react';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Button } from '@/layers/shared/ui';

/**
 * Whether Settings can remove this copy itself. A copy that came with a
 * plugin goes when the plugin is uninstalled, a dev link when it is unlinked,
 * and DorkOS's own never; the server refuses those too.
 *
 * @param extension - The extension record.
 */
export function canRemoveHere(
  extension: Pick<ExtensionRecordPublic, 'origin' | 'sourcePlugin' | 'devLink'>
): boolean {
  return extension.origin === 'user' && !extension.sourcePlugin && !extension.devLink;
}

/** Props for {@link RemoveExtensionControl}. */
export interface RemoveExtensionControlProps {
  /** The extension's name, for the question. */
  name: string;
  /** Remove it. */
  onRemove: () => void;
  /** Whether a remove is in flight. */
  isRemoving: boolean;
}

/**
 * The Remove link, and the one question it asks.
 *
 * @param props - {@link RemoveExtensionControlProps}.
 */
export function RemoveExtensionControl({
  name,
  onRemove,
  isRemoving,
}: RemoveExtensionControlProps) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="text-status-error-fg"
        onClick={() => setAsking(true)}
      >
        Remove
      </Button>
    );
  }

  return (
    <div role="group" aria-label={`Remove ${name}?`} className="flex flex-wrap items-center gap-2">
      <p className="text-sm">
        Remove {name}? Its folder and everything it was allowed are deleted.
      </p>
      <Button size="sm" variant="destructive" onClick={onRemove} disabled={isRemoving}>
        Remove
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}
