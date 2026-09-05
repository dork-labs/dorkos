/**
 * One member of a room, on one line.
 *
 * @module features/room-management/ui/RoomMemberRow
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn, resolveIdentityFace, type AgentVisual } from '@/layers/shared/lib';
import { useIsMobile, useDragVsTapGuard } from '@/layers/shared/model';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IdentityAvatar,
} from '@/layers/shared/ui';
import {
  LoudnessMeter,
  OriginMark,
  RESPONSE_RUNGS,
  ResponseModeControl,
  levelOfRung,
  rungOf,
  type EngagedWindow,
  type ResponseRung,
  type RoomPresenceAuthor,
} from '@/layers/entities/room';
import { memberSecondaryLine } from '../lib/member-line';
import { RemoveMemberConfirm } from './RemoveMemberConfirm';

/**
 * How long the loudness scale takes to open its own height, or to give it back.
 *
 * The caret above it turns in the same time, so the mark and the panel it
 * belongs to are one movement rather than two that happen to overlap.
 */
const DISCLOSURE_SECONDS = 0.15;

export interface RoomMemberRowProps {
  /** The membership this row draws, its author already resolved. */
  member: RoomRosterEntry;
  /** The room it lives in; it decides what the rungs mean. See `rungOf`. */
  roomKind: RoomKind;
  /** True when this member is the person reading. */
  isReader: boolean;
  /**
   * The agent's face as its own manifest gives it, or `null` when the fleet
   * could not name one. See {@link RoomMemberRow} for what happens then.
   */
  visual: AgentVisual | null;
  /** This member's live work signal, or `null` when there is nothing to know. */
  presence: RoomPresenceAuthor | null;
  /**
   * Open this member's profile, or `undefined` for one the roster cannot
   * address — an agent the fleet could not name, or the room's own voice.
   *
   * Handed in rather than resolved here, because an agent's roster id lives in
   * a different id space from the author id this row holds (see
   * `profileMemberIdOf`) and only the sheet has the fleet join that bridges
   * them. Without it the face and name stay plain text: never a control that
   * opens an empty profile.
   */
  onViewProfile?: () => void;
  /** When this member last posted, if a post of theirs is in the loaded page. */
  lastSpokeAt: string | null;
  /** Whether this row's loudness control is open. */
  expanded: boolean;
  /** Open or close the loudness control. */
  onExpandedChange: (expanded: boolean) => void;
  /** Commit a rung for this member. */
  onRungChange: (rung: ResponseRung) => void;
  /**
   * Which rung the reader is pointing at without having committed it, or `null`
   * when they are pointing at nothing.
   *
   * Never called in an archived room — see {@link RoomMemberRow}.
   */
  onRungPreview: (rung: ResponseRung | null) => void;
  /** Whether this member's rung is being written right now. */
  savingRung: boolean;
  /**
   * Why this member's last rung change did not save, or `null` when the last
   * one did. The pill has already gone back to the stored value by then; this
   * says why it moved back.
   */
  rungError: string | null;
  /** The room in prose, for the confirmation to name. */
  roomTitle: string;
  /** Ask to take this member out. The list decides which row is asking. */
  onRemoveRequested: () => void;
  /** Whether this row is the one waiting to be confirmed. */
  confirmingRemoval: boolean;
  /** Take this member out for real. */
  onConfirmRemoval: () => void;
  /** Put the confirmation away. */
  onCancelRemoval: () => void;
  /** The engaged-window ceilings, or `null` while the config read is in flight. */
  engagedWindow: EngagedWindow | null;
  /**
   * Why this room cannot be changed, as the id of the element that says so —
   * or `null` when it can.
   *
   * Non-null greys the meter, stops the scale committing, and takes away both
   * removal verbs; it is also handed to the scale, so a screen reader is told
   * the reason rather than left to discover a control that does nothing. The
   * scale itself stays: reading what each rung means is worth doing on a room
   * you are deciding whether to revive, and a verb is not.
   */
  dormantReasonId: string | null;
}

/**
 * The face-and-name half of a row, as a control when there is a profile behind
 * it and as plain markup when there is not.
 *
 * **A sibling of the row's other controls, never a parent of them.** The
 * loudness pill and the `⋯` sit beside this, not inside it — a button nested in
 * a button is invalid HTML that assistive technology announces unpredictably,
 * which is the same reason `AgentListItem` draws its face control as an overlay
 * rather than wrapping the lockup.
 *
 * **The label names the action; the second line survives as a description.** An
 * `aria-label` wins over content, so the "last spoke 3 min ago" line inside this
 * control would simply vanish for a screen reader — `aria-describedby` points
 * back at it so the row still says who, what they did, and where pressing goes.
 *
 * **A press that travelled is a drag, and a drag is not a tap.** On a phone this
 * sheet is a vaul drawer: a downward drag over the roster moves the whole
 * drawer WITH the pointer, so the element under the finger at the end of the
 * gesture is the same one it started on — and the browser fires a click. Before
 * this control existed the lockup was an inert `<div>` and that click landed on
 * nothing; as a button it opened a profile every time somebody tried to put the
 * sheet away, which is how `room-sheet-phone.spec.ts` found it.
 * `useDragVsTapGuard` (DOR-1275) is what decides here now — extracted from an
 * inline version of the same check so the loudness pill and the in-row Remove
 * button beside this control could share it instead of going without.
 *
 * @param props.onViewProfile - Open this member's profile, or `undefined` for a
 *   member with none to open.
 * @param props.displayName - Whose profile it is, for the accessible name.
 * @param props.isReader - True when that is the person reading, who is named in
 *   the second person rather than by a display name that is literally "You".
 * @param props.describedById - The id of the row's secondary line.
 * @param props.children - The face and the name lines.
 */
function ProfileLink({
  onViewProfile,
  displayName,
  isReader,
  describedById,
  children,
}: {
  onViewProfile: (() => void) | undefined;
  displayName: string;
  isReader: boolean;
  describedById: string;
  children: ReactNode;
}) {
  const dragGuard = useDragVsTapGuard();

  if (onViewProfile === undefined) return <>{children}</>;

  return (
    <button
      type="button"
      onPointerDown={dragGuard.onPointerDown}
      onClick={(event) => {
        if (dragGuard.travelled(event)) return;
        onViewProfile();
      }}
      // Names the ACTION with the name inside it, the shape the sidebar face,
      // the Team card and the mention pill all use — so "open Ana's profile" is
      // sayable by voice and the visible text is a prefix of what is spoken.
      // Second person for your own row. The reader's display name is the
      // literal string "You", so the ordinary template says "Open You’s
      // profile" — which is the row every operator sees about themselves.
      aria-label={isReader ? 'Open your profile' : `Open ${displayName}’s profile`}
      aria-describedby={describedById}
      // **Occupies exactly the space the lockup already did.** No padding of
      // its own, so the row keeps the height it had before this control existed
      // — the sheet's own rhythm, the loudness scale's indent, and everything
      // the phone spec measures are all downstream of that. A `py-1` here read
      // as harmless and made every row 8px taller, which moved the scale out
      // from under a resting pointer and cost the room-sheet specs two reds.
      className={cn(
        // `-ml-1`/`-mr-[5px]`, not a symmetric `-mx-1` — and PHONE ONLY in what
        // it actually buys: the row's 12px gap to the loudness pill splits as
        // 4px of reach here plus 7px of the pill's own `-inset-[7px]` outset,
        // which left exactly 1px neither control claimed (DOR-1275) — a dead
        // pixel a drag-to-dismiss could still land a stray click on. Above
        // 768px the pill's own reach is `md:after:hidden`, so there is no
        // invisible-reach dance left to have a dead pixel in; the margin
        // change ships everywhere because it costs nothing there (padding
        // absorbs it, so the visible content does not move), but the 1px it
        // closes only exists below `md:`. It comes off the right margin only,
        // since that is the side facing the pill; the left side has nothing
        // to its left in this row to encroach on.
        'focus-visible:ring-ring hover:bg-accent/60 relative -mr-[5px] -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 text-left outline-hidden transition-colors focus-visible:ring-2',
        // The house recipe for a control shorter than a thumb (`PresenceStrip`,
        // the loudness pill): invisible reach rather than real height, so the
        // 44px target costs the row none of its own rhythm. VERTICAL only — the
        // 12px gap to the loudness pill is all that keeps the two apart, and the
        // pill spends 7px of it on its own outset. The row is 56px under a thumb
        // and this lockup about 36, so 8px each way stays inside the row and
        // cannot steal a tap from the member above or below.
        'after:absolute after:-inset-y-2 after:right-0 after:left-0 md:after:hidden'
      )}
    >
      {children}
    </button>
  );
}

/**
 * A member as a line: face, name, what it has done here, how loud it is.
 *
 * It replaces a 76px bordered card whose dropdown outweighed the person it
 * belonged to. The loudness is a pill on the right — Slack puts "Channel
 * Manager" in that slot, and behaviour is the better thing to put there — and
 * pressing it opens the scale underneath. A person's row simply has no pill: the
 * empty slot says "nobody triggers this one" louder than a label could, which is
 * the same convention the bot glyph keeps.
 *
 * **The face is taken from the freshest source that exists, by the same
 * function the masthead's roster uses.** The agent's own manifest first, so it
 * looks the way it looks everywhere else in the cockpit; then the author
 * record's `emoji`/`color`, which is a server-side render cache and goes stale
 * on a rename; then a letter on a colour hashed from the id. This row used to
 * answer `currentColor` at that last rung rather than hash, on the argument
 * that a hashed colour matches nothing — but it matches the roster three
 * inches away, which hashes the same id through the same function, so refusing
 * to was what made one member two colours at once. What is still never invented
 * is an emoji: a letter admits the face is unknown, where a hashed emoji would
 * look like a face somebody chose.
 *
 * **The face and the name are the door to who this is.** Pressing them opens
 * that member's profile — the same `?profile=<id>` address a Team card, a
 * sidebar face and a mention pill open (spec `profile-unification` §3, bug 7).
 * It is one control covering both, because they are one lockup and one
 * question; the loudness pill and the `⋯` stay beside it rather than inside it.
 * A member whose profile this client cannot address keeps the plain lockup.
 *
 * **The `⋯` is desktop only.** Below 768px the sheet is a vaul drawer, and a
 * dropdown portalled inside one is a known-hazard nesting — so Remove moves to
 * the foot of the expanded row, where a touch reader is already looking.
 *
 * **An archived room previews nothing, and the guard lives here.** The scale
 * still says what each rung means, because reading that is worth doing on a room
 * you are deciding whether to revive — but there is no room-level consequence to
 * point at: the sheet replaces its loudness line with the sentence saying why
 * these settings are on hold. This row is the one holding both facts, so it is
 * the one that withholds the report.
 */
export function RoomMemberRow({
  member,
  roomKind,
  isReader,
  visual,
  presence,
  onViewProfile,
  lastSpokeAt,
  expanded,
  onExpandedChange,
  onRungChange,
  onRungPreview,
  savingRung,
  rungError,
  roomTitle,
  onRemoveRequested,
  confirmingRemoval,
  onConfirmRemoval,
  onCancelRemoval,
  engagedWindow,
  dormantReasonId,
}: RoomMemberRowProps) {
  const isMobile = useIsMobile();
  const reduced = useReducedMotion();
  const controlId = useId();
  // The row's second line, named so the profile control above can point at it —
  // see {@link ProfileLink}.
  const secondaryId = `${controlId}-secondary`;
  const confirmRef = useRef<HTMLButtonElement>(null);
  // One guard per control, not one shared: each tracks where ITS OWN press
  // began, and a shared instance would let a drag that started on one button
  // decide whether a click on the other one counts (DOR-1275).
  const loudnessDragGuard = useDragVsTapGuard();
  const removeDragGuard = useDragVsTapGuard();
  const { author } = member;
  const isAgent = author.kind === 'agent';
  const rung = rungOf(member.responseMode, roomKind);
  const rungLabel = RESPONSE_RUNGS.find((option) => option.rung === rung)?.label ?? '';
  const working = presence !== null;
  // One ladder, shared with the masthead's roster — see `resolveIdentityFace`.
  // This row is the only one of the two that can reach the fleet, so it is the
  // only one with an override to pass; everything below that is the same
  // decision made in the same place.
  const face = resolveIdentityFace({ record: author, override: visual, origin: member.origin });

  /**
   * The confirmation takes the keyboard, so it can be answered without hunting
   * for it and so a screen reader reads what it is confirming.
   *
   * This covers the touch path, where Remove is a plain button inside the
   * expanded row. It CANNOT cover the desktop menu — see `onCloseAutoFocus`
   * below — and the two are not redundant: neither one works where the other
   * does.
   */
  useEffect(() => {
    if (confirmingRemoval) confirmRef.current?.focus();
  }, [confirmingRemoval]);

  return (
    <div data-slot="room-member-row">
      {/* 56px under a thumb. The row is not itself a tap target — the pill and
          the "…" are — but it carries two lines of text and a face, and at the
          36px its contents come to it reads as a list of dots with captions.
          Above 768px the contents decide, the way every other list in the
          cockpit lets them. */}
      <div className="flex min-h-14 items-center gap-3 md:min-h-0">
        <ProfileLink
          onViewProfile={onViewProfile}
          displayName={author.displayName}
          isReader={isReader}
          describedById={secondaryId}
        >
          <IdentityAvatar
            // Named one at a time rather than spread. A spread reads as if the
            // compiler is checking the two shapes agree, and it is not: extra
            // props land on the DOM as lowercase attributes with a console
            // warning, so the day `IdentityFace` grows a field every roster disc
            // would quietly carry it. The cost is that a NEW field has to be
            // added here by hand — `imageUrl` was, in DOR-975 — and the compiler
            // cannot remind you, because every one of them is optional.
            kind={face.kind}
            color={face.color}
            emoji={face.emoji}
            imageUrl={face.imageUrl}
            fallback={face.fallback}
            origin={face.origin}
            status={working ? 'working' : 'idle'}
            // 32px under a thumb, 28px under a pointer — a roster of 28px discs
            // on a phone reads as a list of dots. It is the thing a finger lands
            // on when aiming at the row, which is now also where the row leads.
            className="size-8 md:size-7"
          />

          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center truncate text-sm font-medium">
              <span className="truncate">{author.displayName}</span>
              {isReader && <span className="text-muted-foreground font-normal">&nbsp;(you)</span>}
              {/* A bridged person now wears their platform twice — the disc's
                  badge and this labelled mark — and that is the intent, not a
                  leftover: the badge is the glance and this is the one that says
                  which platform in words. The message gutter pairs them the same
                  way. */}
              <OriginMark origin={member.origin} className="ml-1 shrink-0" />
            </p>
            <p id={secondaryId} className="text-muted-foreground truncate text-xs">
              {memberSecondaryLine({ presence, lastSpokeAt, joinedAt: member.joinedAt })}
            </p>
          </div>
        </ProfileLink>

        {isAgent && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? controlId : undefined}
            aria-label={`How loud ${author.displayName} is here`}
            // The value on it is this client's guess until the server agrees.
            // Not disabled with it: the pill only opens the scale, and taking
            // that away for the length of a round trip would be a control that
            // stops working every time it is used.
            aria-busy={savingRung || undefined}
            onPointerDown={loudnessDragGuard.onPointerDown}
            onClick={(event) => {
              if (loudnessDragGuard.travelled(event)) return;
              onExpandedChange(!expanded);
            }}
            className={cn(
              'text-muted-foreground hover:text-foreground focus-visible:ring-ring relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-hidden transition-colors focus-visible:ring-2 md:h-6 md:px-2',
              savingRung && 'opacity-60',
              // 32px of real pill plus 6px of invisible reach each way is the
              // 44px a thumb needs — and the number that buys it is SEVEN, not
              // six. An absolutely positioned `::after` is inset from its
              // containing block's PADDING box, so the pill's 1px border eats a
              // pixel at each end: `-inset-1.5` measures 42px in a browser, not
              // 44. It read as correct arithmetic for as long as nobody put a
              // ruler on it, which jsdom cannot (every box there is 0×0).
              //
              // Seven, and not the twelve that would be simpler:
              // `AgentChipPicker` learned at 390x844 that a 12px outset on a
              // chip ate 1.9% of the input beside it at two chips and 10.6% at
              // six. Nothing interactive sits beside this pill, so the cost of
              // overreaching here is a wasted tap rather than a deleted agent —
              // but the row's gap is 12px, and leaving most of it dead is what
              // keeps the two targets distinct.
              'after:absolute after:-inset-[7px] md:after:hidden',
              expanded && 'text-foreground border-brand/50'
            )}
          >
            <LoudnessMeter
              level={levelOfRung(rung)}
              size="pill"
              dormant={dormantReasonId !== null}
            />
            {rungLabel}
            {/* The pill opens something, and a meter beside a word does not
                look like it does. The caret says so, and turning over as the
                scale opens is what ties the mark to the panel. */}
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3 shrink-0 transition-transform duration-150',
                expanded && 'rotate-180'
              )}
            />
          </button>
        )}

        {isAgent && !isMobile && dormantReasonId === null && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                aria-label={`${author.displayName} actions`}
                className="text-muted-foreground size-7 shrink-0"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              // Where the keyboard goes when this menu closes, and the ONLY
              // place it can be decided. An open menu is a trapped focus scope:
              // anything the confirmation focuses while the menu is still
              // mounted is dragged straight back inside, and then the menu
              // unmounts and drops focus on the body. Radix's own restore runs
              // after the teardown, so redirecting it here is the one moment
              // that lands — the effect above is a commit too early and always
              // will be. Only redirected when a confirmation is actually
              // waiting; a menu dismissed with Escape still returns the reader
              // to the "…" they opened.
              onCloseAutoFocus={(event) => {
                if (confirmRef.current === null) return;
                event.preventDefault();
                confirmRef.current.focus();
              }}
            >
              <DropdownMenuItem variant="destructive" onSelect={onRemoveRequested}>
                Remove from this room
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {rungError !== null && (
        // Why the pill just moved back. Indented under the name like the scale
        // and the confirmation, so it reads as belonging to this member.
        //
        // Deliberately not a live region: the shared mutation toast already
        // announces the same failure with the action named in front of it, and
        // it is the report that survives this sheet being closed. A second
        // announcement here would say the same thing twice to the one reader
        // who cannot glance at the pill to see it move.
        <p className="text-destructive mt-1 ml-11 text-xs md:ml-10">
          That didn&apos;t save. {rungError}
        </p>
      )}

      {/* `initial={false}` so a row that mounts already open — the sheet keeps
          one scale open at a time and re-renders around it — does not perform
          the opening it did not do. */}
      <AnimatePresence initial={false}>
        {isAgent && expanded && (
          <motion.div
            id={controlId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduced ? 0 : DISCLOSURE_SECONDS, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {/* Indented under the name rather than the disc, so the control
                reads as belonging to this member and not to the list. The
                bottom slack is the last control's focus ring, which the clip
                above would otherwise shave. */}
            <div className="mt-2 mb-1 ml-11 md:ml-10">
              <ResponseModeControl
                memberName={author.displayName}
                roomKind={roomKind}
                value={rung}
                onChange={onRungChange}
                onPreview={dormantReasonId === null ? onRungPreview : undefined}
                engagedWindow={engagedWindow}
                disabledReasonId={dormantReasonId}
              />
              {isMobile && dormantReasonId === null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onPointerDown={removeDragGuard.onPointerDown}
                  onClick={(event) => {
                    if (removeDragGuard.travelled(event)) return;
                    onRemoveRequested();
                  }}
                  className="text-destructive hover:text-destructive mt-1 h-11 w-full justify-start px-3"
                >
                  Remove from this room
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {confirmingRemoval && (
        <RemoveMemberConfirm
          memberName={author.displayName}
          roomTitle={roomTitle}
          onConfirm={onConfirmRemoval}
          onCancel={onCancelRemoval}
          confirmRef={confirmRef}
        />
      )}
    </div>
  );
}
