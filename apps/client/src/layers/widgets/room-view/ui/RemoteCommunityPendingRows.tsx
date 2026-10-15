import type { CommunityDeliverySnapshot } from '@dorkos/shared/community-deliveries';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { Button } from '@/layers/shared/ui';
import type { PendingFile } from '@/layers/features/composer';

/** One of the person's own messages on its way, as the drafts hook holds it. */
interface PendingDraft {
  key: string;
  text: string;
  parentEntryId?: string;
  files: PendingFile[];
  status: 'sending' | 'failed';
  error?: string;
}

/**
 * The messages on their way into this channel or thread that the space has not confirmed yet:
 * your agents' posts, then your own, each with its retry. A row goes once its message arrives.
 */
export function RemoteCommunityPendingRows({
  agentDeliveries,
  drafts,
  entries,
  threadId,
  canSend,
  action,
  onRetryAgent,
  onRetryDraft,
}: {
  agentDeliveries: CommunityDeliverySnapshot['deliveries'];
  drafts: PendingDraft[];
  entries: RemoteCommunityEntry[];
  threadId?: string;
  canSend: boolean;
  /** The surface action running now, so an agent retry shows its own progress. */
  action: string | null;
  onRetryAgent: (idempotencyKey: string) => void;
  onRetryDraft: (key: string) => void;
}) {
  return (
    <>
      {agentDeliveries
        .filter(
          (delivery) =>
            delivery.parentEntryId === (threadId ?? null) &&
            !entries.some((entry) => entry.originIdempotencyKey === delivery.idempotencyKey)
        )
        .map((delivery) => (
          <div key={delivery.idempotencyKey} className="border-t px-4 py-2 text-sm" role="status">
            <p className="font-medium">{delivery.author.displayName} · Agent</p>
            <p className="whitespace-pre-wrap">{delivery.text}</p>
            {delivery.attachments.map((file, index) => (
              <span key={index} className="mr-2">
                {file.name}
              </span>
            ))}
            <p className="text-muted-foreground">
              {delivery.state === 'pending'
                ? 'Waiting for the space to confirm…'
                : delivery.failure === 'expired'
                  ? 'Not confirmed. Too late to try again.'
                  : 'Not confirmed. Check the space and the agent’s channel access.'}
            </p>
            {delivery.state === 'pending' && delivery.retryable && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canSend || action !== null}
                onClick={() => onRetryAgent(delivery.idempotencyKey)}
              >
                {action === `retry:${delivery.idempotencyKey}` ? 'Retrying…' : 'Retry now'}
              </Button>
            )}
          </div>
        ))}
      {drafts
        .filter(
          (job) =>
            job.parentEntryId === threadId &&
            !entries.some((entry) => entry.originIdempotencyKey === job.key)
        )
        .map((job) => (
          <div key={job.key} className="border-t px-4 py-2 text-sm" role="status">
            <p className="whitespace-pre-wrap">{job.text}</p>
            {job.files.map((file) => (
              <span key={file.id} className="mr-2">
                {file.file.name}
              </span>
            ))}
            <p className="text-muted-foreground">
              {job.status === 'sending' ? 'Sending…' : 'Delivery not confirmed.'}
            </p>
            {job.error && <p>{job.error}</p>}
            {job.status === 'failed' && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => onRetryDraft(job.key)}
              >
                Retry message
              </Button>
            )}
          </div>
        ))}
    </>
  );
}
