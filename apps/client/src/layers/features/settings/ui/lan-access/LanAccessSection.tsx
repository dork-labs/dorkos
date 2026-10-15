import type { LanAccessStatus } from '@dorkos/shared/types';
import { CopyButton, Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { TunnelQrCode } from '@/layers/entities/tunnel';
import { useLanAccess } from '../../model/use-lan-access';

/** The address a device on the same network opens: the `.local` name, else the first IP. */
function primaryAddress(status: LanAccessStatus): string | null {
  const host = status.localName ?? status.addresses[0];
  return host ? `http://${host}:${status.port}` : null;
}

/** One address with its copy button. */
function AddressRow({ url, label }: { url: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <code className="truncate text-sm">{url}</code>
      <CopyButton value={url} label={label} />
    </div>
  );
}

/** The addresses and QR code another device uses, shown while the listener is open. */
function LanAddresses({ status }: { status: LanAccessStatus }) {
  const primary = primaryAddress(status);
  if (!primary) {
    return <p className="text-muted-foreground text-xs">Join a Wi-Fi network to get an address.</p>;
  }
  // The IPs back up the `.local` name; with no name, the first IP is the primary.
  const backups = status.localName
    ? status.addresses.map((ip) => `http://${ip}:${status.port}`)
    : status.addresses.slice(1).map((ip) => `http://${ip}:${status.port}`);
  return (
    <div className="space-y-3">
      <TunnelQrCode url={primary} size={160} />
      <p className="text-muted-foreground text-center text-xs">
        Scan with a phone or tablet on the same Wi-Fi.
      </p>
      <AddressRow url={primary} label="Copy address" />
      {backups.length > 0 && (
        <div className="space-y-1">
          <p className="text-muted-foreground text-xs">If that name doesn’t open, use:</p>
          {backups.map((url) => (
            <AddressRow key={url} url={url} label="Copy address" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Wi-Fi access (DOR-2930): the one switch that lets other devices on the same
 * network open DorkOS, its addresses, and a QR code to scan. Sits under remote
 * access in Settings; it needs no tunnel and no restart.
 */
export function LanAccessSection({ className }: { className?: string }) {
  const { status, busy, error, setEnabled } = useLanAccess();
  if (!status) return null;

  const lockedByEnv = status.envHost !== null;
  const shownError = error ?? status.error;

  return (
    <section
      aria-labelledby="lan-access-title"
      className={cn('border-border bg-muted/30 space-y-3 rounded-lg border p-4', className)}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="lan-access-title" className="text-sm font-medium">
            Let devices on my Wi-Fi in
          </p>
          <p className="text-muted-foreground text-xs">
            For home or office Wi-Fi. The connection isn’t encrypted yet.
          </p>
        </div>
        <Switch
          aria-labelledby="lan-access-title"
          checked={lockedByEnv ? false : status.enabled}
          onCheckedChange={(checked) => void setEnabled(checked)}
          disabled={busy || lockedByEnv}
        />
      </div>
      {lockedByEnv && (
        <p className="text-muted-foreground text-xs">
          DORKOS_HOST is set to {status.envHost}, so it decides where DorkOS listens.
        </p>
      )}
      {shownError && <p className="text-destructive text-xs">{shownError}</p>}
      {status.listening && <LanAddresses status={status} />}
    </section>
  );
}
