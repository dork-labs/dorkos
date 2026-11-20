/**
 * Restart on the notice DorkOS posts when an extension stopped too often and
 * was left off (`extension.stopped`, DOR-4785). It does what reloading that
 * extension does: a fresh start and a fresh crash budget.
 *
 * @module features/inbox/ui/RestartExtensionAction
 */
import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useMarkRead } from '@/layers/entities/notifications';
import { cn } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui/button';

/** The notice action that asks for this button. */
export const RESTART_EXTENSION_ACTION_ID = 'restart-extension';

/** Feedback the notice draws in its text column, separate from the action. */
export type RestartExtensionStatus = 'idle' | 'pending' | 'success' | 'error';

/** The prefix of an `extension.stopped` notice's subject id: `extension:<id>`. */
const SUBJECT_PREFIX = 'extension:';

/**
 * The extension id an `extension.stopped` notice is about, or `null` when the
 * subject is not one.
 *
 * @param subjectId - The notice's subject id.
 */
export function extensionIdOfStoppedNotice(subjectId: string): string | null {
  return subjectId.startsWith(SUBJECT_PREFIX) ? subjectId.slice(SUBJECT_PREFIX.length) : null;
}

/** Props for {@link RestartExtensionAction}. */
export interface RestartExtensionActionProps {
  /** The extension to restart. */
  extensionId: string;
  /** The notice, marked read once the restart went through. */
  notificationId: string;
  /** Keep the notice's title, description and error in sync with the action. */
  onStatusChange?: (status: RestartExtensionStatus) => void;
}

/**
 * "Restart": starts the extension again and reports the result to its notice.
 * A successful restart reserves the button's footprint so the text never shifts.
 *
 * @param props - The extension and the notice.
 */
export function RestartExtensionAction({
  extensionId,
  notificationId,
  onStatusChange,
}: RestartExtensionActionProps) {
  const transport = useTransport();
  const read = useMarkRead();
  const button = useRef<HTMLButtonElement>(null);
  const restart = useMutation({
    mutationFn: () => transport.restartExtension(extensionId),
    meta: { suppressErrorToast: true },
    onMutate: () => onStatusChange?.('pending'),
    onSuccess: () => {
      onStatusChange?.('success');
      read.mutate(notificationId);
    },
    onError: () => {
      onStatusChange?.('error');
      requestAnimationFrame(() => button.current?.focus());
    },
  });

  return (
    <div data-slot="inbox-row-restart-slot" className="w-full shrink-0 sm:w-auto">
      <Button
        ref={button}
        type="button"
        variant="outline"
        size="xs"
        data-slot="inbox-row-restart-extension"
        // Full width and 44px tall on a phone, under the text; beside it from `sm`.
        className={cn('h-11 w-full shrink-0 sm:h-auto sm:w-auto', restart.isSuccess && 'invisible')}
        disabled={restart.isPending || restart.isSuccess}
        aria-hidden={restart.isSuccess || undefined}
        tabIndex={restart.isSuccess ? -1 : undefined}
        aria-busy={restart.isPending || undefined}
        onClick={() => restart.mutate()}
      >
        Restart
      </Button>
    </div>
  );
}
