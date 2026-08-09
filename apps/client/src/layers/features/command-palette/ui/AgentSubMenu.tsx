import {
  FolderOpen,
  AppWindow,
  SquareArrowOutUpRight,
  Plus,
  Settings,
  MessageSquare,
} from 'lucide-react';
import { CommandGroup, CommandItem, CommandShortcut } from '@/layers/shared/ui';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName, isMac } from '@/layers/shared/lib';

interface SessionMetadata {
  id: string;
  /** Display-ready title from usePreviewData — never blank. */
  title: string;
  lastActive: string;
}

interface AgentSubMenuProps {
  /** Agent being drilled into */
  agent: AgentPathEntry;
  /** Switch CWD to this agent's project path */
  onOpenHere: () => void;
  /** Open agent's project in a new tab */
  onOpenNewTab: () => void;
  /**
   * Open agent's project in a second cockpit window. Omitted where a separate
   * window is not a real destination (a browser, the Obsidian embed) — no
   * handler, no row.
   */
  onOpenNewWindow?: () => void;
  /** Start a new session in this agent's CWD */
  onNewSession: () => void;
  /** Open agent settings dialog */
  onEditSettings: () => void;
  /** Recent sessions for this agent (max 3) */
  recentSessions: SessionMetadata[];
  /** Open one of those sessions. */
  onSelectSession: (sessionId: string) => void;
}

/**
 * Sub-menu page for agent drill-down in the command palette.
 *
 * Displays action buttons (Open Here, Open in New Tab, Open in New Window,
 * New Session) and a list of recent sessions for the selected agent. The "where"
 * choices sit together on purpose: this is the one place a person picks where an
 * agent should land, so they belong in the same list rather than some here and
 * one hidden behind a gesture.
 *
 * **New Window appears only where it is a different destination** — the desktop
 * app. In a browser `onOpenNewWindow` is omitted and the row is left out
 * entirely, rather than shown disabled or quietly remapped to a tab, because a
 * browser's "new window" is the tab the row above already offers.
 *
 * Rendered as a cmdk page when the user presses Enter on an agent.
 */
export function AgentSubMenu({
  agent,
  onOpenHere,
  onOpenNewTab,
  onOpenNewWindow,
  onNewSession,
  onEditSettings,
  recentSessions,
  onSelectSession,
}: AgentSubMenuProps) {
  const modKey = isMac ? '\u2318' : 'Ctrl+';

  return (
    <>
      <CommandGroup heading={`${getAgentDisplayName(agent)} Actions`}>
        <CommandItem value="open-here" onSelect={onOpenHere}>
          <FolderOpen className="size-4" />
          <span>Open Here</span>
          <CommandShortcut>Enter</CommandShortcut>
        </CommandItem>
        <CommandItem value="open-new-tab" onSelect={onOpenNewTab}>
          <AppWindow className="size-4" />
          <span>Open in New Tab</span>
          <CommandShortcut>{modKey}Enter</CommandShortcut>
        </CommandItem>
        {onOpenNewWindow && (
          <CommandItem value="open-new-window" onSelect={onOpenNewWindow}>
            <SquareArrowOutUpRight className="size-4" />
            <span>Open in New Window</span>
          </CommandItem>
        )}
        <CommandItem value="new-session" onSelect={onNewSession}>
          <Plus className="size-4" />
          <span>New Session</span>
        </CommandItem>
        <CommandItem value="edit-settings" onSelect={onEditSettings}>
          <Settings className="size-4" />
          <span>Edit {getAgentDisplayName(agent)} Settings</span>
        </CommandItem>
      </CommandGroup>
      {recentSessions.length > 0 && (
        <CommandGroup heading="Recent Sessions">
          {recentSessions.map((session) => (
            <CommandItem
              key={session.id}
              value={session.id}
              onSelect={() => onSelectSession(session.id)}
            >
              <MessageSquare className="size-4" />
              <span className="truncate">{session.title}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {formatRelativeTime(session.lastActive)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}

/** Format a timestamp as relative time (e.g., '2h ago', '3d ago'). */
function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w ago`;
}
