/**
 * Switch session: where an agent's depth lives, now that its row holds none.
 *
 * An agent is a teammate, not a folder: clicking one opens the chat you were
 * having (BC-34), and everything else that agent has ever run is here — one
 * responsive surface, a dialog on the desktop and a bottom sheet on a phone
 * (BC-35).
 *
 * The content is the one chat list (`features/chat-list`, spec
 * `your-activity-first` D11), the same component an agent's profile draws
 * under Sessions. This module is only the surface around it: the heading, the
 * key legend, and closing itself once a chat is chosen.
 *
 * @module features/dashboard-sidebar/ui/SessionSwitcher
 */
import { useCallback, useState } from 'react';
import { useIsMobile } from '@/layers/shared/model';
import {
  Kbd,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/layers/shared/ui';
import { AgentAvatar, type AgentVisual } from '@/layers/entities/agent';
import { ChatList } from '@/layers/features/chat-list';

/** Props for {@link SessionSwitcher}. */
export interface SessionSwitcherProps {
  /** The agent's project directory — the membership key for its chats. */
  agentPath: string;
  /** What the agent is called, for the surface's own heading. */
  agentName: string;
  /** The agent's face, resolved by whoever is opening this. */
  agentVisual: AgentVisual;
  /** Whether the surface is up. */
  open: boolean;
  /** Raise or lower it. */
  onOpenChange: (open: boolean) => void;
  /**
   * Open a chat — a row, or `↵` on one.
   *
   * A prop rather than a navigation of its own because the two call sites move
   * the app differently: the sidebar goes through the row chrome's
   * `openTarget` (which records the visit), the command palette through its own
   * select handler (which also closes itself and records frecency).
   */
  onSelectSession: (sessionId: string) => void;
  /** Start a new chat with this agent — the New chat button and `⌘↵`. */
  onNewSession: () => void;
}

/**
 * An agent's chats, in the shared chat list, on a dialog or a bottom sheet.
 *
 * @param props - The agent, the surface's open state, and what opening and
 *   starting a chat do.
 */
export function SessionSwitcher({
  agentPath,
  agentName,
  agentVisual,
  open,
  onOpenChange,
  onSelectSession,
  onNewSession,
}: SessionSwitcherProps) {
  // Branched in JS rather than hidden by CSS: a legend that names keys belongs
  // only where there are keys, and rendering exactly one shape keeps a test
  // that asks "is the legend gone on a phone" honest.
  const isMobile = useIsMobile();
  // Mounted from the first open on, so the list stays drawn while the dialog or
  // sheet animates out instead of collapsing to nothing mid-exit. Before the
  // first open it is not mounted at all, so a switcher nobody opened asks for
  // nothing: the roster mounts one per agent row with a live chip.
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);

  const handleOpen = useCallback(
    (sessionId: string) => {
      onSelectSession(sessionId);
      onOpenChange(false);
    },
    [onOpenChange, onSelectSession]
  );

  const handleNew = useCallback(() => {
    onNewSession();
    onOpenChange(false);
  }, [onNewSession, onOpenChange]);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent
        // `min-h-0` overrides `ResponsiveDialogContent`'s own `min-h-[50vh]`,
        // which is right for a form and wrong for a list: an agent with no
        // chats rendered a tall box holding one sentence.
        className="min-h-0 max-w-[440px] gap-0 p-0 sm:max-w-[440px]"
        aria-label={`Chats with ${agentName}`}
        // The list puts focus on a row itself, once it has rows, so `↵` opens
        // a chat straight away. Left to the dialog, focus would land on the
        // first control instead: the sort.
        desktopProps={{
          onOpenAutoFocus: (event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          },
        }}
      >
        <ResponsiveDialogHeader className="px-4 pt-4 pb-2 text-left">
          <ResponsiveDialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <AgentAvatar color={agentVisual.color} emoji={agentVisual.emoji} size="xs" />
            Chats with {agentName}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="flex min-h-0 flex-col pb-2">
          {opened && (
            <ChatList
              agentPath={agentPath}
              agentName={agentName}
              onOpenChat={handleOpen}
              onNewChat={handleNew}
              autoFocusRow={!isMobile}
              className="max-h-[min(60vh,520px)]"
            />
          )}
        </ResponsiveDialogBody>

        {!isMobile && (
          <footer className="text-muted-foreground text-2xs flex flex-wrap gap-x-4 gap-y-1 px-4 pt-1 pb-4">
            <span>
              <Kbd>↵</Kbd> open
            </span>
            <span>
              <Kbd>⌘↵</Kbd> new chat
            </span>
            <span>
              <Kbd>⇧↵</Kbd> fork
            </span>
          </footer>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
