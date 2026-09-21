import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  communityKeys,
  useCommunityConnections,
  useConfirmedCommunityAuthority,
} from '@/layers/entities/community';
import { useTransport } from '@/layers/shared/model';
import { getPlatform, isCommunityAuthorityCurrent } from '@/layers/shared/lib';
import { Button, Input, Label, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { CommunityConnectionRow } from './CommunityConnectionRow';

/** Pair this installation with independently hosted communities through their browser approval. */
export function CommunityConnections() {
  const embedded = getPlatform().isEmbedded;
  const transport = useTransport();
  const client = useQueryClient();
  const authority = useConfirmedCommunityAuthority(!embedded);
  const list = useCommunityConnections(!embedded);
  const authorityAddress = authority ? JSON.stringify([authority.ownerKey, authority.epoch]) : '';
  const id = useId();
  const [url, setUrl] = useState('');
  const [installName, setInstallName] = useState('My DorkOS');
  const [approvalState, setApprovalState] = useState<{
    address: string;
    urls: Record<string, string>;
  }>({ address: '', urls: {} });
  const approvalUrls = approvalState.address === authorityAddress ? approvalState.urls : {};
  const [noticeState, setNoticeState] = useState({ address: '', message: '' });
  const notice = noticeState.address === authorityAddress ? noticeState.message : '';
  const addressInput = useRef<HTMLInputElement>(null);
  const onRemoved = useCallback(() => addressInput.current?.focus(), []);
  const onOutcome = useCallback(
    (message: string) => setNoticeState({ address: authorityAddress, message }),
    [authorityAddress]
  );
  const start = useMutation({
    mutationFn: async () => {
      if (!authority || !isCommunityAuthorityCurrent(authority))
        throw new Error('Community owner is still loading.');
      const result = await transport.startCommunityConnection({
        url: url.trim(),
        installName: installName.trim(),
      });
      if (!isCommunityAuthorityCurrent(authority)) throw new Error('Community owner changed.');
      return result;
    },
    onSuccess: async (result) => {
      setApprovalState((previous) => ({
        address: authorityAddress,
        urls: {
          ...(previous.address === authorityAddress ? previous.urls : {}),
          [result.connection.ref]: result.approvalUrl,
        },
      }));
      setUrl('');
      setNoticeState({
        address: authorityAddress,
        message: 'Open the community below to approve this installation.',
      });
      if (authority)
        await client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !installName.trim() || start.isPending) return;
    setNoticeState({ address: authorityAddress, message: '' });
    start.mutate();
  }
  if (embedded) return null;

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-semibold">
          Communities
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Connect to a community where people and agents share channels.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-url`}>Community address</Label>
            <Input
              ref={addressInput}
              id={`${id}-url`}
              type="url"
              placeholder="https://community.example.com"
              required
              autoComplete="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={start.isPending || !authority}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Name for this installation</Label>
            <Input
              id={`${id}-name`}
              required
              maxLength={120}
              value={installName}
              onChange={(event) => setInstallName(event.target.value)}
              disabled={start.isPending || !authority}
            />
          </div>
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={start.isPending || !authority || !url.trim() || !installName.trim()}
        >
          {start.isPending ? 'Connecting…' : 'Connect community'}
        </Button>
        {start.error && (
          <p role="alert" className="text-destructive text-sm">
            Could not connect. Check the community address and try again.
          </p>
        )}
      </form>
      <p role="status" aria-live="polite" className="text-muted-foreground text-sm">
        {notice}
      </p>
      {list.isPending ? (
        <Skeleton className="h-20 rounded-lg" aria-label="Loading communities" />
      ) : list.isError ? (
        <QueryErrorState
          title="Couldn’t load communities"
          description="Check that DorkOS is running, then try again."
          onRetry={() => void list.refetch()}
          isRetrying={list.isFetching}
        />
      ) : authority && list.data.length ? (
        <ul className="space-y-3">
          {list.data.map((connection) => (
            <CommunityConnectionRow
              key={connection.ref}
              connection={connection}
              approvalUrl={approvalUrls[connection.ref]}
              onOutcome={onOutcome}
              onRemoved={onRemoved}
              authority={authority}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No communities connected.</p>
      )}
    </section>
  );
}
