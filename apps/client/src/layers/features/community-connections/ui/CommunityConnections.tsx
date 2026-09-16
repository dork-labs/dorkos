import { useCallback, useId, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { communityKeys, useCommunityConnections } from '@/layers/entities/community';
import { useTransport } from '@/layers/shared/model';
import { getPlatform } from '@/layers/shared/lib';
import { Button, Input, Label, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { CommunityConnectionRow } from './CommunityConnectionRow';

/** Pair this installation with independently hosted communities through their browser approval. */
export function CommunityConnections() {
  const embedded = getPlatform().isEmbedded;
  const transport = useTransport();
  const client = useQueryClient();
  const list = useCommunityConnections(!embedded);
  const id = useId();
  const [url, setUrl] = useState('');
  const [installName, setInstallName] = useState('My DorkOS');
  const [approvalUrls, setApprovalUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const addressInput = useRef<HTMLInputElement>(null);
  const onRemoved = useCallback(() => addressInput.current?.focus(), []);
  const onOutcome = useCallback((message: string) => setNotice(message), []);
  const start = useMutation({
    mutationFn: () =>
      transport.startCommunityConnection({ url: url.trim(), installName: installName.trim() }),
    onSuccess: async (result) => {
      setApprovalUrls((previous) => ({ ...previous, [result.connection.ref]: result.approvalUrl }));
      setUrl('');
      setNotice('Open the community below to approve this installation.');
      await client.invalidateQueries({ queryKey: communityKeys.connections });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!url.trim() || !installName.trim() || start.isPending) return;
    setNotice('');
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
              disabled={start.isPending}
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
              disabled={start.isPending}
            />
          </div>
        </div>
        <Button
          type="submit"
          size="sm"
          disabled={start.isPending || !url.trim() || !installName.trim()}
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
      ) : list.data.length ? (
        <ul className="space-y-3">
          {list.data.map((connection) => (
            <CommunityConnectionRow
              key={connection.ref}
              connection={connection}
              approvalUrl={approvalUrls[connection.ref]}
              onOutcome={onOutcome}
              onRemoved={onRemoved}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No communities connected.</p>
      )}
    </section>
  );
}
