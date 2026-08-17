import { useMemo, useState } from 'react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import {
  Button,
  IdentityAvatar,
  IDENTITY_BADGE_WAKE,
  IDENTITY_MARK_GROUP,
  MentionPill,
  identityMarkRing,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { countOwnedAgents, findTeamOwner, teamMemberFace } from '@/layers/entities/team';
import { TeamMemberCard, TeamRosterGrid } from '@/layers/features/team-roster';
import { ProfileSheet, profileStack } from '@/layers/features/profile';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MOCK_TEAM_ROSTER } from '../mock-samples';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

/** The kind chips the FLIP demo drives the grid with — the real page's filter, minus the router. */
type KindFilter = 'all' | 'people' | 'agents';

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'Everyone' },
  { value: 'people', label: 'People' },
  { value: 'agents', label: 'Agents' },
];

/**
 * Roster sizes worth looking at, because the animation is gated on this.
 *
 * The middle one is a plausible large install; the last is deliberately over
 * `ROSTER_LAYOUT_LIMIT`, so the gate closing is something you can watch rather
 * than something you have to take on faith. Read `data-layout-animated` on the
 * grid to see which side of it you are on.
 */
const ROSTER_SIZES: { multiplier: number; label: string }[] = [
  { multiplier: 1, label: 'The fixture (6)' },
  { multiplier: 8, label: 'A big install (48)' },
  { multiplier: 24, label: 'Over the limit (144)' },
];

/**
 * The fixture repeated, with every id made unique.
 *
 * Ids are React keys, and two cards sharing one key is a list React cannot
 * reconcile — which is also what would break the travel, since a card only
 * animates while it stays the same instance. So the ids and the owner
 * references both carry the copy's index.
 */
function scaledRoster(multiplier: number): TeamMember[] {
  if (multiplier === 1) return MOCK_TEAM_ROSTER;
  return Array.from({ length: multiplier }, (_, copy) =>
    MOCK_TEAM_ROSTER.map((member) => ({
      ...member,
      id: `${member.id}--${copy}`,
      ownerId: member.ownerId === null ? null : `${member.ownerId}--${copy}`,
      displayName: `${member.displayName} ${copy + 1}`,
    }))
  ).flat();
}

/**
 * The roster, driven by the two controls that make its cards travel.
 *
 * Wired straight to `TeamRosterGrid` rather than through `TeamPage`: the whole
 * point here is to watch cards move between two arrangements, and a page that
 * owns a query and a transport puts a cache between you and the toggle.
 */
function RosterFlipDemo() {
  const [grouped, setGrouped] = useState(false);
  const [kind, setKind] = useState<KindFilter>('all');
  const [multiplier, setMultiplier] = useState(1);

  const roster = useMemo(() => scaledRoster(multiplier), [multiplier]);
  const members = useMemo(
    () =>
      roster.filter((member) => {
        if (kind === 'people') return member.kind === 'human';
        if (kind === 'agents') return member.kind === 'agent';
        return true;
      }),
    [roster, kind]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {KIND_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={kind === filter.value ? 'default' : 'outline'}
            aria-pressed={kind === filter.value}
            onClick={() => setKind(filter.value)}
          >
            {filter.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={grouped ? 'default' : 'outline'}
          aria-pressed={grouped}
          onClick={() => setGrouped((current) => !current)}
        >
          Group: manager
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {ROSTER_SIZES.map((size) => (
          <Button
            key={size.multiplier}
            size="sm"
            variant={multiplier === size.multiplier ? 'secondary' : 'ghost'}
            aria-pressed={multiplier === size.multiplier}
            onClick={() => setMultiplier(size.multiplier)}
          >
            {size.label}
          </Button>
        ))}
      </div>
      <TeamRosterGrid
        members={members}
        roster={roster}
        grouped={grouped}
        onSelectOwner={() => undefined}
        onOpenProfile={() => undefined}
      />
    </div>
  );
}

/** The profile sheet, openable, so its 300ms entrance can be watched rather than read. */
function DrawerTimingDemo() {
  const [open, setOpen] = useState(false);
  const member = byId('agent-warden');

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        View profile
      </Button>
      <ProfileSheet
        member={member}
        roster={MOCK_TEAM_ROSTER}
        stack={profileStack(member.id)}
        open={open}
        onOpenChange={setOpen}
        onPush={() => undefined}
        onPop={() => undefined}
      />
    </>
  );
}

/** One agent disc at every diameter, with the badge wake armed. */
function BadgeWakeRow() {
  const face = teamMemberFace(byId('agent-warden'));

  return (
    <div className="flex items-end gap-6">
      {(['xs', 'sm', 'md', 'lg'] as const).map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <IdentityAvatar
            size={size}
            kind={face.kind}
            color={face.color}
            emoji={face.emoji}
            fallback={face.fallback}
            className={IDENTITY_BADGE_WAKE}
          />
          <span className="text-muted-foreground text-[0.625rem]">{size}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A disc that answers the control it sits in, keyboard included.
 *
 * Drawn for a person **and** an agent, because the two are not the same demo.
 * `identityMarkRing` carries the badge-wake marker as well as the ring, so an
 * agent's disc in a Mark-tier control both rings itself and wakes its Bot mark
 * off the same hover — spillover that is only inspectable where a badge exists,
 * and a person's disc has none.
 */
function MarkTierLockup({ memberId, label }: { memberId: string; label: string }) {
  const face = teamMemberFace(byId(memberId));

  return (
    <button
      type="button"
      className={cn(
        IDENTITY_MARK_GROUP,
        'focus-ring hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors'
      )}
    >
      <IdentityAvatar
        size="sm"
        kind={face.kind}
        color={face.color}
        emoji={face.emoji}
        fallback={face.fallback}
        className={identityMarkRing.group}
      />
      <span className="text-sm font-medium">{label}</span>
    </button>
  );
}

/**
 * The identity interaction grammar, and the four moments built on top of it.
 *
 * One section rather than notes scattered across the eleven showcases that draw
 * a face, because the whole claim of this work is that these surfaces answer a
 * pointer the SAME way. That is only reviewable side by side — and the two
 * halves people forget are here too: every hover has a `Tab` twin, and every
 * one of them has to still make sense with system motion turned off.
 */
export function IdentityMotionShowcases() {
  const agent = byId('agent-warden');
  const owner = findTeamOwner(agent, MOCK_TEAM_ROSTER);

  return (
    <PlaygroundSection
      title="Motion & interaction"
      description="How every face answers a pointer — and a keyboard. Three hover tiers by what the thing does, then the four moments that earn more than the baseline. Tab through each demo: anything a hover reveals, focus reveals too. Then turn on Reduce Motion in your OS and come back — cards should stop travelling, the badge should stop tilting, and every state should still read."
    >
      <ShowcaseLabel>
        Surface tier — a card whose whole area is one action lifts, deepens, and firms its border
        into that identity&rsquo;s own colour. Hovering the attribution inside it stands the card
        down, so one pointer never lights two affordances.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="grid gap-3 md:grid-cols-2">
          <TeamMemberCard
            member={agent}
            owner={owner}
            ownedAgentCount={owner ? countOwnedAgents(owner.id, MOCK_TEAM_ROSTER) : undefined}
            onSelectOwner={() => undefined}
            onOpenProfile={() => undefined}
          />
          <TeamMemberCard member={byId('person-miguel')} onOpenProfile={() => undefined} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Mark tier — a disc that is itself a target rings itself in its own colour. The ring answers
        the control&rsquo;s hover and its focus alike, so Tab here learns exactly what a mouse does.
        The agent shows the spillover: the same marker also arms the badge wake, so anywhere on the
        control rings the disc, and landing on the disc itself additionally leans its Bot mark.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-3">
          <MarkTierLockup memberId="person-dorian" label="Dorian" />
          <MarkTierLockup memberId="agent-warden" label="Warden" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Chip tier — an inline control steps its own colour up rather than dimming or brightening it.
        A pill mid-sentence gets the tint step and nothing more: no ring, no glow, no lift.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-2">
          <MentionPill
            kind="agent"
            label="Warden"
            handle="warden"
            color={teamMemberFace(agent).color}
            resolved
            interactive
          />
          <MentionPill kind="human" label="Dorian" handle="dorian" resolved interactive />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Signature 1 — the roster FLIP. Flip Group: manager and watch cards travel from the flat grid
        into their owner&rsquo;s cluster rather than teleporting. Narrow to People or Agents and the
        leavers fade without shoving the survivors. Position only, and off entirely above 120 cards
        or under reduced motion — switch the roster to &ldquo;Over the limit&rdquo; and the travel
        stops.
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <RosterFlipDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Signature 2 — the owner echo. Point at (or Tab to) &ldquo;by @dorian&rdquo; and it says how
        many agents that person has. The suffix sits outside the layout, so it costs the row nothing
        at rest and revealing it never shoves the name out from under the cursor that asked for it.
        Watch the card stand down at the same time: pointing here is a different verb from opening
        the profile, so the lift, the border and the badge all calm.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <div className="grid gap-3 md:grid-cols-2">
          {['agent-warden', 'agent-cartographer'].map((id) => {
            const member = byId(id);
            const memberOwner = findTeamOwner(member, MOCK_TEAM_ROSTER);
            return (
              <TeamMemberCard
                key={id}
                member={member}
                owner={memberOwner}
                ownedAgentCount={
                  memberOwner ? countOwnedAgents(memberOwner.id, MOCK_TEAM_ROSTER) : undefined
                }
                onSelectOwner={() => undefined}
                onOpenProfile={() => undefined}
              />
            );
          })}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Signature 3 — the drawer arrives in 300ms rather than 500. Scoped to this panel: every other
        sheet in the app keeps the primitive&rsquo;s own timing.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <DrawerTimingDemo />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Signature 4 — the badge wake. An agent&rsquo;s Bot mark tilts six degrees and grows a tenth.
        Opt-in per call site, so the twenty-plus discs in the sidebar — which are not targets — stay
        still. What counts as pointing at it depends on what owns the pixels: these bare discs and
        the Mark-tier lockup above answer the disc&rsquo;s own hover, while a Team card answers the
        whole card, because its stretched-link overlay covers the disc and the disc never sees a
        hover at all. Off completely under reduced motion, tilt included: a crooked badge carries no
        fact worth keeping.
      </ShowcaseLabel>
      <ShowcaseDemo>
        <BadgeWakeRow />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
