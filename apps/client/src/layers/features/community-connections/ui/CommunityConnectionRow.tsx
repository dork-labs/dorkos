import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { isCommunityAuthorityCurrent, type ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import { communityKeys, withinCommunityAuthority } from '@/layers/entities/community';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

interface Props {
  connection: CommunityConnectionDescriptor;
  approvalUrl?: string;
  onOutcome: (message: string) => void;
  onRemoved: () => void;
  authority: ConfirmedCommunityAuthority;
}

/** One owner-scoped connection, with bounded approval polling and an explicit disconnect action. */
export function CommunityConnectionRow({
  connection,
  approvalUrl,
  onOutcome,
  onRemoved,
  authority,
}: Props) {
  const transport = useTransport();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const disconnectButton = useRef<HTMLButtonElement>(null);
  const approvalLink = useRef<HTMLAnchorElement>(null);
  const wasConfirming = useRef(false);
  const pending = connection.status === 'pending';
  const reconnectRequired = connection.status === 'reconnect-required';
  const poll = useQuery({
    queryKey: communityKeys.approval(authority, connection.ref),
    queryFn: () =>
      withinCommunityAuthority(authority, () => transport.pollCommunityConnection(connection.ref)),
    enabled: pending,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error && (!query.state.data || query.state.data.status === 'pending')
        ? 2_000
        : false,
  });
  useEffect(() => {
    if (!pending || !poll.data || poll.data.status === 'pending') return;
    const status = poll.data.status;
    onOutcome(
      status === 'connected'
        ? `${connection.label} is connected.`
        : status === 'expired'
          ? `Approval for ${connection.label} expired. Connect again to continue.`
          : `Approval for ${connection.label} was cancelled.`
    );
    void client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
  }, [pending, poll.data, connection.label, client, onOutcome, authority]);
  useEffect(() => {
    if (confirm) cancelButton.current?.focus();
    else if (wasConfirming.current) disconnectButton.current?.focus();
    wasConfirming.current = confirm;
  }, [confirm]);
  useEffect(() => {
    if (approvalUrl && pending) approvalLink.current?.focus();
  }, [approvalUrl, pending]);

  const remove = useMutation({
    mutationFn: () =>
      pending
        ? transport.cancelCommunityConnection(connection.ref)
        : transport.disconnectCommunity(connection.ref),
    onSuccess: async () => {
      if (!isCommunityAuthorityCurrent(authority)) return;
      await client.cancelQueries({ queryKey: communityKeys.remote(authority, connection.ref) });
      client.removeQueries({ queryKey: communityKeys.remote(authority, connection.ref) });
      client.setQueryData<CommunityConnectionDescriptor[]>(
        communityKeys.connections(authority),
        (rows) => rows?.filter((row) => row.ref !== connection.ref)
      );
      onOutcome(
        pending
          ? `Approval for ${connection.label} was cancelled.`
          : reconnectRequired
            ? `${connection.label} is disconnected. Connect again to continue.`
            : `${connection.label} is disconnected.`
      );
      onRemoved();
    },
    // Cancellation can erase local proof even when the remote host cannot answer.
    onSettled: () => client.invalidateQueries({ queryKey: communityKeys.connections(authority) }),
  });
  const error = remove.error ?? poll.error;

  return (
    <li className="bg-muted/40 space-y-3 rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">{connection.label}</h4>
          <p className="text-muted-foreground text-xs break-all">{connection.pinnedOrigin}</p>
          <p className="mt-1 text-sm">
            {pending
              ? 'Waiting for your approval'
              : reconnectRequired
                ? 'Reconnect required'
                : 'Connected'}
          </p>
          {reconnectRequired && (
            <p className="text-muted-foreground mt-1 text-sm">
              Disconnect here, then connect again.
            </p>
          )}
        </div>
        {!confirm && (
          <Button
            ref={disconnectButton}
            size="sm"
            variant="outline"
            disabled={remove.isPending}
            onClick={() => (pending || reconnectRequired ? remove.mutate() : setConfirm(true))}
            aria-label={`${pending ? 'Cancel approval for' : 'Disconnect'} ${connection.label}`}
          >
            {pending ? 'Cancel approval' : 'Disconnect'}
          </Button>
        )}
      </div>
      {pending &&
        (approvalUrl ? (
          <a
            ref={approvalLink}
            href={approvalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring inline-block rounded text-sm underline underline-offset-4"
          >
            Open {connection.label} to approve
          </a>
        ) : (
          <p className="text-muted-foreground text-sm">
            Approve in the community tab you opened. If you closed it, cancel and connect again.
          </p>
        ))}
      {confirm && (
        <div className="space-y-2">
          <p className="text-sm">
            Disconnect this installation from {connection.label}? Your community account will
            remain.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={cancelButton}
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => setConfirm(false)}
            >
              Keep connected
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? 'Disconnecting…' : 'Confirm disconnect'}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p>
            {remove.error
              ? pending
                ? 'Could not confirm cancellation. Refresh to check its current state.'
                : 'Could not confirm disconnection. Try again.'
              : 'Could not check approval. Try again.'}
          </p>
          {!remove.error && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void poll.refetch()}
              disabled={poll.isFetching}
            >
              Check approval
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
