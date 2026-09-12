/**
 * The strip under a room canvas's tabs: whose copy a file came from, who this
 * viewer is following, and the way into a document's discussion (spec
 * `canvas-agent-seat` §6, §7).
 *
 * Three small controls rather than one, because they answer three different
 * questions and only one of them is ever about the document on screen.
 *
 * @module features/canvas/ui/room/RoomCanvasChrome
 */
import { Check, Eye, MessageSquare } from 'lucide-react';
import type { AuthorKind } from '@dorkos/shared/room-schemas';
import { cn, hashToHslColor, initialOf } from '@/layers/shared/lib';
import {
  Button,
  IdentityAvatar,
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuTrigger,
} from '@/layers/shared/ui';

/** Somebody in the room this viewer could follow. */
export interface FollowableMember {
  /** Their author id. */
  id: string;
  /** What to call them. */
  displayName: string;
  /** Person, agent, or the room itself — only people appear in the list. */
  kind: AuthorKind;
  /** Their emoji, when they have one. */
  emoji?: string | undefined;
  /** Their own colour, when they have one. */
  color?: string | undefined;
  /** Their photo, when they have one. */
  imageUrl?: string | undefined;
}

/** What {@link RoomCanvasChrome} draws. */
export interface RoomCanvasChromeProps {
  /** Whose copy of the files the open document came out of, when that is worth saying. */
  sourceLabel?: string | undefined;
  /**
   * People this viewer could follow — everybody else in the room who is a
   * person. Empty hides the control, because a room with nobody else in it has
   * nobody to follow.
   */
  people: FollowableMember[];
  /** Who this viewer is following here, or `null`. */
  following: string | null;
  /** Follow somebody, or switch to somebody else. */
  onFollow: (memberId: string) => void;
  /** Stop following. */
  onStopFollowing: () => void;
  /** Open the open document's discussion, or `undefined` when nothing is open. */
  onDiscuss?: (() => void) | undefined;
  /** True while the discussion is being opened, so the control cannot be pressed twice. */
  discussing?: boolean;
}

/**
 * The controls that sit between a room canvas's tabs and its document.
 *
 * @param props - The label, the people, the follow state and the discuss action.
 */
export function RoomCanvasChrome({
  sourceLabel,
  people,
  following,
  onFollow,
  onStopFollowing,
  onDiscuss,
  discussing = false,
}: RoomCanvasChromeProps) {
  const leader = people.find((person) => person.id === following) ?? null;
  if (sourceLabel === undefined && people.length === 0 && onDiscuss === undefined) return null;

  return (
    <div className="text-muted-foreground flex items-center gap-2 border-b px-3 py-1 text-xs">
      {/* Whose copy of the files this came out of — a snapshot taken when it was
          opened, never a live count, which is why it is stated rather than
          refreshed. */}
      {sourceLabel !== undefined && <span className="min-w-0 flex-1 truncate">{sourceLabel}</span>}
      {sourceLabel === undefined && <span className="flex-1" />}

      {onDiscuss && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5"
          disabled={discussing}
          onClick={onDiscuss}
        >
          <MessageSquare className="size-3.5" />
          Discuss
        </Button>
      )}

      {people.length > 0 && (
        <ResponsiveDropdownMenu>
          <ResponsiveDropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn('h-6 gap-1 px-1.5', leader && 'text-foreground')}
            >
              <Eye className="size-3.5" />
              {leader ? `Following ${leader.displayName}` : 'Follow'}
            </Button>
          </ResponsiveDropdownMenuTrigger>
          <ResponsiveDropdownMenuContent align="end">
            {/* People only. An agent has no view to share — it puts what it wants
                you to see on the table instead — so the list never holds one. */}
            <ResponsiveDropdownMenuLabel>Follow somebody’s browser</ResponsiveDropdownMenuLabel>
            {people.map((person) => (
              <ResponsiveDropdownMenuItem
                key={person.id}
                onSelect={() => (person.id === following ? onStopFollowing() : onFollow(person.id))}
              >
                <IdentityAvatar
                  aria-hidden
                  size="xs"
                  className="size-4 shrink-0 text-[9px]"
                  kind={person.kind}
                  color={person.color ?? hashToHslColor(person.id)}
                  emoji={person.emoji}
                  imageUrl={person.imageUrl}
                  badge={null}
                  fallback={initialOf(person.displayName)}
                />
                <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
                {person.id === following && <Check className="size-3.5 shrink-0" />}
              </ResponsiveDropdownMenuItem>
            ))}
            {leader && (
              <ResponsiveDropdownMenuItem onSelect={onStopFollowing}>
                Stop following
              </ResponsiveDropdownMenuItem>
            )}
          </ResponsiveDropdownMenuContent>
        </ResponsiveDropdownMenu>
      )}
    </div>
  );
}
