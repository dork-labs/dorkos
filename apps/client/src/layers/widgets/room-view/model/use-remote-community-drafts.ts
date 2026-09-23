import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import {
  communityDraftKey,
  useCommunityDraft,
  useCommunityDraftStore,
  type CommunityDraftAddress,
  type CommunityDraftFile,
} from '@/layers/entities/community';
import type { ConversationAttachmentPort } from '@/layers/features/conversation';
import type { PendingFile } from '@/layers/features/composer';

interface Delivery {
  address: string;
  context: string;
  ref: string;
  roomId: string;
  key: string;
  text: string;
  parentEntryId?: string;
  files: PendingFile[];
  attachmentIds: string[];
  status: 'sending' | 'failed';
  error?: string;
}

/** Everything one Community composer's drafts and deliveries are bound to. */
export interface RemoteCommunityDraftOptions {
  /** Community connection ref. */
  ref: string;
  /** Room inside that Community. */
  roomId: string;
  /** Whether the room accepts a post right now. */
  canSend: boolean;
  /** Entries on screen, so an owner-origin echo can confirm a pending delivery. */
  entries: RemoteCommunityEntry[];
  /** Called with a confirmed entry when its send settles inside the same context. */
  onReceipt: (entry: RemoteCommunityEntry) => void;
  /**
   * Where the unsent draft lives (owner, epoch, connection generation, room,
   * thread), or `null` while the owner is unconfirmed — nothing is held then.
   */
  draft: CommunityDraftAddress | null;
  /** Owner-and-epoch address that deliveries and errors are fenced to. */
  ownerKey: string;
  /** Route and access context that deliveries and errors are fenced to. */
  contextKey?: string;
}

/** Staged files as the composer's attachment tray expects them. */
function toPending(files: readonly CommunityDraftFile[]): PendingFile[] {
  return files.map(({ id, file }) => ({ id, file, status: 'pending', progress: 0 }));
}

/**
 * Hold a Community composer's unsent draft in the qualified draft store, so it
 * survives switching away and back, and keep retries attached to the original
 * immutable draft and upload keys until receipt or echo.
 */
export function useRemoteCommunityDrafts({
  ref,
  roomId,
  canSend,
  entries,
  onReceipt,
  draft: draftAddress,
  ownerKey,
  contextKey = ownerKey,
}: RemoteCommunityDraftOptions) {
  const transport = useTransport();
  const address = JSON.stringify([ownerKey, ref, roomId, contextKey]);
  const draft = useCommunityDraft(draftAddress);
  const text = draft.text;
  const staged = useMemo(() => toPending(draft.files), [draft.files]);
  const where = useRef(draftAddress);
  useLayoutEffect(() => {
    where.current = draftAddress;
  }, [draftAddress]);
  /** Read-modify-write against the store, so two updates in one tick both land. */
  function update(
    change: (current: { text: string; files: PendingFile[] }) => {
      text: string;
      files: PendingFile[];
    }
  ) {
    const target = where.current;
    if (!target) return;
    const store = useCommunityDraftStore.getState();
    const held = store.drafts[communityDraftKey(target)];
    const next = change({ text: held?.text ?? '', files: toPending(held?.files ?? []) });
    store.write(target, {
      text: next.text,
      files: next.files.map(({ id, file }) => ({ id, file })),
    });
  }
  function setText(next: string) {
    update((current) => ({ ...current, text: next }));
  }
  function setStaged(next: (current: PendingFile[]) => PendingFile[]) {
    update((current) => ({ ...current, files: next(current.files) }));
  }
  const [errorState, setErrorState] = useState<{
    address: string;
    context: string;
    message: string;
  } | null>(null);
  function setError(message: string | null) {
    setErrorState(message === null ? null : { address, context: contextKey, message });
  }
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const jobs = useRef(new Map<string, Delivery>());
  const running = useRef(new Set<string>());
  const authority = useRef(address);
  const context = useRef(contextKey);
  const alive = useRef(true);
  const allowed = useRef(canSend);
  const receipt = useRef(onReceipt);
  useLayoutEffect(() => {
    authority.current = address;
    context.current = contextKey;
    allowed.current = canSend;
    receipt.current = onReceipt;
  }, [address, canSend, contextKey, onReceipt]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let changed = false;
    for (const entry of entries) {
      if (!entry.originIdempotencyKey) continue;
      const job = jobs.current.get(entry.originIdempotencyKey);
      if (
        job?.address === authority.current &&
        job.context === context.current &&
        jobs.current.delete(entry.originIdempotencyKey)
      )
        changed = true;
    }
    if (changed) setDeliveries([...jobs.current.values()]);
  }, [entries]);

  function publish() {
    if (alive.current)
      setDeliveries(
        [...jobs.current.values()]
          .filter((job) => job.address === authority.current && job.context === context.current)
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
          job.ref,
          job.roomId,
          job.files[i]!.file,
          `${job.key}:file:${i}`
        );
        job.attachmentIds.push(attachment.id);
      }
      if (!allowed.current || !alive.current || job.address !== authority.current)
        throw new Error('Reconnect to this channel before retrying.');
      const entry = await transport.postRemoteCommunityEntry(job.ref, job.roomId, {
        text: job.text,
        parentEntryId: job.parentEntryId,
        attachmentIds: job.attachmentIds,
        idempotencyKey: job.key,
      });
      jobs.current.delete(job.key);
      if (alive.current && job.address === authority.current && job.context === context.current)
        receipt.current(entry);
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
    const target = where.current;
    if (!target || !allowed.current) return;
    const store = useCommunityDraftStore.getState();
    const waiting = store.drafts[communityDraftKey(target)];
    if (!waiting || (!waiting.text.trim() && waiting.files.length === 0)) return;
    if (jobs.current.size >= 30) {
      setError('Wait for pending messages or retry failed messages before sending more.');
      return;
    }
    // Taken from the store, not the render: the second of two quick Enters
    // finds nothing left and sends nothing.
    const held = store.take(target);
    const files = toPending(held.files);
    const job: Delivery = {
      address,
      context: contextKey,
      ref,
      roomId,
      key: crypto.randomUUID(),
      text: held.text.trim() ? held.text : files.map((item) => item.file.name).join(', '),
      parentEntryId,
      files,
      attachmentIds: [],
      status: 'sending',
    };
    jobs.current.set(job.key, job);
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
      setStaged(() => []);
    },
    hasFailed: false,
    isUploading: false,
    holdsSendWhileUploading: false,
  };
  return {
    text,
    setText,
    attachments,
    deliveries: deliveries.filter(
      (delivery) => delivery.address === address && delivery.context === contextKey
    ),
    error:
      errorState?.address === address && errorState.context === contextKey
        ? errorState.message
        : null,
    send,
    retry(key: string) {
      const job = jobs.current.get(key);
      if (job) void deliver(job);
    },
  };
}
