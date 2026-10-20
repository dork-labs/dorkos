import { ArrowUpRight } from 'lucide-react';
import type { CommunitySettingsSection } from '@dorkos/shared/community-wire';
import { Button, buttonVariants, ExternalLinkAnchor } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { SpaceRole } from '../lib/space-view';
import { SettingsRow, SettingsSection } from './SettingsBlocks';

/** Red text on a faint red tint, no outline: the house look for a destructive way out. */
const DESTRUCTIVE = 'text-destructive bg-destructive/10 hover:bg-destructive/15';

/** Props for {@link SpaceDangerSection}. */
export interface SpaceDangerSectionProps {
  /** The person's role. */
  role: SpaceRole;
  /** The web settings page, at one section. */
  webSettingsUrl: (section?: CommunitySettingsSection) => string;
  /** Whether the space is unreachable now, so its web page is too. */
  offline: boolean;
}

/**
 * Leave, and for the owner hand over, archive or delete (DOR-3005). Each still happens on the
 * space's own web settings page, which checks the person's sign-in and password there: every row
 * here is the way to it. The owner cannot leave, since a space always has one.
 */
export function SpaceDangerSection({ role, webSettingsUrl, offline }: SpaceDangerSectionProps) {
  const owner = role === 'owner';
  const continueTo = (section: CommunitySettingsSection, destructive: boolean) =>
    offline ? (
      <Button variant="secondary" size="sm" disabled>
        Continue in web settings
        <ArrowUpRight aria-hidden />
      </Button>
    ) : (
      <ExternalLinkAnchor
        href={webSettingsUrl(section)}
        className={cn(
          buttonVariants({ variant: destructive ? 'ghost' : 'secondary', size: 'sm' }),
          destructive && DESTRUCTIVE
        )}
      >
        Continue in web settings
        <ArrowUpRight aria-hidden />
      </ExternalLinkAnchor>
    );
  return (
    <SettingsSection
      title={owner ? 'Leave, archive or delete' : 'Leave'}
      testId="space-settings-danger"
    >
      <SettingsRow
        label="Leave space"
        description={owner ? undefined : 'Your agents leave with you. Someone can invite you back.'}
        reason={owner ? 'Make someone else an owner first.' : null}
      >
        {owner ? undefined : continueTo('account', true)}
      </SettingsRow>
      {owner && (
        <>
          <SettingsRow label="Transfer ownership" description="Hand the space to someone here.">
            {continueTo('community', false)}
          </SettingsRow>
          <SettingsRow
            label="Archive"
            description="Closes the space for everyone. You can restore it any time."
          >
            {continueTo('community', true)}
          </SettingsRow>
          <SettingsRow
            label="Delete space"
            description="Deletes channels, messages and files for everyone after 7 days."
          >
            {continueTo('community', true)}
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  );
}
