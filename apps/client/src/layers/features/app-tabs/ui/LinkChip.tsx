import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import type { LinkChipRenderProps, LinkChipSlot } from '@/layers/shared/model';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/layers/shared/ui';
import {
  linkChipFace,
  linkChipKind,
  type LinkChipKind,
  type LinkChipState,
} from '../lib/link-chip';
import type { TabIdentity } from '../lib/tab-identity';
import { parseTabHref } from '../lib/tab-target';
import { useLinkChip } from '../model/use-link-chip';
import { TabIdentityIcon } from './TabIdentityIcon';
import { TabStatusMark } from './TabStatusMark';

/** How long the pointer rests on a chip before its sentence shows. */
const TOOLTIP_DELAY_MS = 300;

interface LinkChipViewProps {
  /** Which kind of page the link points at. */
  kind: LinkChipKind;
  /** The page's tab identity. */
  identity: TabIdentity;
  /** Where the chip is in finding the page. */
  state: LinkChipState;
  /** The link's own words, shown while the page resolves. */
  label: ReactNode;
  /** Draws the link around the chip's content (`MarkdownLink`'s anchor). */
  anchor: LinkChipRenderProps['anchor'];
}

/**
 * A link to a chat, channel or DM, drawn as a chip: icon, name, status dot
 * (DOR-2824). Presentational, so the Dev Playground lays out every state with
 * the real component; {@link LinkChip} is the wired one.
 *
 * The chip sits inside a line of text, so it is small and quiet: the text's
 * own size, a hairline border, and colour only on the dot. A pointer resting
 * on it reads the status sentence; a screen reader hears the same words in
 * the link's name, so the tooltip is never the only place they live.
 */
export function LinkChipView({ kind, identity, state, label, anchor }: LinkChipViewProps) {
  const face = linkChipFace(kind, identity, state);
  const link = anchor(
    <>
      <TabIdentityIcon
        icon={face.icon}
        className={cn('text-[0.95em]', face.missing && 'text-muted-foreground')}
      />
      <span className="min-w-0 truncate">{face.name ?? label}</span>
      {face.status && <TabStatusMark identity={{ status: face.status }} />}
    </>,
    {
      'aria-label': face.accessibleName,
      'data-chip': face.missing ? 'missing' : state,
      className: cn(
        'inline-flex max-w-[min(100%,20rem)] items-center gap-1.5 align-middle',
        'rounded-md border px-1.5 py-px text-[0.9em] leading-snug font-medium no-underline',
        'transition-colors duration-150',
        face.missing
          ? 'text-muted-foreground border-dashed'
          : 'border-border bg-muted/50 text-foreground hover:bg-muted hover:border-foreground/20'
      ),
    }
  );
  if (!face.sentence) return link;
  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent side="top">{face.sentence}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** A link chip wired to live data: the tab identity, and whether the page exists. */
function LinkChip({ address, label, anchor }: LinkChipRenderProps) {
  const { kind, identity, state } = useLinkChip(address);
  if (kind === null) return anchor(label);
  return (
    <LinkChipView kind={kind} identity={identity} state={state} label={label} anchor={anchor} />
  );
}

/**
 * The link chip the app shell puts in `LinkChipProvider`: links to a chat, a
 * channel or a DM draw as {@link LinkChip}; every other link stays plain.
 */
export const linkChipSlot: LinkChipSlot = {
  accepts: (address) => linkChipKind(parseTabHref(address)) !== null,
  render: (props) => <LinkChip {...props} />,
};
