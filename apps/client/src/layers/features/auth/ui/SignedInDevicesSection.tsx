import { LogOut, MonitorSmartphone } from 'lucide-react';
import type { SignedInDevice, SignedInDeviceRoute } from '@dorkos/shared/signed-in-devices';
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
  Badge,
  Button,
  QueryErrorState,
  Skeleton,
} from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import { useSignedInDevices } from '../model/use-signed-in-devices';
import { useSignOut } from '../model/use-auth-session';

/** How each way in reads in the list. */
const ROUTE_LABELS: Record<SignedInDeviceRoute, string> = {
  local: 'This computer',
  wifi: 'Wi-Fi',
  tunnel: 'Remote access',
  managed: 'Remote access',
  network: 'Another network',
  hub: 'DorkOS in the cloud',
};

/**
 * Settings › Login & security › Signed-in devices (F4 part 2, DOR-2969): where
 * the person's account is signed in, how each sign-in came in and when it was
 * last used. This device signs out from anywhere; other devices, and "Sign out
 * everywhere else", only from the computer DorkOS runs on, which the server
 * decides (`canSignOutOthers`). Signing a device out closes whatever it had
 * open.
 */
export function SignedInDevicesSection() {
  const devices = useSignedInDevices();
  const signOutHere = useSignOut();
  const list = devices.data?.sessions ?? [];
  const canSignOutOthers = devices.data?.canSignOutOthers ?? false;
  const hasOthers = list.some((device) => !device.current);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="text-muted-foreground size-4" />
          <p className="text-sm font-medium">Signed-in devices</p>
        </div>
        <p className="text-muted-foreground text-xs">
          Signing a device out closes everything it had open.
        </p>
      </div>

      <div className="space-y-1.5">
        {devices.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : devices.isError ? (
          <QueryErrorState
            title="Couldn’t load signed-in devices"
            description="Nothing was signed out. Try again."
            onRetry={devices.refetch}
            isRetrying={devices.isFetching}
            className="py-6"
          />
        ) : list.length > 0 ? (
          list.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              canSignOut={device.current || canSignOutOthers}
              signingOut={device.current ? signOutHere.isPending : devices.pendingId === device.id}
              onSignOut={() =>
                device.current ? void signOutHere.run() : devices.signOutDevice(device.id)
              }
            />
          ))
        ) : (
          <p className="text-muted-foreground text-xs">No devices are signed in.</p>
        )}
      </div>

      {hasOthers && !canSignOutOthers && (
        <p className="text-muted-foreground text-xs">
          Sign out other devices on the computer DorkOS runs on.
        </p>
      )}

      {hasOthers && canSignOutOthers && (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={devices.signingOutOthers}>
              {devices.signingOutOthers ? 'Signing out…' : 'Sign out everywhere else'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Sign out everywhere else?</AlertDialogTitle>
              <AlertDialogDescription>
                Every other device must sign in again. This one stays signed in.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={devices.signOutEverywhereElse}>
                Sign out everywhere else
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {devices.error && (
        <p className="text-destructive text-xs" role="alert">
          {devices.error}
        </p>
      )}
    </div>
  );
}

/** One sign-in: where it came in, from what, when it was last used. */
function DeviceRow({
  device,
  canSignOut,
  signingOut,
  onSignOut,
}: {
  device: SignedInDevice;
  canSignOut: boolean;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  const where = ROUTE_LABELS[device.route];
  const label = device.userAgentLabel ? `${where} · ${device.userAgentLabel}` : where;
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{label}</p>
          {device.current && <Badge variant="secondary">This device</Badge>}
        </div>
        <p className="text-muted-foreground text-xs">
          Last active {sentenceCase(formatRelativeTime(device.lastSeenAt))}
        </p>
      </div>
      {canSignOut && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          disabled={signingOut}
          aria-label={device.current ? 'Sign out this device' : `Sign out ${label}`}
        >
          <LogOut className="mr-1.5 size-3.5" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      )}
    </div>
  );
}

/** A relative time mid-sentence: "just now", "yesterday, 11 pm". */
function sentenceCase(relative: string): string {
  return relative.replace(/^(Just now|Yesterday)/, (word) => word.toLowerCase());
}
