/**
 * One row of the profile's property list — and, when you manage the identity,
 * the control itself (spec `profile-unification` §1.3).
 *
 * @module features/profile/ui/ProfileRow
 */
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, ChevronRight, Copy, Lock, X } from 'lucide-react';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { cn, useCopyFeedback } from '@/layers/shared/lib';
import {
  IdentityAvatar,
  PRESS_ROW,
  ResponsivePopover,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  ResponsivePopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { teamMemberFace } from '@/layers/entities/team';
import type { ProfileRowModel } from '../lib/profile-rows';

/** How many faces the Manages row shows before the count speaks for the rest. */
const MAX_FACES = 3;

/** The trailing glyph, which is also the row's promise about what a tap does. */
function RowGlyph({
  kind,
  copied,
  failed,
}: {
  kind: ProfileRowModel['kind'];
  copied: boolean;
  failed: boolean;
}) {
  const className = 'text-muted-foreground/70 size-3.5 shrink-0';
  if (kind === 'nav') return <ChevronRight aria-hidden className={className} />;
  if (kind === 'pick') return <ChevronDown aria-hidden className={className} />;
  if (kind === 'locked') return <Lock aria-hidden className={className} />;
  if (kind === 'copy') {
    if (copied) return <Check aria-hidden className="text-status-success size-3.5 shrink-0" />;
    if (failed) return <X aria-hidden className="text-status-error size-3.5 shrink-0" />;
    return <Copy aria-hidden className={className} />;
  }
  return null;
}

/** The overlapping discs the Manages row draws before its count. */
function FaceStack({ members }: { members: TeamMember[] }) {
  const shown = members.slice(0, MAX_FACES);
  if (shown.length === 0) return null;
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((member, index) => {
        const face = teamMemberFace(member);
        return (
          <IdentityAvatar
            key={member.id}
            size="xs"
            kind={face.kind}
            color={face.color}
            emoji={face.emoji}
            imageUrl={face.imageUrl}
            fallback={face.fallback}
            origin={face.origin}
            // No kind badge in a stack this small: three Bot marks in 40px say
            // nothing the squares do not already say.
            badge={null}
            className={cn('ring-background ring-2', index > 0 && '-ml-1.5')}
          />
        );
      })}
    </span>
  );
}

export interface ProfileRowProps {
  /** What to draw (see {@link ProfileRowModel}). */
  row: ProfileRowModel;
  /** Push this row's page. Only ever called for a `nav` row. */
  onNavigate?: (row: ProfileRowModel) => void;
  /**
   * The control behind a `pick` row, drawn inside a popover this row triggers.
   *
   * Rendered as a child of `ResponsivePopoverContent`, which mounts nothing
   * until the row is tapped — so a profile with two `pick` rows pays for
   * neither until one is opened. Omitted, and the row is not a control.
   */
  pickContent?: (close: () => void) => ReactNode;
}

/**
 * A label, a value, and — where you may act — a glyph saying how.
 *
 * The row is a `<button>` whenever a tap does something (`nav`, `pick`, `copy`,
 * and `locked`, whose tap explains the lock) and plain text when it does not.
 * That is the difference an operator reads before they read the words: an arrow
 * means there is more behind this, a lock means there is not, and nothing means
 * this is just true.
 *
 * The value truncates and the label never does — the label is what you are
 * scanning for, and a path or a room list is what has to give way.
 */
export function ProfileRow({ row, onNavigate, pickContent }: ProfileRowProps) {
  const { copied, failed, copy } = useCopyFeedback();
  const reasonId = useId();
  const [pickOpen, setPickOpen] = useState(false);
  const isStatic = row.kind === 'text';

  const body = (
    <>
      <span className="text-muted-foreground shrink-0 text-sm">{row.label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-1.5">
        {row.faces && <FaceStack members={row.faces} />}
        {row.value !== null && <span className="truncate text-sm">{row.value}</span>}
        {row.meta && <span className="text-muted-foreground text-2xs shrink-0">{row.meta}</span>}
        <RowGlyph kind={row.kind} copied={copied} failed={failed} />
      </span>
    </>
  );

  const shared = cn(
    'flex h-9 w-full items-center gap-3 rounded-md px-2 text-left',
    // The inset is paid once, here: the list container pays none.
    'text-foreground'
  );

  if (isStatic) {
    return (
      <div
        data-slot="profile-row"
        data-profile-row={row.id}
        data-row-kind={row.kind}
        className={shared}
      >
        {body}
      </div>
    );
  }

  function activate() {
    if (row.kind === 'nav') return onNavigate?.(row);
    // A `pick` row opens its popover through the trigger wrapping this button,
    // not from here — Radix needs the open state to come from the element it
    // will position against.
    if (row.kind === 'pick') return;
    // The trailing glyph already morphs to a check (or an X on failure) —
    // `RowGlyph` above — so a toast here would say the same thing twice.
    if (row.kind === 'copy' && row.copyValue) {
      void copy(row.copyValue);
      return;
    }
    // `locked`. The tooltip answers a pointer; a tap has no hover to give, and
    // this row exists precisely so a lock is never a surprise (the server
    // answers 403 on these). A toast reaches both.
    if (row.lockedReason) toast(row.lockedReason);
  }

  const button = (
    <button
      type="button"
      data-slot="profile-row"
      data-profile-row={row.id}
      data-row-kind={row.kind}
      // Where focus comes back to when the page this row pushed is popped
      // (`ProfileStack`). Keyed by the destination rather than by the row, so
      // any control that pushes a page — a row here, the face in W2.2 — is
      // found the same way.
      data-profile-return={row.kind === 'nav' ? row.page : undefined}
      // `focus-ring` is opt-in: index.css clears the native outline globally.
      className={cn(shared, 'focus-ring hover:bg-muted/50', PRESS_ROW)}
      // The label and its value in one string, so a screen reader hears the row
      // rather than "Runs on" followed by an unrelated-sounding model name.
      aria-label={row.value ? `${row.label}: ${row.value}` : row.label}
      aria-haspopup={row.kind === 'pick' ? 'dialog' : undefined}
      aria-describedby={row.kind === 'locked' ? reasonId : undefined}
      onClick={activate}
    >
      {body}
      {row.kind === 'locked' && row.lockedReason && (
        <span id={reasonId} className="sr-only">
          {row.lockedReason}
        </span>
      )}
    </button>
  );

  if (row.kind === 'pick' && pickContent) {
    return (
      // `modal`: this is a task, not a glance — Tab stays inside the picker and
      // Escape is the way out (`ResponsivePopover`'s own note). On a phone the
      // same component is the bottom drawer the app uses everywhere.
      <ResponsivePopover open={pickOpen} onOpenChange={setPickOpen} modal>
        <ResponsivePopoverTrigger asChild>{button}</ResponsivePopoverTrigger>
        <ResponsivePopoverContent align="end" className="w-80">
          <ResponsivePopoverTitle>{row.label}</ResponsivePopoverTitle>
          {pickContent(() => setPickOpen(false))}
        </ResponsivePopoverContent>
      </ResponsivePopover>
    );
  }

  if (row.kind !== 'locked' || !row.lockedReason) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="left">{row.lockedReason}</TooltipContent>
    </Tooltip>
  );
}
