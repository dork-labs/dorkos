import { cn } from '@/layers/shared/lib';
import { useHelpActions } from '../model/use-help-actions';

interface HelpRowsProps {
  /**
   * The row style of the surface they sit in — the You tab passes its own
   * thumb-sized row, so these match the rows above them.
   */
  rowClassName?: string;
  /** Classes for the group around them. */
  className?: string;
}

/**
 * Help and feedback as rows of their own: Send feedback…, Your reports, and
 * Documentation, for a surface with room to show them rather than fold them.
 *
 * A phone's You tab is that surface. There the only fold is "Account and
 * settings", and a person looking for a way to report a problem does not look
 * there, so these are the phone's one visible way to send feedback (DOR-2232).
 * The same actions as {@link import('./HelpMenuItems').HelpMenuItems}, read
 * from the same list.
 */
export function HelpRows({ rowClassName, className }: HelpRowsProps) {
  const actions = useHelpActions();
  return (
    <div
      role="group"
      aria-label="Help and feedback"
      data-testid="help-rows"
      className={cn('flex flex-col gap-0.5', className)}
    >
      {actions.map(({ id, label, icon: Icon, secondary, run }) => (
        <button
          key={id}
          type="button"
          onClick={run}
          data-testid={`help-row-${id}`}
          className={cn(
            'focus-ring hover:text-sidebar-foreground hover:bg-sidebar/50 transition-colors duration-150',
            rowClassName,
            secondary ? 'text-sidebar-foreground/60' : 'text-sidebar-foreground/80'
          )}
        >
          <Icon className="size-(--size-icon-sm) shrink-0" />
          {label}
        </button>
      ))}
    </div>
  );
}
