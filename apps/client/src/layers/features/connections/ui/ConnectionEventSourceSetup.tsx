import { useState } from 'react';
import type { ConnectionEventSourceStatus } from '@dorkos/shared/connector-event-schemas';
import { useConfigureConnectionEventSource } from '@/layers/entities/connectors';
import { Button, Input, Label } from '@/layers/shared/ui';

function isPublicHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** Whether one secret-free source status can accept a new owner event decision. */
export function isConnectionEventSourceReady(status: ConnectionEventSourceStatus): boolean {
  return (
    status.setupMode === 'managed' || (status.setupMode === 'byo_webhook' && status.configured)
  );
}

/** Render server-declared event delivery setup without retaining write-only secrets. */
export function ConnectionEventSourceSetup({
  connectionId,
  status,
  idPrefix = 'notification',
}: {
  connectionId: string;
  status: ConnectionEventSourceStatus;
  idPrefix?: string;
}) {
  const configure = useConfigureConnectionEventSource();
  const [publicOrigin, setPublicOrigin] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const currentStatus = configure.data ?? status;

  if (currentStatus.setupMode === 'managed') {
    return (
      <div className="bg-muted/40 rounded-lg p-3 text-sm">
        <p className="font-medium">Delivery is managed by DorkOS</p>
        <p className="text-muted-foreground mt-1 text-xs">
          Each notification below still shows whether its own setup is pending or active.
        </p>
      </div>
    );
  }
  if (currentStatus.setupMode === 'unavailable') {
    return (
      <p className="text-muted-foreground bg-muted/40 rounded-lg p-3 text-sm">
        {currentStatus.reason ?? 'Notification delivery setup is unavailable for this account.'}
      </p>
    );
  }

  const originId = `${idPrefix}-public-origin`;
  const secretId = `${idPrefix}-webhook-secret`;
  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="notification-source-setup">
      <div>
        <p className="text-sm font-medium">Service delivery</p>
        <p className="text-muted-foreground text-xs">
          Add your public DorkOS address and the signing secret from Composio. The secret is sent
          once and is never shown again.
        </p>
      </div>
      {currentStatus.configured && currentStatus.endpoint && (
        <div className="bg-muted/40 rounded-md p-2.5">
          <p className="text-muted-foreground text-xs">Webhook endpoint</p>
          <p className="mt-1 font-mono text-xs break-all">{currentStatus.endpoint}</p>
        </div>
      )}
      <div className="space-y-1">
        <Label htmlFor={originId}>Public DorkOS address</Label>
        <Input
          id={originId}
          type="url"
          placeholder="https://your-dorkos.example"
          value={publicOrigin}
          onChange={(event) => setPublicOrigin(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={secretId}>Signing secret</Label>
        <Input
          id={secretId}
          type="password"
          autoComplete="off"
          value={webhookSecret}
          onChange={(event) => setWebhookSecret(event.target.value)}
        />
      </div>
      {configure.isError && (
        <p role="alert" className="text-destructive text-sm">
          We couldn’t save delivery setup. Re-enter the signing secret to try again.
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={
          configure.isPending ||
          webhookSecret.length < 16 ||
          !isPublicHttpsOrigin(publicOrigin.trim())
        }
        onClick={() => {
          const secret = webhookSecret;
          setWebhookSecret('');
          configure.mutate({
            connectionId,
            input: { publicOrigin: publicOrigin.trim(), webhookSecret: secret },
          });
        }}
      >
        {configure.isPending ? 'Saving…' : currentStatus.configured ? 'Update setup' : 'Save setup'}
      </Button>
    </div>
  );
}
