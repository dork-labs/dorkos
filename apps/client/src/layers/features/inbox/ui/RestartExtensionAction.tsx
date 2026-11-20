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
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui/button';

/** The notice action that asks for this button. */
export const RESTART_EXTENSION_ACTION_ID = 'restart-extension';

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
}

/**
 * "Restart": starts the extension again, then reads "Restarted". Refused (turned
 * off since, or it no longer builds), it says so and keeps the button.
 *
 * @param props - The extension and the notice.
 */
export function RestartExtensionAction({
  extensionId,
  notificationId,
}: RestartExtensionActionProps) {
  const transport = useTransport();
  const read = useMarkRead();
  const button = useRef<HTMLButtonElement>(null);
  const restart = useMutation({
    mutationFn: () => transport.restartExtension(extensionId),
    meta: { suppressErrorToast: true },
    onSuccess: () => read.mutate(notificationId),
    onError: () => requestAnimationFrame(() => button.current?.focus()),
  });

  if (restart.isSuccess) {
    return (
      <span
        role="status"
        data-slot="inbox-row-restarted"
        className="text-muted-foreground shrink-0 px-2 py-1 text-xs"
      >
        Restarted
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        ref={button}
        type="button"
        variant="outline"
        size="xs"
        data-slot="inbox-row-restart-extension"
        // Full width and 44px tall on a phone, under the text; beside it from `sm`.
        className="h-11 w-full shrink-0 sm:h-auto sm:w-auto"
        disabled={restart.isPending}
        aria-busy={restart.isPending || undefined}
        onClick={() => restart.mutate()}
      >
        Restart
      </Button>
      {restart.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t restart it. Open Settings to check.
        </p>
      )}
    </div>
  );
}
