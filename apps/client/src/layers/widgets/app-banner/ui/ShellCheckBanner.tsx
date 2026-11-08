import { ShieldAlert } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';

import { useLocalCaller } from '@/layers/entities/config';
import { useTransport } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Banner,
  Button,
  buttonVariants,
} from '@/layers/shared/ui';

/** The query key for {@link ShellCheckStatus}. */
export const SHELL_CHECK_STATUS_KEY = ['shell-check-status'] as const;

/** The second line, from what the check's status says. */
function secondLine(status: ShellCheckStatus): string {
  if (status.canContinue) {
    return 'Still not running. Wait for an update, or continue without it until you restart.';
  }
  return status.full
    ? 'Shell commands are paused. Restart DorkOS.'
    : 'Commands that name setup files are refused, and others ask first. Restart DorkOS.';
}

/**
 * Says DorkOS can't check agents' shell commands for protected files, and once a restart hasn't
 * helped, offers a person at this computer the choice to go on without it (DOR-3300). The choice
 * stays on screen for as long as it holds, and can't be dismissed. A phone gets the words, not the
 * button: the server refuses it there too.
 */
export function ShellCheckBanner({ status }: { status: ShellCheckStatus }) {
  const local = useLocalCaller();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const go = useMutation({
    mutationFn: () => transport.continueWithoutShellCheck(),
    onSuccess: (next) => queryClient.setQueryData(SHELL_CHECK_STATUS_KEY, next),
  });

  if (status.continuing) {
    return (
      <Banner variant="warning" icon={ShieldAlert}>
        The protected-files check is off until you restart.
      </Banner>
    );
  }
  return (
    <Banner
      variant="critical"
      icon={ShieldAlert}
      actions={
        status.canContinue && local ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm">
                Continue without the check
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Continue without the check?</AlertDialogTitle>
                <AlertDialogDescription>
                  Agents’ shell commands won’t be checked for protected files. This lasts until you
                  restart.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({ variant: 'destructive' })}
                  onClick={() => go.mutate()}
                >
                  Continue without the check
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : undefined
      }
    >
      <span className="font-medium">DorkOS can’t check shell commands for protected files.</span>{' '}
      {secondLine(status)}
    </Banner>
  );
}
