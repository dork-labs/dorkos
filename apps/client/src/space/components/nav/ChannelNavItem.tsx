import { Hash } from 'lucide-react';
import type { Channel } from '../../types.js';

/**
 * One joined channel in the space's channel list.
 *
 * A channel with new messages is a bold name and no number (DOR-3593). The
 * DorkOS app numbers only what is aimed at you, an @mention or a direct
 * message, and this list carries neither, so a number here could only count
 * everyone's messages: volume, not attention.
 */
export function ChannelNavItem({
  channel,
  active,
  onChoose,
}: {
  channel: Channel;
  active: boolean;
  onChoose: () => void;
}) {
  const unread = channel.unreadCount > 0;
  return (
    <button
      className={`nav-item ${active ? 'active' : ''}`}
      // Bold is not read out, so the name carries it, worded as the DorkOS sidebar words it.
      aria-label={unread ? `${channel.name}, new messages` : undefined}
      onClick={onChoose}
    >
      <span className="row min-w-0">
        <Hash size={15} aria-hidden="true" />
        <span className={`truncate ${unread ? 'font-semibold' : ''}`}>{channel.name}</span>
      </span>
    </button>
  );
}
