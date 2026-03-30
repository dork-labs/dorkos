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
      <span className="text-sm font-medium">{title}</span>
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
