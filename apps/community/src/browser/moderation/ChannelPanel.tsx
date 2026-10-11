import { Button } from '@dork-labs/ui';
import { request } from '../api.js';
import type { Channel, Member } from '../types.js';
import type { Perform } from '../components/members/SpaceMembers.js';
import { SlowModeControl } from './SlowModeControl.js';

/**
 * One channel's settings: its visibility and state, and for owners and admins renaming,
 * archiving and slow mode; for anyone but the owner, leaving it.
 */
export function ChannelPanel({
  channel,
  communityName,
  me,
  busy,
  perform,
}: {
  channel: Channel;
  communityName: string;
  me: Member;
  busy: boolean;
  perform: Perform;
}) {
  const moderator = me.role === 'owner' || me.role === 'admin';
  return (
    <section className="panel">
      <h3>#{channel.name}</h3>
      <p className="small muted">
        {channel.visibility} · {channel.archived ? 'Archived' : 'Active'}
      </p>
      {moderator && (
        <>
          <div className="row">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                const name = window.prompt('Channel name', channel.name);
                if (name)
                  void perform(
                    () =>
                      request(`/api/v1/channels/${channel.id}`, 'PATCH', {
                        name,
                      }),
                    'Channel renamed.'
                  );
              }}
            >
              Rename
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void perform(
                  () =>
                    request(`/api/v1/channels/${channel.id}`, 'PATCH', {
                      archived: !channel.archived,
                    }),
                  channel.archived ? 'Channel reopened.' : 'Channel archived.'
                )
              }
            >
              {channel.archived ? 'Reopen' : 'Archive'}
            </Button>
          </div>
          <SlowModeControl channelId={channel.id} busy={busy} perform={perform} />
        </>
      )}
      {channel.joined && me.role !== 'owner' && (
        <Button
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() =>
            void perform(
              () => request(`/api/v1/channels/${channel.id}/leave`, 'POST', {}),
              `You left #${channel.name}. You are still a member of ${communityName}.`
            )
          }
        >
          Leave channel
        </Button>
      )}
    </section>
  );
}
