/**
 * A channel's lead, everywhere it shows (DOR-2823): the panel's Lead control,
 * the bar's quiet "Lead" line, and the roster badge — each with and without a
 * lead, plus #team, whose lead is the default agent and is not chosen here.
 *
 * @module dev/showcases/RoomLeadShowcases
 */
import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomMemberRow } from '@/layers/features/room-management/ui/RoomMemberRow';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ChannelBarFrame } from './OneBarShowcases';
import { CHANNEL_ROOM, LEAD_CHANNEL_ROOM, MEMBER, TEAM_ROOM } from './rooms-showcase-data';
import { RoomPanelDemo } from './rooms-showcase-helpers';

/**
 * A query cache and tooltip layer of the bar's own, so these frames render the
 * same inside the playground and inside the page test, which mounts no shell.
 */
function BarDemo({ children }: { children: ReactNode }) {
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    []
  );
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>{children}</TooltipProvider>
    </QueryClientProvider>
  );
}

/** One member row, leading or not, with the props this page never varies. */
function LeadRowDemo({ member, isLead }: { member: RoomRosterEntry; isLead: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="bg-card max-w-md rounded-lg border p-4">
      <RoomMemberRow
        member={member}
        roomKind="channel"
        isReader={false}
        isLead={isLead}
        visual={{ color: '#b48c3c', emoji: '💼' }}
        presence={null}
        lastSpokeAt={null}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onRungChange={() => {}}
        onRungPreview={() => {}}
        savingRung={false}
        rungError={null}
        roomTitle="#general"
        onRemoveRequested={() => {}}
        confirmingRemoval={false}
        onConfirmRemoval={() => {}}
        onCancelRemoval={() => {}}
        engagedWindow={null}
        dormantReasonId={null}
      />
    </div>
  );
}

/** The lead's three surfaces, each in the states it has. */
export function RoomLeadShowcases() {
  return (
    <PlaygroundSection
      title="Channel Lead"
      description="The agent that answers a person when nobody else is answering. Chosen in the room panel, named quietly in the bar, badged in the roster. #team's lead is the default agent, so its panel names it without offering a choice. The panels are live fixtures: pick a lead and it sticks."
    >
      <ShowcaseLabel>Room panel — a channel with a lead, one without, and #team</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-3">
          <RoomPanelDemo
            label="#general — led by Mio Clicker PM"
            read={LEAD_CHANNEL_ROOM}
            holds={LEAD_CHANNEL_ROOM}
          />
          <RoomPanelDemo label="#general — no lead" read={CHANNEL_ROOM} holds={CHANNEL_ROOM} />
          <RoomPanelDemo label="#team — read-only lead" read={TEAM_ROOM} holds={TEAM_ROOM} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Bar — the lead beside the head count, and nothing when there is none
      </ShowcaseLabel>
      <ShowcaseDemo>
        <BarDemo>
          <div className="space-y-3">
            <ChannelBarFrame room={LEAD_CHANNEL_ROOM} />
            <ChannelBarFrame room={CHANNEL_ROOM} />
          </div>
        </BarDemo>
      </ShowcaseDemo>

      <ShowcaseLabel>Roster row — the lead, and the same agent not leading</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-3">
          <LeadRowDemo member={MEMBER.pm} isLead />
          <LeadRowDemo member={MEMBER.pm} isLead={false} />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
