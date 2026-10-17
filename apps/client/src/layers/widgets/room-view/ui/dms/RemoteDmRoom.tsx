import type { ReactNode } from 'react';
import type { RemoteCommunityDm } from '@dorkos/shared/community-dm-views';
import {
  communityAccessState,
  useCommunityConnections,
  useRemoteCommunityDm,
  useRemoteCommunityMembers,
} from '@/layers/entities/community';
import { RemoteDmTranscript } from './RemoteDmTranscript';

/**
 * A space room address that may name a direct message with an agent (DOR-2955). An ordinary
 * channel renders as before. The person's own direct message gets a line saying whose agent it
 * is and who can read it, then the room. Someone's direct message with the owner's agent opens
 * read-only, read through that agent.
 *
 * An ordinary channel never waits on the list of direct messages: until it arrives, when it
 * can't be read, and in a space without direct messages, the room renders as it always has. A
 * room the list names as someone's direct message with the owner's agent is never opened with the
 * person's own access; arriving there before the list does, the room is shown for a moment and
 * the space refuses to read it to anyone but its two members (DOR-2955, review of #2999).
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
  const connection = useCommunityConnections().data?.find((item) => item.ref === community);
  const access = communityAccessState(connection?.access);
  const { dm } = useRemoteCommunityDm(
    community,
    roomId,
    access.verified && access.capabilities.read,
    access.fingerprint
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
