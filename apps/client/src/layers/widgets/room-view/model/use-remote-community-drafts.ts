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
import { isConductHold } from './use-remote-community-conduct';

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
  /** The composer it was sent from and exactly what was typed, to go back to if it can never send. */
  origin: { draft: CommunityDraftAddress; typed: string; seq: number };
}

/**
 * The refusals that mean the whole Community is gone: deleted, or taken down by its host. A
 * message refused this way can never send, and the page is about to show the gone panel instead
 * of this room, so it goes back into its composer's draft, where the panel counts it and offers
 * to copy it (DOR-2575) — never lost with the room.
 */
const COMMUNITY_GONE_CODES: ReadonlySet<string> = new Set([
  'COMMUNITY_DELETED',
  'COMMUNITY_TAKEN_DOWN',
]);

/**
 * How long an uploaded file is reused when a held message is sent again. A space removes a file
 * no message took after an hour, so a reuse stays well inside that; past it the file is sent
 * again under the same key, which the space answers with the first upload if it still has it.
 */
const UPLOAD_REUSE_MS = 30 * 60_000;

/** Uploads a held message already made, by space, room and staged-file id. */
type UploadMemory = Map<string, { attachmentId: string; at: number }>;

function uploadKey(ref: string, roomId: string, fileId: string): string {
  return JSON.stringify([ref, roomId, fileId]);
}

/** The attachment a held message already uploaded for this file, while it is still reusable. */
function reusableUpload(memory: UploadMemory, key: string): string | undefined {
  const earlier = memory.get(key);
  return earlier && Date.now() - earlier.at < UPLOAD_REUSE_MS ? earlier.attachmentId : undefined;
}

function rememberUpload(memory: UploadMemory, key: string, attachmentId: string): void {
  memory.set(key, { attachmentId, at: Date.now() });
}

/** Drop a sent message's uploads: they belong to its post now, and none is sent again. */
function forgetUploads(memory: UploadMemory, job: Delivery): void {
  for (const staged of job.files) memory.delete(uploadKey(job.ref, job.roomId, staged.id));
}

/** Join the non-blank parts of a draft with a blank line, so no part leaves an empty one. */
function joinDraft(parts: readonly string[]): string {
  return parts.filter((part) => part.trim()).join('\n\n');
}

function isCommunityGone(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && COMMUNITY_GONE_CODES.has(code);
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
  /**
   * Told when the space's moderation held a post (a mute, slow mode, rules not accepted). The
   * message is back in its draft by then, so the person sends it again once the hold lifts.
   */
  onHold?: (cause: unknown) => void;
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
  onHold,
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
  const sent = useRef(0);
  /**
   * Files a held message already uploaded, by space, room and staged-file id, so sending it again
   * attaches them instead of uploading them a second time (DOR-2835).
   */
  const uploaded = useRef<UploadMemory>(new Map());
  /** Messages already put back in each composer's draft, by draft key, in the order they were sent. */
  const returned = useRef(new Map<string, Delivery[]>());
  const running = useRef(new Set<string>());
  const authority = useRef(address);
  const context = useRef(contextKey);
  const alive = useRef(true);
  const allowed = useRef(canSend);
  const receipt = useRef(onReceipt);
  const held = useRef(onHold);
  useLayoutEffect(() => {
    authority.current = address;
    context.current = contextKey;
    allowed.current = canSend;
    receipt.current = onReceipt;
    held.current = onHold;
  }, [address, canSend, contextKey, onReceipt, onHold]);
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
      ) {
        forgetUploads(uploaded.current, job);
        changed = true;
      }
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
          throw new Error('Reconnect to this channel, then try again.');
        const staged = job.files[i]!;
        const fileKey = uploadKey(job.ref, job.roomId, staged.id);
        const earlier = reusableUpload(uploaded.current, fileKey);
        if (earlier) {
          job.attachmentIds.push(earlier);
          continue;
        }
        // Keyed by the staged file, not this send, so the space answers a held message sent
        // again with the upload it already has.
        const attachment = await transport.uploadRemoteCommunityAttachment(
          job.ref,
          job.roomId,
          staged.file,
          `file:${staged.id}`
        );
        rememberUpload(uploaded.current, fileKey, attachment.id);
        job.attachmentIds.push(attachment.id);
      }
      if (!allowed.current || !alive.current || job.address !== authority.current)
        throw new Error('Reconnect to this channel, then try again.');
      const entry = await transport.postRemoteCommunityEntry(job.ref, job.roomId, {
        text: job.text,
        parentEntryId: job.parentEntryId,
        attachmentIds: job.attachmentIds,
        idempotencyKey: job.key,
      });
      jobs.current.delete(job.key);
      forgetUploads(uploaded.current, job);
      if (alive.current && job.address === authority.current && job.context === context.current)
        receipt.current(entry);
    } catch (cause) {
      if (isCommunityGone(cause) && returnToDraft(job)) {
        jobs.current.delete(job.key);
        return;
      }
      // Held, not lost: it goes back to its draft, and the hold says when it can go.
      if (isConductHold(cause) && returnToDraft(job)) {
        jobs.current.delete(job.key);
        if (alive.current && job.address === authority.current) held.current?.(cause);
        return;
      }
      job.status = 'failed';
      job.error = cause instanceof Error ? cause.message : 'Not confirmed. Try this message again.';
    } finally {
      running.current.delete(job.key);
      publish();
    }
  }

  /**
   * Put a message that can never send, or that the space held, back into its composer's draft.
   * Every message returned this way goes first, oldest sent first, then whatever was typed
   * since; once the person has changed that returned part, the next one simply goes in front.
   * Refused (and so `false`) once its connection has ended, when nothing could read it back.
   */
  function returnToDraft(job: Delivery): boolean {
    const { draft } = job.origin;
    const key = communityDraftKey(draft);
    const store = useCommunityDraftStore.getState();
    const held = store.drafts[key];
    const current = held?.text ?? '';
    let earlier = returned.current.get(key) ?? [];
    const earlierText = joinDraft(earlier.map((item) => item.origin.typed));
    let typedSince = current;
    if (earlierText && current.startsWith(earlierText))
      typedSince = current.slice(earlierText.length).replace(/^\n+/, '');
    else earlier = [];
    const now = [...earlier, job].sort((a, b) => a.origin.seq - b.origin.seq);
    const returnedIds = new Set(now.flatMap((item) => item.files.map((file) => file.id)));
    const files = [
      ...now.flatMap((item) => item.files.map(({ id, file }) => ({ id, file }))),
      ...(held?.files ?? []).filter((file) => !returnedIds.has(file.id)),
    ];
    store.write(draft, {
      text: joinDraft([...now.map((item) => item.origin.typed), typedSince]),
      files,
    });
    if (!(key in useCommunityDraftStore.getState().drafts)) return false;
    returned.current.set(key, now);
    return true;
  }

  function send(parentEntryId?: string) {
    const target = where.current;
    if (!target || !allowed.current) return;
    const store = useCommunityDraftStore.getState();
    const waiting = store.drafts[communityDraftKey(target)];
    if (!waiting || (!waiting.text.trim() && waiting.files.length === 0)) return;
    if (jobs.current.size >= 30) {
      setError('Too many messages waiting. Let them send, or retry them first.');
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
      origin: { draft: target, typed: held.text, seq: (sent.current += 1) },
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
