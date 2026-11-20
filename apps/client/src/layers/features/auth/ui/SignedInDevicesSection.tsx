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
  Switch,
} from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import { useSignedInDevices } from '../model/use-signed-in-devices';
import { useDeviceTrust, type DeviceTrust } from '../model/use-device-trust';
import { WifiSignInRequests } from './WifiSignInRequests';

/**
 * How each way in reads under a device's name. This computer says nothing: the
 * name already reads well alone.
 */
const ROUTE_LABELS: Record<SignedInDeviceRoute, string | null> = {
  local: null,
  wifi: 'Plain Wi-Fi',
  tunnel: 'Remote access',
  managed: 'Remote access',
  network: 'Another network',
  hub: 'DorkOS in the cloud',
};

/**
 * Settings › Login & security › Signed-in devices (F4 part 2, DOR-2969): where
 * the person's account is signed in, each named by its browser ("Chrome on
 * Mac"), how it came in and when it was last used. This device is marked, not
 * signed out here: "Sign out" at the top of the panel does that (DOR-3099).
 * Other devices, and "Sign out everywhere else", sign out only from the
 * computer DorkOS runs on, which the server decides (`canSignOutOthers`).
 * Signing a device out closes whatever it had open.
 *
 * At that computer it also lists Wi-Fi devices waiting to sign in, and each
 * Wi-Fi row has a "Run agents from this device" switch (DOR-4744).
 */
export function SignedInDevicesSection() {
  const devices = useSignedInDevices();
  const list = devices.data?.sessions ?? [];
  const canSignOutOthers = devices.data?.canSignOutOthers ?? false;
  const trust = useDeviceTrust(canSignOutOthers);
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

      {canSignOutOthers && <WifiSignInRequests trust={trust} />}

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
              canSignOut={!device.current && canSignOutOthers}
              signingOut={devices.pendingId === device.id}
              onSignOut={() => devices.signOutDevice(device.id)}
              trust={canSignOutOthers ? trust : null}
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

/** One sign-in: what it is, how it came in, when it was last used. */
function DeviceRow({
  device,
  canSignOut,
  signingOut,
  onSignOut,
  trust,
}: {
  device: SignedInDevice;
  canSignOut: boolean;
  signingOut: boolean;
  onSignOut: () => void;
  /** Set at the computer DorkOS runs on, where a Wi-Fi row's switch can change. */
  trust: DeviceTrust | null;
}) {
  const via = ROUTE_LABELS[device.route];
  const lastActive = `Last active ${sentenceCase(formatRelativeTime(device.lastSeenAt))}`;
  return (
    <div className="space-y-2 rounded-md border px-3 py-2">
      <DeviceSummary
        device={device}
        via={via}
        lastActive={lastActive}
        canSignOut={canSignOut}
        signingOut={signingOut}
        onSignOut={onSignOut}
      />
      {device.route === 'wifi' && device.runsAgents !== undefined && (
        <RunsAgentsSwitch device={device} trust={trust} />
      )}
    </div>
  );
}

/**
 * The opt-in that lets one Wi-Fi device run agents at their own level. Off for
 * every new device; changed only at the computer DorkOS runs on, and turning
 * it on asks for a passkey there.
 */
function RunsAgentsSwitch({
  device,
  trust,
}: {
  device: SignedInDevice;
  trust: DeviceTrust | null;
}) {
  const on = device.runsAgents === true;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Run agents from this device</span>
        <Switch
          checked={on}
          disabled={!trust || trust.pendingId === device.id}
          onCheckedChange={(next) => void trust?.setRunsAgents(device.id, next)}
          aria-label={`Run agents from ${device.name}`}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Anyone on the same Wi-Fi could take over this session.
      </p>
      <p className="text-muted-foreground text-xs">It turns off after 12 hours idle.</p>
    </div>
  );
}

/** A device's name, how it came in, and its sign-out button. */
function DeviceSummary({
  device,
  via,
  lastActive,
  canSignOut,
  signingOut,
  onSignOut,
}: {
  device: SignedInDevice;
  via: string | null;
  lastActive: string;
  canSignOut: boolean;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{device.name}</p>
          {device.current && <Badge variant="secondary">This device</Badge>}
        </div>
        <p className="text-muted-foreground text-xs">
          {via ? `${via} · ${lastActive}` : lastActive}
        </p>
      </div>
      {canSignOut && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onSignOut}
          disabled={signingOut}
          aria-label={`Sign out ${device.name}`}
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
