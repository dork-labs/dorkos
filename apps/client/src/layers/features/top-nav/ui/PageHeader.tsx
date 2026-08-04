import { CommandPaletteTrigger } from './CommandPaletteTrigger';

interface PageHeaderProps {
  /** Page title displayed at the left edge. */
  title: string;
  /** Center content between title and actions (filter bars, view tabs, status indicators). */
  children?: React.ReactNode;
  /** Action buttons rendered before the command palette trigger at the right edge. */
  actions?: React.ReactNode;
}

/**
 * Standardized header layout for top-level page routes.
 *
 * Renders `[Title] [center content] [actions] [CommandPalette]`.
 * Center content fills available space; if absent, a spacer pushes actions right.
 */
export function PageHeader({ title, children, actions }: PageHeaderProps) {
  return (
    <>
      {/* min-w-0 + truncate: ChannelsHeader feeds this a user-controlled room
          title (up to 200 chars, or longer from a bridged Slack/Telegram room),
          and an untruncated title blows the 36px header open on a phone. The
          title attribute keeps the full name reachable, as RoomTitle does. */}
      <span className="min-w-0 truncate text-sm font-medium" title={title}>
        {title}
      </span>
      {children ? (
        <div className="ml-3 flex min-w-0 flex-1 items-center">{children}</div>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <CommandPaletteTrigger />
      </div>
    </>
  );
}
