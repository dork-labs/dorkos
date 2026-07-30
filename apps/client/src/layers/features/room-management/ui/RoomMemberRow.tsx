/**
 * One member of a room, on one line.
 *
 * @module features/room-management/ui/RoomMemberRow
 */
import { useEffect, useId, useRef } from 'react';
import { Bot, MoreHorizontal } from 'lucide-react';
import type { RoomKind, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { cn, initialOf, type AgentVisual } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
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
  ResponseModeControl,
  levelOfRung,
  rungOf,
  rungsFor,
  type EngagedWindow,
  type ResponseRung,
  type RoomPresenceAuthor,
} from '@/layers/entities/room';
import { memberSecondaryLine } from '../lib/member-line';
import { RemoveMemberConfirm } from './RemoveMemberConfirm';

export interface RoomMemberRowProps {
  /** The membership this row draws, its author already resolved. */
  member: RoomRosterEntry;
  /** The room it lives in. It decides how many rungs the control offers. */
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
  /** When this member last posted, if a post of theirs is in the loaded page. */
  lastSpokeAt: string | null;
  /** Whether this row's loudness control is open. */
  expanded: boolean;
  /** Open or close the loudness control. */
  onExpandedChange: (expanded: boolean) => void;
  /** Commit a rung for this member. */
  onRungChange: (rung: ResponseRung) => void;
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
 * **The face is taken from the freshest source that exists, and never invented.**
 * The agent's own manifest first, so it looks the way it looks everywhere else
 * in the cockpit; then the author record's `emoji`/`color`, which is a
 * server-side render cache and goes stale on a rename; then a letter on a
 * neutral disc. What it will NOT do is hash an id into a confident-looking face:
 * that produces a perfectly stable colour matching nothing, and the one surface
 * that guessed would look the most certain of them all.
 *
 * **The `⋯` is desktop only.** Below 768px the sheet is a vaul drawer, and a
 * dropdown portalled inside one is a known-hazard nesting — so Remove moves to
 * the foot of the expanded row, where a touch reader is already looking.
 */
export function RoomMemberRow({
  member,
  roomKind,
  isReader,
  visual,
  presence,
  lastSpokeAt,
  expanded,
  onExpandedChange,
  onRungChange,
  savingRung,
  rungError,
  roomTitle,
  onRemoveRequested,
  confirmingRemoval,
  onConfirmRemoval,
  onCancelRemoval,
  engagedWindow,
}: RoomMemberRowProps) {
  const isMobile = useIsMobile();
  const controlId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const { author } = member;
  const isAgent = author.kind === 'agent';
  const rung = rungOf(member.responseMode, roomKind);
  const rungLabel = rungsFor(roomKind).find((option) => option.rung === rung)?.label ?? '';
  const working = presence !== null;

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
      <div className="flex items-center gap-3">
        <IdentityAvatar
          // 32px under a thumb, 28px under a pointer — the disc is not a
          // control, but it is the thing a finger lands on when aiming at the
          // row, and a roster of 28px discs on a phone reads as a list of dots.
          className="size-8 md:size-7"
          color={visual?.color ?? author.color ?? 'currentColor'}
          emoji={visual?.emoji ?? author.emoji}
          fallback={initialOf(author.displayName)}
          badge={isAgent ? <Bot /> : undefined}
        >
          {working && (
            // The same green a working agent wears elsewhere, ringed in the
            // page background so it reads as separate from the disc's tint. The
            // row's own second line says what it means; this is the glance.
            <span
              aria-hidden
              className="bg-status-success ring-background absolute -top-px -right-px size-2 rounded-full ring-2"
            />
          )}
        </IdentityAvatar>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {author.displayName}
            {isReader && <span className="text-muted-foreground font-normal"> (you)</span>}
          </p>
          <p className="text-muted-foreground truncate text-xs">
            {memberSecondaryLine({ presence, lastSpokeAt, joinedAt: member.joinedAt })}
          </p>
        </div>

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
            onClick={() => onExpandedChange(!expanded)}
            className={cn(
              'text-muted-foreground hover:text-foreground focus-visible:ring-ring relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-hidden transition-colors focus-visible:ring-2 md:h-6 md:px-2',
              savingRung && 'opacity-60',
              // 32px of real pill plus 6px of invisible reach each way is the
              // 44px a thumb needs. Six, and not the twelve that would be
              // simpler: `AgentChipPicker` learned at 390x844 that a 12px
              // outset on a chip ate 1.9% of the input beside it at two chips
              // and 10.6% at six. Nothing interactive sits beside this pill, so
              // the cost of overreaching here is a wasted tap rather than a
              // deleted agent — but the row's 12px gap is the same 12px, and
              // leaving half of it dead is what keeps the two targets distinct.
              'after:absolute after:-inset-1.5 md:after:hidden',
              expanded && 'text-foreground border-brand/50'
            )}
          >
            <LoudnessMeter level={levelOfRung(rung)} size="pill" />
            {rungLabel}
          </button>
        )}

        {isAgent && !isMobile && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
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
          That didn&apos;t save — {rungError}
        </p>
      )}

      {isAgent && expanded && (
        // Indented under the name rather than the disc, so the control reads as
        // belonging to this member and not to the list.
        <div id={controlId} className="mt-2 ml-11 md:ml-10">
          <ResponseModeControl
            memberName={author.displayName}
            roomKind={roomKind}
            value={rung}
            onChange={onRungChange}
            engagedWindow={engagedWindow}
          />
          {isMobile && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onRemoveRequested}
              className="text-destructive hover:text-destructive mt-1 h-11 w-full justify-start px-3"
            >
              Remove from this room
            </Button>
          )}
        </div>
      )}

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
