import type { GlobalMcpServerView } from '@dorkos/shared/global-mcp-schemas';
import { useRemoveGlobalMcpServer } from '@/layers/entities/global-mcp';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@/layers/shared/ui';
import { changeError, savedSecretCount } from '../lib/server-lines';

/** The code a remove answers when the server is gone but a saved secret stayed. */
const SECRET_LEFT_CODE = 'secret_left';

interface RemoveServerDialogProps {
  /** The server to remove. */
  server: GlobalMcpServerView;
  /** Close without removing anything. */
  onClose: () => void;
  /** The server is gone. `keysLeft`: a saved secret could not be deleted. */
  onRemoved: (result: { keysLeft: boolean }) => void;
  /** Where focus goes when the dialog closes. */
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * Remove a server, focus on Cancel. Removing never asks "Confirm it's you": it only takes power
 * away. The two lines about a saved key show only for a server that holds one.
 */
export function RemoveServerDialog({
  server,
  onClose,
  onRemoved,
  onCloseAutoFocus,
}: RemoveServerDialogProps) {
  const remove = useRemoveGlobalMcpServer();
  const secrets = savedSecretCount(server);

  function confirm() {
    remove.mutate(server.name, {
      onSuccess: () => onRemoved({ keysLeft: false }),
      onError: (error) => {
        if ((error as { code?: unknown }).code === SECRET_LEFT_CODE) {
          onRemoved({ keysLeft: true });
        }
      },
    });
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {server.name}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>New chats won’t get its tools. Open ones may keep them until they stop.</p>
              {secrets === 1 && (
                <p>Its key is deleted here. If it may have leaked, revoke it at the service.</p>
              )}
              {secrets > 1 && (
                <p>
                  Its keys are deleted here. If they may have leaked, revoke them at the service.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {remove.isError && (remove.error as { code?: unknown }).code !== SECRET_LEFT_CODE && (
          <p role="alert" className="text-destructive text-sm">
            {changeError(remove.error)}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending} className="max-sm:h-11">
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            className="max-sm:h-11"
            disabled={remove.isPending}
            aria-busy={remove.isPending}
            onClick={confirm}
          >
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
