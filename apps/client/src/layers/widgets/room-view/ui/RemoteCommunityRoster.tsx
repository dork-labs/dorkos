import type { RemoteCommunityMembersResponse } from '@dorkos/shared/community-views';
import { Button } from '@/layers/shared/ui';
import { RemoteCommunityAgents } from './RemoteCommunityAgents';
import { remoteAgentAvailabilityLabel } from '../lib/remote-agent-availability';

/**
 * A space channel's members, each with who owns it when it is an agent, whether that agent is
 * there when the space reports it, and a quick way to mention them, then the person's own agents
 * to bring in.
 */
export function RemoteCommunityRoster({
  roster,
  failed,
  canMention,
  onMention,
  community,
  roomId,
  online,
  canEnroll,
  agentsKey,
  accessFingerprint,
}: {
  roster: RemoteCommunityMembersResponse | undefined;
  failed: boolean;
  canMention: boolean;
  onMention: (handle: string) => void;
  community: string;
  roomId: string;
  online: boolean;
  canEnroll: boolean;
  agentsKey: string;
  accessFingerprint: string;
}) {
  return (
    <div className="max-h-48 overflow-auto border-b p-3" aria-label="Channel members">
      {failed && <p role="alert">Couldn’t load members.</p>}
      {roster?.stale && <p className="text-muted-foreground text-sm">Saved member list</p>}
      {roster?.members.map((member) => {
        const availability = remoteAgentAvailabilityLabel(member);
        return (
          <div key={member.memberId} className="flex items-center justify-between gap-2 text-sm">
            <span>
              {member.displayName}
              {member.kind === 'agent' ? ' · Agent' : ''}
              {member.ownerMemberId &&
                ` · owned by ${roster.members.find((owner) => owner.memberId === member.ownerMemberId)?.displayName ?? 'a space member'}`}
              {availability && (
                <span className="text-muted-foreground">
                  {` · ${availability.text}`}
                  {availability.since && (
                    <>
                      {' '}
                      <time dateTime={availability.since.dateTime}>{availability.since.label}</time>
                    </>
                  )}
                </span>
              )}
            </span>
            {member.handle && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canMention}
                onClick={() => onMention(member.handle!)}
              >
                Mention @{member.handle}
              </Button>
            )}
          </div>
        );
      })}
      {canEnroll && (
        <RemoteCommunityAgents
          key={agentsKey}
          community={community}
          roomId={roomId}
          online={online}
          canEnroll
          accessFingerprint={accessFingerprint}
        />
      )}
    </div>
  );
}
