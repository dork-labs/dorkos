import { useLayoutEffect, useRef } from 'react';
import type { RemoteCommunityDm } from '@dorkos/shared/community-dm-views';
import { useRemoteCommunityAgentDmEntries } from '@/layers/entities/community';
import { Button } from '@/layers/shared/ui';
import {
  Conversation,
  type ConversationCapabilities,
  type ConversationTarget,
} from '@/layers/features/conversation';
import { RemoteCommunityMessage } from '../RemoteCommunityMessage';

/** Nothing to do here but read. */
const READ_ONLY: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

/**
 * Someone's direct message with one of the owner's agents, read through that agent and only
 * read (DOR-2955): the owner sees what their agent was asked and what it said, with no composer.
 */
export function RemoteDmTranscript({
  dm,
  localAgentId,
  access,
}: {
  dm: RemoteCommunityDm;
  localAgentId: string;
  /** The connection's current access fingerprint. */
  access: string;
}) {
  const entries = useRemoteCommunityAgentDmEntries(dm.community, dm.roomId, localAgentId, access);
  const scroller = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const newest = entries.data?.entries.at(-1)?.id;
  // Open on the newest message, and follow new ones while the reader is at the bottom.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [newest]);
  const target: ConversationTarget = {
    kind: 'room',
    id: JSON.stringify([dm.community, dm.roomId, 'read-only']),
    placeholder: '',
    canSend: false,
    canSendReason: 'This direct message is read-only.',
    attachments: null,
    send: () => Promise.reject(new Error('This direct message is read-only.')),
  };
  return (
    <Conversation.Root surface="room" capabilities={READ_ONLY} target={target}>
      <div className="flex h-full min-h-0 flex-col">
        <section className="border-b px-4 py-2 text-sm" aria-label="About this direct message">
          <p>
            <span className="font-medium">{`${dm.member.displayName} with ${dm.agent.displayName}`}</span>
            <span className="text-muted-foreground"> · Read-only</span>
          </p>
          <p className="text-muted-foreground text-xs">
            {`Only ${dm.member.displayName} and ${dm.agent.displayName} can post here.`}
          </p>
        </section>
        <section
          ref={scroller}
          onScroll={(event) => {
            const box = event.currentTarget;
            atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-auto py-2"
          aria-label="Messages"
        >
          {entries.isError && (
            <p role="alert" className="px-4 text-sm">
              Couldn’t load this direct message.{' '}
              <Button variant="ghost" size="sm" onClick={() => void entries.refetch()}>
                Retry
              </Button>
            </p>
          )}
          {entries.data?.entries.length === 0 && (
            <p className="text-muted-foreground px-4 text-sm">No messages yet.</p>
          )}
          {entries.data?.entries.map((entry) => (
            <RemoteCommunityMessage key={entry.id} entry={entry} />
          ))}
        </section>
      </div>
    </Conversation.Root>
  );
}
