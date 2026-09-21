import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import type { ConversationAttachmentPort } from '@/layers/features/conversation';
import type { PendingFile } from '@/layers/features/composer';

interface Delivery {
  address: string;
  key: string;
  text: string;
  parentEntryId?: string;
  files: PendingFile[];
  attachmentIds: string[];
  status: 'sending' | 'failed';
  error?: string;
}

/** Keep retries attached to the original immutable draft and upload keys until receipt or echo. */
export function useRemoteCommunityDrafts(
  ref: string,
  roomId: string,
  canSend: boolean,
  entries: RemoteCommunityEntry[],
  onReceipt: (entry: RemoteCommunityEntry) => void,
  draftKey = 'channel',
  ownerKey = 'local-owner'
) {
  const transport = useTransport();
  const address = JSON.stringify([ownerKey, ref, roomId]);
  const [draftState, setDraftState] = useState<{
    address: string;
    drafts: Record<string, { text: string; files: PendingFile[] }>;
  }>(() => ({ address, drafts: {} }));
  const drafts = draftState.address === address ? draftState.drafts : {};
  const text = drafts[draftKey]?.text ?? '';
  const staged = drafts[draftKey]?.files ?? [];
  function setText(next: string) {
    setDraftState((current) => {
      const values = current.address === address ? current.drafts : {};
      return {
        address,
        drafts: {
          ...values,
          [draftKey]: { text: next, files: values[draftKey]?.files ?? [] },
        },
      };
    });
  }
  function setStaged(next: PendingFile[] | ((current: PendingFile[]) => PendingFile[])) {
    setDraftState((current) => {
      const values = current.address === address ? current.drafts : {};
      return {
        address,
        drafts: {
          ...values,
          [draftKey]: {
            text: values[draftKey]?.text ?? '',
            files: typeof next === 'function' ? next(values[draftKey]?.files ?? []) : next,
          },
        },
      };
    });
  }
  const [errorState, setErrorState] = useState<{ address: string; message: string } | null>(null);
  function setError(message: string | null) {
    setErrorState(message === null ? null : { address, message });
  }
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const jobs = useRef(new Map<string, Delivery>());
  const running = useRef(new Set<string>());
  const authority = useRef(address);
  const alive = useRef(true);
  const allowed = useRef(canSend);
  const receipt = useRef(onReceipt);
  useLayoutEffect(() => {
    authority.current = address;
    allowed.current = canSend;
    receipt.current = onReceipt;
  }, [address, canSend, onReceipt]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let changed = false;
    for (const entry of entries) {
      if (entry.originIdempotencyKey && jobs.current.delete(entry.originIdempotencyKey))
        changed = true;
    }
    if (changed) setDeliveries([...jobs.current.values()]);
  }, [entries]);

  function publish() {
    if (alive.current)
      setDeliveries(
        [...jobs.current.values()]
          .filter((job) => job.address === authority.current)
          .map((job) => ({ ...job }))
      );
  }

  async function deliver(job: Delivery) {
    if (
      running.current.has(job.key) ||
      !allowed.current ||
      !alive.current ||
      job.address !== authority.current
    )
      return;
    running.current.add(job.key);
    job.status = 'sending';
    job.error = undefined;
    publish();
    try {
      for (let i = job.attachmentIds.length; i < job.files.length; i++) {
        if (!allowed.current || !alive.current || job.address !== authority.current)
          throw new Error('Reconnect to this channel before retrying.');
        const attachment = await transport.uploadRemoteCommunityAttachment(
          ref,
          roomId,
          job.files[i]!.file,
          `${job.key}:file:${i}`
        );
        job.attachmentIds.push(attachment.id);
      }
      if (!allowed.current || !alive.current || job.address !== authority.current)
        throw new Error('Reconnect to this channel before retrying.');
      const entry = await transport.postRemoteCommunityEntry(ref, roomId, {
        text: job.text,
        parentEntryId: job.parentEntryId,
        attachmentIds: job.attachmentIds,
        idempotencyKey: job.key,
      });
      jobs.current.delete(job.key);
      if (alive.current && job.address === authority.current) receipt.current(entry);
    } catch (cause) {
      job.status = 'failed';
      job.error =
        cause instanceof Error ? cause.message : 'Delivery was not confirmed. Retry this message.';
    } finally {
      running.current.delete(job.key);
      publish();
    }
  }

  function send(parentEntryId?: string) {
    if (!allowed.current || (!text.trim() && staged.length === 0)) return;
    if (jobs.current.size >= 30) {
      setError('Wait for pending messages or retry failed messages before sending more.');
      return;
    }
    const job: Delivery = {
      address,
      key: crypto.randomUUID(),
      text: text.trim() ? text : staged.map((item) => item.file.name).join(', '),
      parentEntryId,
      files: staged,
      attachmentIds: [],
      status: 'sending',
    };
    jobs.current.set(job.key, job);
    setText('');
    setStaged([]);
    setError(null);
    void deliver(job);
  }

  const attachments: ConversationAttachmentPort = {
    staged,
    add(files) {
      if (files.some((file) => file.size > 25 * 1024 * 1024)) {
        setError('Each file must be 25 MB or smaller.');
        return;
      }
      setStaged((current) => {
        if (current.length + files.length > 8) {
          setError('Attach up to eight files to one message.');
          return current;
        }
        return [
          ...current,
          ...files.map((file): PendingFile => ({
            id: crypto.randomUUID(),
            file,
            status: 'pending',
            progress: 0,
          })),
        ];
      });
    },
    remove(id) {
      setStaged((current) => current.filter((file) => file.id !== id));
    },
    retry() {
      /* Upload retries belong to the immutable delivery row after Send. */
    },
    cancel() {
      setStaged([]);
    },
    hasFailed: false,
    isUploading: false,
    holdsSendWhileUploading: false,
  };
  return {
    text,
    setText,
    attachments,
    deliveries: deliveries.filter((delivery) => delivery.address === address),
    error: errorState?.address === address ? errorState.message : null,
    send,
    retry(key: string) {
      const job = jobs.current.get(key);
      if (job) void deliver(job);
    },
  };
}
