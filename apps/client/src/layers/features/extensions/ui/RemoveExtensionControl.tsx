/**
 * Remove, last in an open row: a quiet destructive link that asks once,
 * in place, before it deletes anything (DOR-3541).
 *
 * @module features/extensions/ui/RemoveExtensionControl
 */
import { useEffect, useRef, useState } from 'react';
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
  const linkRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Focus returns to the link only after the question was asked, never on mount.
  const wasAsking = useRef(false);

  useEffect(() => {
    if (asking) {
      wasAsking.current = true;
      // The safe answer takes focus first, so Enter never deletes by accident.
      cancelRef.current?.focus();
      return;
    }
    if (wasAsking.current) {
      wasAsking.current = false;
      linkRef.current?.focus();
    }
  }, [asking]);

  // Esc answers "no". A native listener, so it runs before the open row's own
  // Esc listener (which would close the whole row) and stops it there.
  useEffect(() => {
    const group = groupRef.current;
    if (!asking || !group) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setAsking(false);
    };
    group.addEventListener('keydown', onKeyDown);
    return () => group.removeEventListener('keydown', onKeyDown);
  }, [asking]);

  if (!asking) {
    return (
      <Button
        ref={linkRef}
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
    <div
      ref={groupRef}
      role="group"
      aria-label={`Remove ${name}?`}
      className="flex flex-wrap items-center gap-2"
    >
      <p className="text-sm">
        Remove {name}? Its folder and everything it was allowed are deleted.
      </p>
      <Button size="sm" variant="destructive" onClick={onRemove} disabled={isRemoving}>
        Remove
      </Button>
      <Button ref={cancelRef} size="sm" variant="secondary" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </div>
  );
}
