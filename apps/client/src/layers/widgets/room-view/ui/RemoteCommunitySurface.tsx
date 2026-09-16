import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import {
  communityKeys,
  mergeRemoteCommunityEntries,
  useRemoteCommunityHistory,
  useRemoteCommunityMembers,
  useRemoteCommunityRoom,
  useRemoteCommunityStream,
} from '@/layers/entities/community';
import {
  Conversation,
  type ConversationCapabilities,
  type ConversationRow,
  type ConversationTarget,
} from '@/layers/features/conversation';
import type { ComposerInputHandle } from '@/layers/features/composer';
import { RemoteCommunityAgents } from './RemoteCommunityAgents';
import { useRemoteCommunityDrafts } from '../model/use-remote-community-drafts';
import { RemoteCommunityMessage } from './RemoteCommunityMessage';

const CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: true,
  runWith: false,
  attachments: true,
  mentions: true,
  streamHealth: true,
  presence: false,
  turnStatus: false,
  asks: false,
};

/** One qualified remote conversation; the parent keys it by community and room to isolate drafts. */
export function RemoteCommunitySurface({
  community,
  roomId,
  threadId,
  onThread,
}: {
  community: string;
  roomId: string;
  threadId?: string;
  onThread: (rootId?: string) => void;
}) {
  const transport = useTransport();
  const queries = useQueryClient();
  const roomQuery = useRemoteCommunityRoom(community, roomId);
  const [streamRevision, setStreamRevision] = useState(0);
  const stream = useRemoteCommunityStream(community, roomId, true, streamRevision);
  const removed = stream.status === 'removed';
  const room = removed ? null : (stream.room ?? roomQuery.data);
  const history = useRemoteCommunityHistory(
    community,
    roomId,
    threadId,
    !removed && room?.readable === true
  );
  const roster = useRemoteCommunityMembers(community, roomId, !removed && room?.readable === true);
  const [receipts, setReceipts] = useState<RemoteCommunityEntry[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const marked = useRef<string | null>(null);
  const composer = useRef<ComposerInputHandle>(null);
  const canSend = !removed && stream.status === 'live' && room?.writable === true;
  const entries = useMemo(
    () =>
      removed
        ? []
        : mergeRemoteCommunityEntries(
            community,
            roomId,
            ...(history.data?.pages.map((page) => page.entries) ?? []),
            stream.entries,
            receipts
          ),
    [community, roomId, history.data, stream.entries, receipts, removed]
  );
  const onReceipt = useCallback(
    (entry: RemoteCommunityEntry) => {
      setReceipts((current) =>
        mergeRemoteCommunityEntries(community, roomId, current, [entry]).slice(-500)
      );
    },
    [community, roomId]
  );
  const drafts = useRemoteCommunityDrafts(
    community,
    roomId,
    canSend,
    entries,
    onReceipt,
    threadId ?? 'channel'
  );
  const visible = entries.filter((entry) =>
    threadId ? entry.id === threadId || entry.threadRootEntryId === threadId : entry.depth === 0
  );
  const rows: ConversationRow[] = visible.map((entry) => ({
    kind: 'message',
    id: entry.id,
    payload: entry,
    grouping: { position: 'only' },
    author: {
      id: JSON.stringify([community, entry.authorId]),
      kind: entry.authorKind,
      displayName: entry.authorDisplayName,
    },
    at: entry.createdAt,
  }));
  const target: ConversationTarget = {
    kind: 'room',
    id: JSON.stringify([community, roomId, threadId]),
    placeholder: threadId ? 'Reply in thread…' : `Message ${room?.title ?? 'this channel'}…`,
    canSend,
    canSendReason: removed
      ? 'You no longer have access to this channel.'
      : room?.archived
        ? 'This channel is archived.'
        : !room?.joined
          ? 'Join this channel to send messages.'
          : 'Reconnecting. Saved messages are read-only until the connection returns.',
    attachments: drafts.attachments,
    async send() {
      drafts.send(threadId);
    },
  };
  async function perform(name: string, work: () => Promise<unknown>) {
    if (action) return;
    setAction(name);
    setActionError(null);
    try {
      await work();
      if (name === 'join' || name === 'leave') setStreamRevision((current) => current + 1);
      await queries.invalidateQueries({ queryKey: communityKeys.remote(community) });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The action could not be completed.');
    } finally {
      setAction(null);
    }
  }
  function markRead() {
    const latest = entries.at(-1);
    // Incomplete history and thread-only views do not claim the unseen room is read.
    if (
      threadId ||
      history.hasNextPage ||
      !latest ||
      stream.status !== 'live' ||
      marked.current === latest.cursor
    )
      return;
    marked.current = latest.cursor;
    void transport
      .setRemoteCommunityReadCursor(community, roomId, latest.cursor)
      .then(() => {
        void queries.invalidateQueries({ queryKey: communityKeys.rooms(community) });
      })
      .catch(() => {
        marked.current = null;
      });
  }
  return (
    <Conversation.Root surface="room" capabilities={CAPABILITIES} target={target}>
      <section
        className="flex h-full min-h-0 flex-col"
        aria-label={room?.title ?? 'Community channel'}
      >
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {threadId && (
            <Button variant="ghost" size="sm" onClick={() => onThread()}>
              Back to channel
            </Button>
          )}
          {!removed && room && !room.joined && !room.stale && (
            <Button
              size="sm"
              disabled={action !== null}
              onClick={() =>
                void perform('join', () => transport.joinRemoteCommunityRoom(community, roomId))
              }
            >
              Join channel
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={removed}
            onClick={() => setShowMembers(!showMembers)}
          >
            {showMembers ? 'Hide members' : 'Members'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={action !== null}
            onClick={() =>
              void perform('stop', () => transport.haltRemoteCommunityRoom(community, roomId))
            }
          >
            {action === 'stop' ? 'Stopping…' : 'Stop my agents'}
          </Button>
          {room?.joined && (
            <Button
              variant="ghost"
              size="sm"
              disabled={action !== null || !canSend}
              onClick={() =>
                void perform('leave', async () => {
                  await transport.leaveRemoteCommunityRoom(community, roomId);
                  queries.removeQueries({ queryKey: communityKeys.room(community, roomId) });
                })
              }
            >
              Leave channel
            </Button>
          )}
        </div>
        {actionError && (
          <p role="alert" className="text-destructive px-4 py-2 text-sm">
            {actionError}
          </p>
        )}
        {removed ? (
          <p role="status" className="p-6 text-sm">
            You no longer have access to this channel.
          </p>
        ) : (
          <>
            {stream.status !== 'live' && (
              <p role="status" className="text-muted-foreground px-4 py-2 text-sm">
                {stream.status === 'connecting'
                  ? 'Connecting to the community…'
                  : 'Connection lost. Showing saved messages.'}
              </p>
            )}
            {roomQuery.isError && (
              <p role="alert" className="px-4 py-2 text-sm">
                This channel could not be loaded.
              </p>
            )}
            {showMembers && (
              <div className="max-h-48 overflow-auto border-b p-3" aria-label="Channel members">
                {roster.isError && <p role="alert">Members could not be loaded.</p>}
                {roster.data?.stale && (
                  <p className="text-muted-foreground text-sm">Saved member list</p>
                )}
                {roster.data?.members.map((member) => (
                  <div
                    key={member.memberId}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span>
                      {member.displayName}
                      {member.kind === 'agent' ? ' · Agent' : ''}
                      {member.ownerMemberId &&
                        ` · owned by ${roster.data.members.find((owner) => owner.memberId === member.ownerMemberId)?.displayName ?? 'a community member'}`}
                    </span>
                    {member.handle && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!canSend}
                        onClick={() => {
                          drafts.setText(
                            `${drafts.text}${drafts.text && !drafts.text.endsWith(' ') ? ' ' : ''}@${member.handle} `
                          );
                          composer.current?.focus();
                        }}
                      >
                        Mention @{member.handle}
                      </Button>
                    )}
                  </div>
                ))}
                <RemoteCommunityAgents
                  community={community}
                  roomId={roomId}
                  online={stream.status === 'live'}
                />
              </div>
            )}
            {history.isError && (
              <p role="alert" className="p-3 text-sm">
                Some messages could not be loaded.{' '}
                <Button variant="ghost" size="sm" onClick={() => void history.refetch()}>
                  Retry
                </Button>
              </p>
            )}
            {history.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                disabled={history.isFetchingNextPage}
                onClick={() => void history.fetchNextPage()}
              >
                Load the next page of history
              </Button>
            )}
            <Conversation.Timeline
              conversationId={target.id}
              rows={rows}
              label={threadId ? 'Community thread' : 'Community messages'}
              busy={history.isFetching}
              onReachedBottom={markRead}
              onOpenThread={onThread}
              empty={
                <p className="text-muted-foreground p-6 text-sm">
                  {history.isPending ? 'Loading messages…' : 'No messages here yet.'}
                </p>
              }
              renderRow={(_, context) => (
                <RemoteCommunityMessage entry={visible[context.index]!} onThread={onThread} />
              )}
            />
            {drafts.deliveries
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
                      onClick={() => drafts.retry(job.key)}
                    >
                      Retry message
                    </Button>
                  )}
                </div>
              ))}
            {drafts.error && (
              <p role="alert" className="text-destructive px-4 py-2 text-sm">
                {drafts.error}
              </p>
            )}
            <Conversation.Composer
              inputRef={composer}
              className="m-3"
              value={drafts.text}
              onChange={drafts.setText}
              onSubmit={() => drafts.send(threadId)}
              input={{
                isStreaming: false,
                contextKey: target.id,
                canSubmit: drafts.text.trim().length > 0 || drafts.attachments.staged.length > 0,
              }}
            />
          </>
        )}
      </section>
    </Conversation.Root>
  );
}
