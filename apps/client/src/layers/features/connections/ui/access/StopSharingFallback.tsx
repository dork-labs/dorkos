import { useConnectorConnection, useStopSharingWithEveryAgent } from '@/layers/entities/connectors';
import { Button } from '@/layers/shared/ui';

/**
 * When the card can't load the current access (the app's service is down, say)
 * an account shared with every agent can still stop being shared: taking
 * access away needs no review (ADR 260926-192625). Renders nothing unless the
 * account is shared with every agent now.
 *
 * @param props - The connection and the app's display name.
 */
export function StopSharingFallback({
  connectionId,
  serviceName,
}: {
  connectionId: string;
  serviceName: string;
}) {
  const detail = useConnectorConnection(connectionId, true);
  const stop = useStopSharingWithEveryAgent();
  if (stop.isSuccess) {
    return (
      <p role="status" className="text-sm">
        {serviceName} is no longer shared with every agent.
      </p>
    );
  }
  if (!detail.data?.connection.everyAgent) return null;
  return (
    <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg p-3 text-sm">
      <span>Every agent can use {serviceName} now.</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={stop.isPending}
        onClick={() => stop.mutate({ connectionId })}
      >
        Stop sharing with every agent
      </Button>
      {stop.isError && (
        <p role="alert" className="text-destructive w-full text-xs">
          Couldn’t stop sharing. Try again.
        </p>
      )}
    </div>
  );
}
