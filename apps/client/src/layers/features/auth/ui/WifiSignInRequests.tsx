import { Wifi } from 'lucide-react';
import type { WifiSignInRequest } from '@dorkos/shared/signed-in-devices';
import { Button } from '@/layers/shared/ui';
import { formatRelativeTime, isDesktopShell, openExternalLink } from '@/layers/shared/lib';
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
      {trust.requests.map((request) => (
        <RequestCard key={request.id} request={request} trust={trust} />
      ))}
      <p className="text-muted-foreground text-xs">
        Anyone on this Wi-Fi can copy a sign-in made here.
      </p>
      <p className="text-muted-foreground text-xs">Use it only on networks you trust.</p>
    </div>
  );
}

function RequestCard({ request, trust }: { request: WifiSignInRequest; trust: DeviceTrust }) {
  const shown = trust.codes[request.id];
  const busy = trust.pendingId === request.id;
  const inMacApp = isDesktopShell();
  return (
    <div className="space-y-2 rounded-md border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Wifi className="text-muted-foreground size-3.5 shrink-0" />
            <p className="text-sm font-medium">Sign-in request</p>
          </div>
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {request.deviceName} · Wi-Fi {request.address} ·{' '}
            {formatRelativeTime(request.requestedAt)}
          </p>
        </div>
      </div>
      {shown ? (
        <div className="space-y-1 text-center">
          <p className="text-muted-foreground text-xs">Type this code on {request.deviceName}:</p>
          <CodeGroups code={shown.code} />
          <p className="text-muted-foreground text-xs">{expiresIn(shown.expiresAt)}</p>
        </div>
      ) : (
        <>
          {/* Labelled and on its own row, so it never reads as the code to type.
              Once approved it is gone, and only the code to type is left. */}
          <div className="space-y-0.5">
            <p className="text-muted-foreground text-xs">Match code</p>
            <CodeGroups code={request.matchCode} className="text-base" />
          </div>
          <p className="text-muted-foreground text-xs">
            Approve only if {request.deviceName} shows the same match code.
          </p>
          {inMacApp && (
            <p className="text-muted-foreground text-xs">
              Open DorkOS in your browser on this computer to approve.
            </p>
          )}
          <div className="flex gap-2">
            {inMacApp ? (
              // The Mac app has no passkey check yet; the browser on this computer does.
              <Button size="sm" onClick={() => openExternalLink(`${window.location.origin}/`)}>
                Open in browser
              </Button>
            ) : (
              <Button size="sm" onClick={() => void trust.approve(request.id)} disabled={busy}>
                {busy ? 'Checking…' : 'Approve'}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void trust.decline(request.id)}
              disabled={busy}
            >
              Decline
            </Button>
          </div>
          {trust.lastId === request.id && <TrustNote trust={trust} />}
        </>
      )}
    </div>
  );
}

/**
 * Why the last action on a request or device didn't go through, shown beside
 * it: no passkey here yet, or the failure. Nothing when it went through.
 *
 * @param props.trust - The device trust state.
 */
export function TrustNote({ trust }: { trust: DeviceTrust }) {
  if (trust.needsPasskey) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Add a passkey on this computer first (Safari or Chrome), then try again.
      </p>
    );
  }
  if (!trust.error) return null;
  return (
    <p className="text-destructive text-xs" role="alert">
      {trust.error}
    </p>
  );
}

/** "Expires in N minutes", from the time the server gave. */
function expiresIn(expiresAt: string): string {
  const minutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 60_000));
  return minutes === 1 ? 'Expires in 1 minute.' : `Expires in ${minutes} minutes.`;
}
