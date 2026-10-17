import type { ReactNode } from 'react';
import type { RemoteCommunityDm } from '@dorkos/shared/community-dm-views';
import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityDm,
  useRemoteCommunityMembers,
} from '@/layers/entities/community';
import { Button } from '@/layers/shared/ui';
import { RemoteDmTranscript } from './RemoteDmTranscript';

/**
 * A space room address that may name a direct message with an agent (DOR-2955). An ordinary
 * channel renders as before. The person's own direct message gets a line saying whose agent it
 * is and who can read it, then the room. Someone's direct message with the owner's agent opens
 * read-only, read through that agent.
 *
 * It never guesses: until the list of direct messages has arrived, or when it couldn't be read,
 * it shows a quiet state of its own, so a direct message is never opened as an ordinary channel
 * with the person's own access. Only a space that can't be reached live (a saved copy) opens the
 * room directly, since nothing can be asked of it.
 */
export function RemoteDmRoom({
  community,
  roomId,
  children,
}: {
  community: string;
  roomId: string;
  /**
   * The ordinary room, for a channel or the person's own direct message; told the agent's name
   * in a direct message, so the room can name it and offer no way to leave.
   */
  children: (dmAgentName?: string) => ReactNode;
}) {
  const connections = useCommunityConnections();
  const connection = connections.data?.find((item) => item.ref === community);
  const access = communityAccessState(connection?.access);
  const live = access.verified && access.capabilities.read;
  const { dm, status, retry } = useRemoteCommunityDm(community, roomId, live, access.fingerprint);
  if (!connection) return <RoomPending />;
  if (!live) return children();
  if (status === 'loading') return <RoomPending />;
  if (status === 'error')
    return (
      <div role="alert" className="text-muted-foreground p-6 text-center text-sm">
        Couldn’t load this space’s direct messages.{' '}
        <Button variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  if (!dm) return children();
  if (dm.readOnly && dm.localAgentId)
    return (
      <RemoteDmTranscript dm={dm} localAgentId={dm.localAgentId} access={access.fingerprint} />
    );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RemoteDmHeader dm={dm} accessFingerprint={access.fingerprint} />
      <div className="min-h-0 flex-1">{children(dm.agent.displayName)}</div>
    </div>
  );
}

/** A quiet stand-in while the room's kind is still unknown. */
function RoomPending() {
  return <div className="h-full" aria-busy="true" />;
}

/** Whose agent this is, that its owner can read along, and whether it can answer right now. */
function RemoteDmHeader({
  dm,
  accessFingerprint,
}: {
  dm: RemoteCommunityDm;
  accessFingerprint: string;
}) {
  const members = useRemoteCommunityMembers(dm.community, dm.roomId, true, accessFingerprint);
  const agent = members.data?.members.find((member) => member.memberId === dm.agent.memberId);
  const owner = dm.agent.ownerDisplayName;
  return (
    <section className="border-b px-4 py-2 text-sm" aria-label="About this direct message">
      <p>
        <span className="font-medium">{dm.agent.displayName}</span>
        <span className="text-muted-foreground">
          {` · ${owner}’s agent · ${owner} can read this`}
        </span>
      </p>
      {agent?.availability === 'offline' && (
        <p role="status" className="text-muted-foreground text-xs">
          {`Offline. ${dm.agent.displayName} won’t answer until its computer is back on.`}
        </p>
      )}
    </section>
  );
}
