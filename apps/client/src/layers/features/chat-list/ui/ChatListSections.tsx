/**
 * The chat list's sections and its closed Automated group.
 *
 * @module features/chat-list/ui/ChatListSections
 */
import { ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { SIDEBAR_SECTION_ACTION_ATTRIBUTE } from '@/layers/shared/model';
import { SidebarMenu } from '@/layers/shared/ui';
import type { ChatListModel, ChatRow } from '../model/build-chat-list';
import { revealKeyFor, useReveal } from '../model/use-reveal';
import { ChatListRow, type ChatListRowProps } from './ChatListRow';

/** What every row is handed beside its own model. */
export type SharedRowProps = Omit<ChatListRowProps, 'row'>;

/** Props for {@link ChatListSections}. */
export interface ChatListSectionsProps {
  /** The arranged list. */
  model: ChatListModel;
  /** What each row is handed. */
  rowProps: SharedRowProps;
}

/**
 * Needs you, Running and the rest, each under its heading, then the Automated
 * group, closed until asked for or until it holds the open chat or a match.
 *
 * @param props - The model and what each row is handed.
 */
export function ChatListSections({ model, rowProps }: ChatListSectionsProps) {
  return (
    <>
      {model.sections.map((section, index) => (
        <section key={section.id} aria-label={section.label ?? 'Chats'} data-section={section.id}>
          {section.label !== null && (
            <SectionHeading first={index === 0}>{section.label}</SectionHeading>
          )}
          <Rows rows={section.rows} rowProps={rowProps} />
        </section>
      ))}
      {model.automated.length > 0 && <AutomatedGroup rows={model.automated} rowProps={rowProps} />}
    </>
  );
}

/** One run of rows. */
function Rows({ rows, rowProps }: { rows: ChatRow[]; rowProps: SharedRowProps }) {
  return (
    <SidebarMenu className="gap-0.5">
      {rows.map((row) => (
        <ChatListRow key={row.session.id} row={row} {...rowProps} />
      ))}
    </SidebarMenu>
  );
}

/** Automated chats with no parent chat (D14 rule 2), one closed group with a count. */
function AutomatedGroup({ rows, rowProps }: { rows: ChatRow[]; rowProps: SharedRowProps }) {
  const ids = rows.flatMap((row) => [
    row.session.id,
    ...row.spinOffs.map((spinOff) => spinOff.session.id),
  ]);
  const [open, setOpen] = useReveal(revealKeyFor(ids, rowProps.activeSessionId, rowProps.search));
  return (
    <section aria-label="Automated" data-section="automated">
      <button
        type="button"
        data-slot="chat-list-automated-toggle"
        {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-sidebar-ring text-3xs mt-1 flex min-h-7 w-full items-center gap-1 rounded-md px-2 pt-2 pb-1 font-semibold tracking-[0.05em] uppercase outline-hidden focus-visible:ring-2 max-md:min-h-11"
      >
        <ChevronRight
          aria-hidden
          className={cn('size-3 transition-transform duration-150', open && 'rotate-90')}
        />
        Automated
        <span className="font-normal tabular-nums">{rows.length}</span>
      </button>
      {open && <Rows rows={rows} rowProps={rowProps} />}
    </section>
  );
}

/** A section's heading, in the small caps every list heading here wears. */
function SectionHeading({ children, first }: { children: React.ReactNode; first: boolean }) {
  return (
    <h3
      className={cn(
        'text-muted-foreground text-3xs px-2 pb-1 font-semibold tracking-[0.05em] uppercase',
        first ? 'pt-1' : 'pt-3'
      )}
    >
      {children}
    </h3>
  );
}
