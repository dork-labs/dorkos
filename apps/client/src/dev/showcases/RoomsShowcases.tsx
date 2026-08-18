/**
 * Everything a room is made of, every way it can look.
 *
 * Twelve of these states used to need a live server with the right data in it,
 * which meant they shipped unreviewed. A state you cannot reach in a playground
 * is a state nobody looks at twice.
 *
 * **The sub-components are imported by path rather than through the slice's
 * barrel**, which is what the marketplace and settings showcases do for the
 * same reason: a member row takes eighteen props and means nothing outside the
 * sheet that owns them, so putting it on `features/room-management`'s public
 * API would advertise a component no other feature may render. The playground
 * is allowed to look inside; a sibling feature is not.
 *
 * @module dev/showcases/RoomsShowcases
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import {
  BridgeVisibilityBadge,
  LoudnessMeter,
  ResponseModeControl,
  RoomAvatar,
  RoomLoudnessLine,
  type EngagedWindow,
  type LoudnessLevel,
  type LoudnessPreview,
  type ResponseRung,
  type RoomPresenceAuthor,
} from '@/layers/entities/room';
import { AgentRosterPicker } from '@/layers/features/room-management';
import { RemoveMemberConfirm } from '@/layers/features/room-management/ui/RemoveMemberConfirm';
import { RoomMemberRow } from '@/layers/features/room-management/ui/RoomMemberRow';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { createAgentRoster, createRoomMember, minutesBeforeNow } from '../mock-factories';
import {
  ARCHIVED_ROOM,
  BRIDGED_CHANNEL_ROOM,
  CHANNEL_ROOM,
  DM_ROOM,
  EMPTY_ROOM,
  MEMBER,
  ROOM_CANDIDATES,
} from './rooms-showcase-data';
import { RoomSheetDemo } from './rooms-showcase-helpers';

/** The engaged window this page describes the `Engaged` rung with. */
const WINDOW: EngagedWindow = { engagedWindowMinutes: 10, engagedWindowPosts: 5 };

/** A wash of surface behind a demo that would otherwise sit on the dashed inset. */
function Panel({ children }: { children: React.ReactNode }) {
  return <div className="bg-card max-w-md space-y-1 rounded-lg border p-4">{children}</div>;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/**
 * The whole sheet, in each of the seven states it has.
 *
 * Every one runs the real component against a fixture behind the `Transport`
 * port — see `rooms-showcase-helpers`. The fixture accepts writes, so these are
 * not stills: change a rung and it sticks, take an agent out and the row leaves
 * with its own animation and offers the undo.
 */
function RoomSheetShowcase() {
  return (
    <PlaygroundSection
      title="Room Sheet"
      description="One surface for everything about one room. Each button opens the real sheet against its own in-memory room — reads, writes and all — so a rung you change sticks and a removal really offers its undo. Nobody is working in these rooms: the signal rides a room's live stream, which only the room on screen has open."
    >
      <ShowcaseLabel>Reading the room, and a read that failed</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-3">
          <RoomSheetDemo label="Loading" read="loading" holds={CHANNEL_ROOM} />
          <RoomSheetDemo label="Roster failed" read="error" holds={CHANNEL_ROOM} />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>A channel with several agents in it</ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo label="#general — four members" read={CHANNEL_ROOM} holds={CHANNEL_ROOM} />
      </ShowcaseDemo>

      <ShowcaseLabel>An empty room — the picker opens itself</ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo label="#design — nobody in it" read={EMPTY_ROOM} holds={EMPTY_ROOM} />
      </ShowcaseDemo>

      <ShowcaseLabel>A one-to-one, and what a second agent would do</ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo label="Direct message" read={DM_ROOM} holds={DM_ROOM} />
      </ShowcaseDemo>

      <ShowcaseLabel>Archived — the banner, the dormant meters, the way back</ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo label="#old-thing — archived" read={ARCHIVED_ROOM} holds={ARCHIVED_ROOM} />
      </ShowcaseDemo>

      <ShowcaseLabel>A fleet with nobody in it, and the route out of it</ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo
          label="No agents yet"
          read={EMPTY_ROOM}
          holds={EMPTY_ROOM}
          fleet={[]}
          focus="add"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        A bridged Telegram channel — Miguel&apos;s origin mark, and Telegram&apos;s own name for the
        chat, drifted from the room&apos;s (chats-as-channels §3.4, §4.3, DOR-879)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <RoomSheetDemo
          label="#ops-team — bridged"
          read={BRIDGED_CHANNEL_ROOM}
          holds={BRIDGED_CHANNEL_ROOM}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The member row
// ---------------------------------------------------------------------------

/** Everything a row needs that this page never varies. */
const ROW_DEFAULTS = {
  roomKind: 'channel' as RoomKind,
  isReader: false,
  visual: null,
  presence: null,
  lastSpokeAt: null,
  savingRung: false,
  rungError: null,
  roomTitle: '#general',
  engagedWindow: WINDOW,
  dormantReasonId: null,
};

interface MemberRowDemoProps {
  member: RoomRosterEntry;
  isReader?: boolean;
  visual?: { color: string; emoji: string } | null;
  presence?: RoomPresenceAuthor | null;
  lastSpokeAt?: string | null;
  savingRung?: boolean;
  rungError?: string | null;
}

/**
 * One row with its own open/closed state, so the loudness pill really opens the
 * scale under it rather than being a picture of a pill.
 */
function MemberRowDemo({ member, ...props }: MemberRowDemoProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <Panel>
      <RoomMemberRow
        {...ROW_DEFAULTS}
        {...props}
        member={member}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onRungChange={() => {}}
        onRungPreview={() => {}}
        onRemoveRequested={() => setConfirming(true)}
        confirmingRemoval={confirming}
        onConfirmRemoval={() => setConfirming(false)}
        onCancelRemoval={() => setConfirming(false)}
      />
    </Panel>
  );
}

/** A live claim, as the room's stream would report one three minutes in. */
const WORKING: RoomPresenceAuthor = {
  authorId: MEMBER.pm.authorId,
  entryId: 'entry-brief',
  state: 'working',
  since: minutesBeforeNow(3),
  elapsedMs: 3 * 60_000,
};

/**
 * The member row in each of the six states one can be in.
 *
 * Exported because the Identity page renders it too — it is a room surface
 * first, so its entry stays registered to Rooms and the anchor with it (spec
 * `identity-consistency` §W4.2).
 */
export function RoomMemberRowShowcase() {
  return (
    <PlaygroundSection
      title="RoomMemberRow"
      description="A member as a line: face, name, what it has done here, how loud it is. Press a pill to open its scale. A person's row has no pill at all — the empty slot says nobody triggers them louder than a label could."
    >
      <ShowcaseLabel>Idle — the fact it always has is when it joined</ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo
          member={MEMBER.pm}
          visual={{ color: '#b48c3c', emoji: '💼' }}
          lastSpokeAt={minutesBeforeNow(140)}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Working — the dot, its ping, and the line that says so</ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo
          member={MEMBER.pm}
          visual={{ color: '#b48c3c', emoji: '💼' }}
          presence={WORKING}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        An agent the fleet could not name — a letter on the colour the rest of the room hashes it
      </ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo member={MEMBER.unresolved} />
      </ShowcaseDemo>

      <ShowcaseLabel>The person reading — no glyph, no pill, no menu</ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo member={MEMBER.reader} isReader />
      </ShowcaseDemo>

      <ShowcaseLabel>A rung being written — dimmed, and still pressable</ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo member={MEMBER.code} visual={{ color: '#3ca078', emoji: '🔔' }} savingRung />
      </ShowcaseDemo>

      <ShowcaseLabel>A rung that did not save — rolled back, with the reason</ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo
          member={MEMBER.code}
          visual={{ color: '#3ca078', emoji: '🔔' }}
          rungError="Only you can change who is in a room"
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Bridged in from Telegram — the origin mark (chats-as-channels §4.3, §9, DOR-879)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <MemberRowDemo member={MEMBER.miguel} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The room's own mark
// ---------------------------------------------------------------------------

/** One agent's face, as the fleet resolves it for a room this agent is in. */
const MIO: AgentVisual = { color: '#b48c3c', emoji: '💼' };

/** One mark with a caption underneath, at whatever size it was given. */
function MarkDemo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex w-28 flex-col items-center gap-2 text-center">
      <div className="flex h-12 items-center">{children}</div>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}

/**
 * Every face a room can wear, and the three sizes it wears them at.
 *
 * Exported for the Identity page, which renders it beside the other faces;
 * the entry stays registered to Rooms (spec `identity-consistency` §W4.2).
 */
export function RoomAvatarShowcase() {
  const MIO_DM = { id: 'room-dm-mio', kind: 'dm', title: 'Mio Clicker PM' } as const;
  return (
    <PlaygroundSection
      title="RoomAvatar"
      description="What a room looks like before you read its name. A place gets a #; a one-to-one gets the agent it is with — the same filled square with the bot mark that agent wears everywhere else, rather than the round person disc it used to draw. A group stacks up to three faces. A conversation nobody could resolve a face for falls back to a letter, and keeps the agent shape as long as it still knows who the room is with."
    >
      <ShowcaseLabel>The four faces, at the sidebar&apos;s size</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-start gap-6">
          <MarkDemo label="A channel">
            <RoomAvatar room={{ id: 'room-general', kind: 'channel', title: 'General' }} />
          </MarkDemo>
          <MarkDemo label="A one-to-one">
            <RoomAvatar room={MIO_DM} visuals={[MIO]} />
          </MarkDemo>
          <MarkDemo label="A group of three">
            <RoomAvatar
              room={{ id: 'room-dm-group', kind: 'dm', title: 'Mio, Kai and code' }}
              visuals={[MIO, { color: '#c85a6e', emoji: '🛰' }, { color: '#3ca078', emoji: '🔔' }]}
            />
          </MarkDemo>
          <MarkDemo label="No face to draw">
            <RoomAvatar
              room={{ id: 'room-dm-ravi', kind: 'dm', title: 'ravi-bot' }}
              participants={[MEMBER.unresolved.author]}
            />
          </MarkDemo>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>The same one-to-one at each size — the masthead draws it larger</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-start gap-6">
          <MarkDemo label="xs — the sidebar">
            <RoomAvatar room={MIO_DM} visuals={[MIO]} />
          </MarkDemo>
          <MarkDemo label="sm">
            <RoomAvatar room={MIO_DM} visuals={[MIO]} size="sm" />
          </MarkDemo>
          <MarkDemo label="md">
            <RoomAvatar room={MIO_DM} visuals={[MIO]} size="md" />
          </MarkDemo>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The scale
// ---------------------------------------------------------------------------

/** The rung control, with its own value so the arrows and the preview work. */
function ResponseModeDemo({
  roomKind,
  initial,
  disabledReasonId,
}: {
  roomKind: RoomKind;
  initial: ResponseRung;
  disabledReasonId?: string;
}) {
  const [rung, setRung] = useState<ResponseRung>(initial);
  return (
    <Panel>
      <ResponseModeControl
        memberName="Mio Clicker PM"
        roomKind={roomKind}
        value={rung}
        onChange={setRung}
        engagedWindow={WINDOW}
        disabledReasonId={disabledReasonId ?? null}
      />
    </Panel>
  );
}

/** Every rung, in both room kinds, plus the two states a rung can be in. */
function ResponseModeControlShowcase() {
  return (
    <PlaygroundSection
      title="ResponseModeControl"
      description="Quiet to loud, left to right, with the pointed-at rung's consequence written underneath. Arrow keys move, Enter and Space commit. Below 768px it becomes a vertical list with all four consequences printed at once — narrow the browser window itself to see it: the viewport toggle above only clips the demo, and this control reads the real media query."
    >
      <ShowcaseLabel>A channel — four rungs</ShowcaseLabel>
      <ShowcaseDemo>
        <ResponseModeDemo roomKind="channel" initial="engaged" />
      </ShowcaseDemo>

      <ShowcaseLabel>A direct message — the same four, reading differently</ShowcaseLabel>
      <ShowcaseDemo>
        {/* Same scale, and only the loudest rung's sentence changes: "every
            message you send here" rather than "every message in this room".
            This offered three for one commit, with `Engaged` missing. */}
        <ResponseModeDemo roomKind="dm" initial="everything" />
      </ShowcaseDemo>

      <ShowcaseLabel>The rung a direct message could not reach</ShowcaseLabel>
      <ShowcaseDemo>
        <ResponseModeDemo roomKind="dm" initial="engaged" />
      </ShowcaseDemo>

      <ShowcaseLabel>Archived — dormant, and still reachable by keyboard</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-md space-y-2">
          <p
            id="rooms-dormant-reason"
            className="bg-muted/50 text-muted-foreground rounded-lg px-3 py-2.5 text-xs"
          >
            Nobody is triggered in an archived room, so its members and their settings are on hold.
            Bring it back to change them.
          </p>
          <ResponseModeDemo
            roomKind="channel"
            initial="engaged"
            disabledReasonId="rooms-dormant-reason"
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

/** What each level stands for, so the row of meters reads as a scale. */
const LEVEL_CAPTIONS: Record<LoudnessLevel, string> = {
  0: 'nobody in it',
  1: 'Silent',
  2: '@only',
  3: 'Engaged',
  4: 'Everything',
};

const LEVELS: LoudnessLevel[] = [0, 1, 2, 3, 4];

/** Every level at every size, live and dormant. */
function LoudnessMeterShowcase() {
  return (
    <PlaygroundSection
      title="LoudnessMeter"
      description="Four ascending bars, lit up to a level. The point is the position: a rung's place on a rising row says louder-than and quieter-than without a word. Zero lit is its own answer — no agent in the room at all — and not the quiet end of the scale. Decoration only; it contributes nothing to the accessibility tree, because every place it is drawn has the words beside it."
    >
      <ShowcaseLabel>Both sizes, every level</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-6">
          {LEVELS.map((level) => (
            <div key={level} className="flex flex-col items-center gap-2">
              <div className="flex h-5 items-end gap-3">
                <LoudnessMeter level={level} size="pill" />
                <LoudnessMeter level={level} size="room" />
              </div>
              <span className="text-muted-foreground text-[10px]">{LEVEL_CAPTIONS[level]}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Dormant — the setting is real, it is just not in effect</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap gap-6">
          {LEVELS.map((level) => (
            <div key={level} className="flex flex-col items-center gap-2">
              <div className="flex h-5 items-end gap-3">
                <LoudnessMeter level={level} size="pill" dormant />
                <LoudnessMeter level={level} size="room" dormant />
              </div>
              <span className="text-muted-foreground text-[10px]">{LEVEL_CAPTIONS[level]}</span>
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The room line
// ---------------------------------------------------------------------------

/** A roster built out of nothing but rungs, for one sentence shape. */
function roster(...modes: RoomRosterEntry['responseMode'][]): RoomRosterEntry[] {
  const cast = [MEMBER.pm, MEMBER.code, MEMBER.kai, MEMBER.unresolved];
  return modes.map((responseMode, index) => ({
    ...(cast[index] ?? createRoomMember()),
    responseMode,
  }));
}

/** One line, with the caption saying which shape it is. */
function LoudnessLine({
  members,
  roomKind = 'channel',
  preview = null,
}: {
  members: RoomRosterEntry[];
  roomKind?: RoomKind;
  preview?: LoudnessPreview | null;
}) {
  return (
    <div className="max-w-md">
      <RoomLoudnessLine members={members} roomKind={roomKind} preview={preview} />
    </div>
  );
}

/** Every sentence the room line can say, and the hypothetical it says them as. */
function RoomLoudnessLineShowcase() {
  return (
    <PlaygroundSection
      title="RoomLoudnessLine"
      description="What a whole room will do, in one line — the two questions people open this sheet with are 'this is too loud' and 'nobody answered me', and both are about the room rather than about one agent. The reading is the loudest agent present; the second line names the one exception, and only when there is exactly one."
    >
      <ShowcaseLabel>Nobody in it</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={[]} />
      </ShowcaseDemo>

      <ShowcaseLabel>Everyone silent</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('silent', 'silent')} />
      </ShowcaseDemo>

      <ShowcaseLabel>@mentions only, with one quieter exception named</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('mention-only', 'silent')} />
      </ShowcaseDemo>

      <ShowcaseLabel>Two will answer, and the one that will not</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('engaged', 'always', 'mention-only')} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Two exceptions, so neither is named — a list is what this replaces
      </ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('engaged', 'mention-only', 'silent')} />
      </ShowcaseDemo>

      <ShowcaseLabel>Every answer is every message</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('always', 'always')} />
      </ShowcaseDemo>

      <ShowcaseLabel>One agent, so the verb agrees with it</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine members={roster('always')} />
      </ShowcaseDemo>

      <ShowcaseLabel>Previewing — brand tint, and the words say it is a hypothetical</ShowcaseLabel>
      <ShowcaseDemo>
        <LoudnessLine
          members={roster('mention-only', 'silent')}
          preview={{ authorId: MEMBER.pm.authorId, rung: 'everything' }}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

/** Shared by every picker demo — only the roster differs. */
function Picker({
  candidates,
  isLoading = false,
  isError = false,
  emptyRosterMessage,
  emptyRosterAction,
  isSubmitting = false,
}: {
  candidates?: typeof ROOM_CANDIDATES;
  isLoading?: boolean;
  isError?: boolean;
  emptyRosterMessage?: string;
  emptyRosterAction?: React.ReactNode;
  isSubmitting?: boolean;
}) {
  return (
    <Panel>
      <AgentRosterPicker
        roster={createAgentRoster({
          candidates: candidates ?? ROOM_CANDIDATES,
          isLoading,
          isError,
        })}
        onSubmit={() => {}}
        submitLabel={(count) => (count > 1 ? `Add ${count} agents` : 'Add agent')}
        emptyRosterMessage={emptyRosterMessage ?? 'You have not added any agents yet.'}
        emptyRosterAction={emptyRosterAction}
        allChosenMessage="Every agent you have is already in here."
        isSubmitting={isSubmitting}
      />
    </Panel>
  );
}

/** The picker in each state, including the two a bare candidate list cannot say. */
function AgentRosterPickerShowcase() {
  return (
    <PlaygroundSection
      title="AgentRosterPicker"
      description="The combobox that holds the chips: type to filter, ↓↑ to aim, Enter to add, Backspace to take the last one back, Enter on an empty field to commit. 'You have no agents' and 'we could not find out' are different sentences and only one of them is ever true, which is why loading and failure are carried apart from an empty list."
    >
      <ShowcaseLabel>
        The fleet, with faces and the line each agent wrote about itself
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Picker />
      </ShowcaseDemo>

      <ShowcaseLabel>Still reading it — the shape of the field, not a spinner</ShowcaseLabel>
      <ShowcaseDemo>
        <Picker isLoading />
      </ShowcaseDemo>

      <ShowcaseLabel>Could not read it — and the button that would fix that</ShowcaseLabel>
      <ShowcaseDemo>
        <Picker isError />
      </ShowcaseDemo>

      <ShowcaseLabel>A fleet with nobody in it — the one emptiness you can act on</ShowcaseLabel>
      <ShowcaseDemo>
        <Picker
          candidates={[]}
          emptyRosterAction={
            <Button type="button" size="sm" variant="outline">
              Create agent
            </Button>
          }
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Everyone is already in here — a finished job, so nothing to press
      </ShowcaseLabel>
      <ShowcaseDemo>
        <Picker candidates={[]} emptyRosterMessage="Every agent you have is already in here." />
      </ShowcaseDemo>

      <ShowcaseLabel>A write in flight — the commit waits, the field does not</ShowcaseLabel>
      <ShowcaseDemo>
        <Picker isSubmitting />
      </ShowcaseDemo>

      <ShowcaseLabel>
        One agent left after a partial failure — pick three, two land, the third is still a chip
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* The room sheet's add is one call per agent, so a failure is reported
            on its own. A chip lives exactly as long as its agent is still
            offerable, so the ones that landed take their chips with them and
            the button is offering a retry rather than a repeat. Here the fleet
            is down to the one that failed. */}
        <Picker candidates={[ROOM_CANDIDATES[0]!]} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** The confirmation, and the undo the removal leaves behind. */
function RemoveMemberConfirmShowcase() {
  return (
    <PlaygroundSection
      title="RemoveMemberConfirm"
      description="Confirmed in place, never in a second dialog: a dialog over a dialog closed both when it was answered, taking the roster the reader was working on with it. The sentence says the two things a person cannot see — what stays, and what does not."
    >
      <ShowcaseLabel>Waiting to be answered</ShowcaseLabel>
      <ShowcaseDemo>
        <Panel>
          <RemoveMemberConfirm
            memberName="Kai"
            roomTitle="#general"
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </Panel>
      </ShowcaseDemo>

      <ShowcaseLabel>The undo that follows it</ShowcaseLabel>
      <ShowcaseDemo>
        {/* The real one is raised by `useRoomDetailsWrites` on a removal the
            server agreed to — take an agent out of the #general sheet above and
            it is this toast that appears. This button raises the same shape
            without the round trip, for reviewing it on its own. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            toast.success('Kai removed from #general', {
              action: { label: 'Undo', onClick: () => {} },
            })
          }
        >
          Raise the undo toast
        </Button>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The channel header's visibility badge (chats-as-channels spec §8, DOR-879)
 * — "sees mentions only" and "sees everything", each expandable into the
 * same disclosure a reader gets in the real header. Never a DM: privacy
 * mode is a group concept, so a bridged direct message shows no badge at
 * all — there is nothing to demo, which is the point.
 */
function BridgeVisibilityBadgeShowcase() {
  return (
    <PlaygroundSection
      title="BridgeVisibilityBadge"
      description="Telegram's own privacy-mode switch for the bot, sourced from the bridge row's visibility — never from config. A disclosure, not a control: press it and it explains itself, including the two honest gaps (bot-wide not per-group, and DorkOS's own reply setting as a second gate) rather than offering a switch that would be lying about what it can change."
    >
      <ShowcaseLabel>Partial — "sees mentions only"</ShowcaseLabel>
      <ShowcaseDemo>
        <BridgeVisibilityBadge visibility="partial" />
      </ShowcaseDemo>

      <ShowcaseLabel>Full — "sees everything"</ShowcaseLabel>
      <ShowcaseDemo>
        <BridgeVisibilityBadge visibility="full" />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Every room component, every state, with no server behind any of it. */
export function RoomsShowcases() {
  return (
    <>
      <RoomSheetShowcase />
      <RoomMemberRowShowcase />
      <RoomAvatarShowcase />
      <BridgeVisibilityBadgeShowcase />
      <ResponseModeControlShowcase />
      <LoudnessMeterShowcase />
      <RoomLoudnessLineShowcase />
      <AgentRosterPickerShowcase />
      <RemoveMemberConfirmShowcase />
    </>
  );
}
