import { Wifi } from 'lucide-react';
import type { WifiSignInRequest } from '@dorkos/shared/signed-in-devices';
import { Button } from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import type { DeviceTrust } from '../model/use-device-trust';
import { CodeGroups } from './CodeGroups';

/**
 * Devices on Wi-Fi asking to sign in, at the computer DorkOS runs on
 * (DOR-4744). Each card shows what the device says it is, its address, when it
 * asked and the code it shows, so the owner approves only the one in their
 * hand. Approving takes a fresh passkey check, then shows the code to type on
 * the device.
 */
export function WifiSignInRequests({ trust }: { trust: DeviceTrust }) {
  if (trust.requests.length === 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Waiting to sign in</p>
      {trust.requests.map((request) => (
        <RequestCard key={request.id} request={request} trust={trust} />
      ))}
      <p className="text-muted-foreground text-xs">
        Anyone on this Wi-Fi can copy a sign-in made here.
      </p>
      <p className="text-muted-foreground text-xs">Use it only on networks you trust.</p>
      {trust.needsPasskey && (
        <p className="text-muted-foreground text-xs" role="status">
          Add a passkey on this computer first, in Signing in from other devices.
        </p>
      )}
      {trust.error && (
        <p className="text-destructive text-xs" role="alert">
          {trust.error}
        </p>
      )}
    </div>
  );
}

function RequestCard({ request, trust }: { request: WifiSignInRequest; trust: DeviceTrust }) {
  const shown = trust.codes[request.id];
  const busy = trust.pendingId === request.id;
  return (
    <div className="space-y-2 rounded-md border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Wifi className="text-muted-foreground size-3.5 shrink-0" />
            <p className="truncate text-sm font-medium">{request.deviceName}</p>
          </div>
          <p className="text-muted-foreground text-xs">
            {request.address} · {formatRelativeTime(request.requestedAt)}
          </p>
        </div>
        <CodeGroups code={request.matchCode} className="text-base" />
      </div>
      {shown ? (
        <div className="space-y-1 text-center">
          <p className="text-muted-foreground text-xs">Type this code on the device:</p>
          <CodeGroups code={shown.code} />
          <p className="text-muted-foreground text-xs">Expires in 5 minutes.</p>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            Approve only if you started this on that device and its code matches.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void trust.approve(request.id)} disabled={busy}>
              {busy ? 'Checking…' : 'Approve'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void trust.decline(request.id)}
              disabled={busy}
            >
              Decline
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
