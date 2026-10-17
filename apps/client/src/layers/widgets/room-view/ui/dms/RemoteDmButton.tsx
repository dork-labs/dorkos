import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AGENT_NOT_TAKING_DMS } from '@dorkos/shared/community-dm-views';
import { communityKeys, useCommunityContentAuthority } from '@/layers/entities/community';
import { appRoutes } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/**
 * "Message" on an agent's roster row in a space that holds direct messages (DOR-2955): opens
 * the person's direct message with that agent, starting it the first time. When the agent's
 * owner has them off, it says so beside the button.
 */
export function RemoteDmButton({
  community,
  agent,
  disabled,
  accessFingerprint,
}: {
  community: string;
  accessFingerprint: string;
  agent: { memberId: string; displayName: string };
  disabled: boolean;
}) {
  const transport = useTransport();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(true, accessFingerprint, community);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  async function open() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const dm = await transport.startRemoteCommunityDm(community, agent.memberId);
      if (authority)
        await queries.invalidateQueries({ queryKey: communityKeys.dms(authority, community) });
      void navigate({ ...appRoutes.channels(), search: { community, id: dm.roomId } });
    } catch (cause) {
      setNotice(
        (cause as { code?: string }).code === AGENT_NOT_TAKING_DMS
          ? `${agent.displayName} isn’t taking direct messages.`
          : 'Couldn’t open the direct message. Try again.'
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2">
      {notice && (
        // Its own line on a narrow screen, beside the button on a wide one.
        <span
          role="status"
          className="text-muted-foreground order-last w-full text-right text-xs sm:order-none sm:w-auto"
        >
          {notice}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || pending}
        onClick={() => void open()}
        aria-label={`Message ${agent.displayName}`}
      >
        Message
      </Button>
    </span>
  );
}
