import * as React from 'react';
import { Info } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import {
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
  useResponsivePopover,
} from './responsive-popover';

/** Props for {@link InfoTip}. */
export interface InfoTipProps {
  /**
   * The button's accessible name, which says what the tip is about: "About
   * background agents". Required, because the button shows only an icon.
   */
  label: string;
  /** What the tip says. Keep each paragraph to 15 words or fewer. */
  children: React.ReactNode;
  /**
   * An optional heading for the panel. On a phone it is the drawer's title and
   * falls back to `label` when omitted, so the drawer always has a name.
   */
  title?: string;
  /** Chrome for the trigger button: margins, alignment. The caller owns it. */
  className?: string;
  /** Desktop only: which side of the icon the popover opens on. @default 'top' */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Desktop only: how the popover lines up with the icon. @default 'start' */
  align?: 'start' | 'center' | 'end';
}

/**
 * The panel's heading. On a phone the drawer always gets a title (the `title`,
 * or the `label` when there is none), because a sheet needs a name. On desktop a
 * popover shows a heading only when the caller asked for one.
 */
function InfoTipHeading({ label, title }: Pick<InfoTipProps, 'label' | 'title'>) {
  const { isDesktop } = useResponsivePopover();
  if (!isDesktop) return <ResponsivePopoverTitle>{title ?? label}</ResponsivePopoverTitle>;
  if (!title) return null;
  return <p className="text-foreground mb-1.5 font-medium">{title}</p>;
}

/**
 * A quiet info icon that sits inline after a label and opens a short note.
 *
 * Rung 3 of the overflow ladder in the `writing-app-copy` skill: the label stays
 * short, and the explanation that does not fit moves in here. It opens on click
 * or tap, never on hover, so it works by keyboard and on touch, and it can hold
 * a few short paragraphs. A popover on desktop, a bottom drawer on a phone.
 *
 * Not a `Tooltip`: a tooltip shows on hover, has no touch path and holds one
 * line. Use `MoreDetails` instead when the extra text belongs in the page flow.
 */
export function InfoTip({
  label,
  children,
  title,
  className,
  side = 'top',
  align = 'start',
}: InfoTipProps) {
  return (
    // `autoFocus` is the phone drawer's opt-in, not a field grabbing focus: the
    // drawer holds no field, so focus moves into it rather than staying on an
    // icon the modal sheet has just hidden. The desktop popover does this anyway.
    // eslint-disable-next-line jsx-a11y/no-autofocus
    <ResponsivePopover autoFocus>
      <ResponsivePopoverTrigger asChild>
        <button
          type="button"
          data-slot="info-tip"
          aria-label={label}
          className={cn(
            // The glyph is 14px so it sits on a text line without pushing it
            // apart; the `after:` box widens the hit area to 30px around it
            // without moving anything, so a thumb can still find it.
            'text-muted-foreground hover:text-foreground focus-ring relative inline-flex size-4 shrink-0 items-center justify-center rounded-full align-middle transition-colors duration-150',
            "after:absolute after:-inset-2 after:content-['']",
            'data-[state=open]:text-foreground',
            className
          )}
        >
          <Info aria-hidden className="size-3.5" />
        </button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        side={side}
        align={align}
        aria-label={title ?? label}
        className="w-72 text-sm"
      >
        <InfoTipHeading label={label} title={title} />
        <div className="text-muted-foreground space-y-2 leading-relaxed">{children}</div>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
