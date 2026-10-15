/**
 * The shared top of the sidebar's DorkBot prompt cards (`IdentityPromptCard`,
 * `ProfilePromptCard`): DorkBot's wordmark on its own row, then the title and
 * a muted line at full card width.
 *
 * The wordmark sat beside the text at 40px until 2026-10. Next to a 272px
 * sidebar that read as tiny, and it squeezed both lines into a narrow column.
 * On its own row it can be larger, and the text gets the whole card.
 *
 * @module features/onboarding/ui/PromptCardHeader
 */
import type { ReactNode } from 'react';
import { DorkLogo } from '@dorkos/icons/logos';

/** Wordmark width in px. The onboarding steps use 72 and 120; 72 suits the sidebar. */
const LOGO_SIZE = 72;

/** Props for {@link PromptCardHeader}. */
export interface PromptCardHeaderProps {
  /** The card's question, or its saved line. */
  title: ReactNode;
  /** The muted explanation under the title. Omit to draw the title alone. */
  description?: ReactNode;
  /** Announce the title as a status, for the moment a card confirms a save. */
  titleIsStatus?: boolean;
}

/**
 * Logo row, title and muted line for a sidebar prompt card.
 *
 * @param props - The title, optional description and status flag.
 */
export function PromptCardHeader({ title, description, titleIsStatus }: PromptCardHeaderProps) {
  return (
    <div className="flex flex-col gap-2">
      <div>
        <DorkLogo size={LOGO_SIZE} className="block dark:hidden" />
        <DorkLogo variant="white" size={LOGO_SIZE} className="hidden dark:block" />
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-sm leading-relaxed" role={titleIsStatus ? 'status' : undefined}>
          {title}
        </p>
        {description !== undefined && (
          <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
        )}
      </div>
    </div>
  );
}
