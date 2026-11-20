import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STEP_UP_REQUIRED_CODE } from '@dorkos/shared/step-up';
import { useMarkRead } from '@/layers/entities/notifications';
import { signedInDevicesKey } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Sign out exactly the device named by the server's notice. */
export function RemoteStepUpAction({
  deviceId,
  notificationId,
}: {
  deviceId: string;
  notificationId: string;
}) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const read = useMarkRead();
  const button = useRef<HTMLButtonElement>(null);
  const signOut = useMutation({
    mutationFn: () => transport.signOutDevice(deviceId),
    meta: { suppressErrorToast: true },
    onSuccess: () => read.mutate(notificationId),
    onError: () => requestAnimationFrame(() => button.current?.focus()),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: signedInDevicesKey });
    },
  });
  if (signOut.isSuccess)
    return (
      <span role="status" className="text-muted-foreground text-xs">
        Device signed out
      </span>
    );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        ref={button}
        variant="outline"
        size="sm"
        className="h-11 w-full sm:h-9 sm:w-auto"
        disabled={signOut.isPending}
        aria-busy={signOut.isPending || undefined}
        onClick={() => signOut.mutate()}
      >
        Sign it out
      </Button>
      {signOut.isError && (signOut.error as { code?: string }).code !== STEP_UP_REQUIRED_CODE && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t sign that device out. Try again.
        </p>
      )}
    </div>
  );
}
