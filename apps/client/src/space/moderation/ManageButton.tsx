import { Settings2 } from 'lucide-react';
import { Button } from '@dork-labs/ui';
import type { Member } from '../types.js';
import { OpenReportBadge, openReportLabel, useOpenReportCount } from './OpenReportBadge.js';

/**
 * The header's way into a space's settings. For an owner or admin it also shows how many messages
 * are flagged and waiting, since nothing else tells them.
 */
export function ManageButton({
  memberRole,
  onOpen,
}: {
  memberRole: Member['role'];
  onOpen: () => void;
}) {
  const count = useOpenReportCount(memberRole === 'owner' || memberRole === 'admin');
  return (
    <Button
      variant="outline"
      aria-label={count > 0 ? `Manage, ${openReportLabel(count)} flagged` : 'Manage'}
      onClick={onOpen}
    >
      <Settings2 size={16} />
      <span className="hidden sm:inline">Manage</span>
      <OpenReportBadge count={count} />
    </Button>
  );
}
