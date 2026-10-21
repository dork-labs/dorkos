import { ArrowUpRight, WifiOff } from 'lucide-react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  communitySettingsPath,
  type CommunitySettingsSection,
} from '@dorkos/shared/community-wire';
import { useCommunitySpaceSettings } from '@/layers/entities/community';
import { Banner, Button, ExternalLinkAnchor } from '@/layers/shared/ui';
import {
  admissionLabel,
  initialOf,
  roleClause,
  sinceLabel,
  tileColor,
  type SpaceRole,
} from '../lib/space-view';
import {
  LetterTile,
  LockedReason,
  ManageOnWeb,
  SettingsRow,
  SettingsSection,
} from './SettingsBlocks';
import { SpaceMembersSection } from './SpaceMembersSection';
import { SpaceDangerSection } from './SpaceDangerSection';

/** Props for {@link SpaceSettingsPanel}. */
export interface SpaceSettingsPanelProps {
  /** The connected space. */
  connection: CommunityConnectionDescriptor;
}

/**
 * A connected space's Settings tab (DOR-3005): one 680px column of General, Members, Rules and
 * the ways to leave, archive or delete, read through the app's own pairing with the space.
 *
 * Read-only in this version. Every value is plain text, never a disabled input. An owner or
 * admin gets one link per section to the space's web settings, where they change it; a member
 * gets one line saying who can. Leaving, handing over, archiving and deleting continue on the space's web settings.
 *
 * When the space cannot be reached, it shows what the space said last and how long ago, with one
 * amber line and Try again; no row adds a reason of its own then.
 */
export function SpaceSettingsPanel({ connection }: SpaceSettingsPanelProps) {
  const reads = useCommunitySpaceSettings(connection.ref);
  const settings = reads.settings.data?.value;
  const role: SpaceRole = reads.me.data?.value.member.role ?? 'member';
  const meId = reads.me.data?.value.member.memberId ?? null;
  const offlineSince = [reads.settings, reads.me, reads.members, reads.rules]
    .map((query) => query.data)
    .find((data) => data?.offline)?.fetchedAt;
  const offline = offlineSince !== undefined;
  const host = new URL(connection.pinnedOrigin).host;
  const webSettingsUrl = (section?: CommunitySettingsSection) =>
    new URL(
      communitySettingsPath(connection.remoteCommunityId, section),
      connection.pinnedOrigin
    ).toString();
  const owner = role === 'owner';
  const moderator = owner || role === 'admin';
  // Once per section when it applies to every row, as the design asks; none while offline.
  // An owner or admin changes these in the space's web settings until the app can pair to manage.
  const generalReason = offline ? null : moderator ? (
    <ManageOnWeb href={webSettingsUrl('community')} />
  ) : (
    'Owners and admins change these.'
  );
  const name = settings?.name ?? connection.label;

  // The role decides every reason on the page, so nothing role-shaped is drawn before it is known.
  if (!reads.me.data && reads.me.isPending)
    return (
      <SettingsColumn>
        <p className="text-muted-foreground py-10 text-sm" aria-busy>
          Loading settings…
        </p>
      </SettingsColumn>
    );

  if (reads.settings.error && !settings)
    return (
      <SettingsColumn>
        <div className="flex flex-col items-start gap-3 py-10">
          <p className="text-sm">{reads.settings.error.message}</p>
          <Button variant="secondary" size="sm" onClick={reads.refetch}>
            Try again
          </Button>
        </div>
      </SettingsColumn>
    );

  return (
    <SettingsColumn>
      <header className="flex items-center gap-4">
        <LetterTile letter={initialOf(name)} color={tileColor(connection.ref)} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <span className="min-w-0 truncate" dir="auto">
              {name}
            </span>
            {offline && (
              <span className="bg-status-warning-bg text-status-warning-fg inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium">
                <WifiOff aria-hidden className="size-3" />
                Offline
              </span>
            )}
          </h2>
          <p className="text-muted-foreground truncate text-sm">
            Team space · Hosted on {host}
            {reads.me.data && ` · ${roleClause(role)}`}
          </p>
        </div>
      </header>

      {offline && (
        <Banner
          variant="warning"
          icon={WifiOff}
          actions={
            <Button
              variant="secondary"
              size="xs"
              onClick={reads.refetch}
              disabled={reads.refetching}
            >
              Try again
            </Button>
          }
        >
          Can’t reach {host}. These are the settings from {sinceLabel(offlineSince)}.
        </Banner>
      )}

      <SettingsSection title="General" reason={generalReason} testId="space-settings-general">
        <SettingsRow label="Icon">
          <LetterTile letter={initialOf(name)} color={tileColor(connection.ref)} />
        </SettingsRow>
        <SettingsRow label="Name">
          <span dir="auto" className="break-words">
            {name}
          </span>
        </SettingsRow>
        <SettingsRow label="Description" stacked>
          {settings?.description ? (
            <p dir="auto" className="break-words whitespace-pre-wrap">
              {settings.description}
            </p>
          ) : (
            <p className="text-muted-foreground">No description</p>
          )}
        </SettingsRow>
        <SettingsRow label="Who can join">
          {settings ? admissionLabel(settings.admissionPolicy) : '…'}
        </SettingsRow>
      </SettingsSection>

      <SpaceMembersSection
        members={reads.members.data}
        refusal={reads.members.error && !reads.members.data ? reads.members.error.message : null}
        role={role}
        meId={meId}
        offline={offline}
        manageUrl={webSettingsUrl('members')}
      />

      <SettingsSection title="Rules" testId="space-settings-rules">
        <div className="flex flex-col gap-3 px-4 py-3">
          {reads.rules.data?.value.text ? (
            <p dir="auto" className="text-sm break-words whitespace-pre-wrap">
              {reads.rules.data.value.text}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              {reads.rules.error && !reads.rules.data ? reads.rules.error.message : 'No rules yet.'}
            </p>
          )}
          {reads.rules.data && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted-foreground text-xs">
                {reads.rules.data.value.acceptedVersion === reads.rules.data.value.version
                  ? `You agreed to version ${reads.rules.data.value.version}.`
                  : `Version ${reads.rules.data.value.version}`}
              </span>
              {!offline &&
                (moderator ? (
                  <ManageOnWeb href={webSettingsUrl('community')} />
                ) : (
                  <LockedReason>Owners and admins change the rules.</LockedReason>
                ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SpaceDangerSection role={role} webSettingsUrl={webSettingsUrl} offline={offline} />

      <p className="text-muted-foreground px-1 text-sm">
        Also on the web:{' '}
        <ExternalLinkAnchor
          href={webSettingsUrl()}
          className="text-foreground inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
        >
          {host}
          {communitySettingsPath(connection.remoteCommunityId)}
          <ArrowUpRight aria-hidden className="size-3.5" />
        </ExternalLinkAnchor>
      </p>
    </SettingsColumn>
  );
}

/** The tab's one column: 680px wide, centered, scrolling with the page. */
export function SettingsColumn({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto" data-testid="space-settings">
      <div className="mx-auto flex w-full max-w-[680px] flex-col gap-8 px-4 py-8">{children}</div>
    </div>
  );
}
