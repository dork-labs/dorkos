/**
 * Help and feedback, as menu ITEMS rather than a menu.
 *
 * It used to be a dropdown of its own with a `?` trigger in the sidebar footer.
 * The footer is one slim strip now (spec `sidebar-now-today-library` BC-47) and
 * has no room for a second trigger, so the items moved into the strip's `⋯`
 * fold — the same dual-render convention the sidebar's row and section menus
 * already use, where a builder owns the nodes and the surface owns the chrome.
 *
 * Three rows (feedback-form-redesign §1, DOR-2232): "Send feedback…" opens the
 * one form, whose kind picker covers what "Report a bug" used to; "Your reports"
 * is the person's own history; "Documentation" is last. The public GitHub path
 * lives inside the form now, as one link in its footer.
 *
 * @module features/report-issue/ui/HelpMenuItems
 */
import { DropdownMenuItem, DropdownMenuLabel } from '@/layers/shared/ui';
import { useHelpActions } from '../model/use-help-actions';

/**
 * The help-and-feedback rows, for a dropdown the caller owns.
 *
 * Rendered as a fragment on purpose: the caller decides whether these sit at the
 * top level of its menu or inside a sub-menu, and adds its own separators.
 */
export function HelpMenuItems() {
  const actions = useHelpActions();
  return (
    <>
      <DropdownMenuLabel>Help and feedback</DropdownMenuLabel>
      {actions.map(({ id, label, icon: Icon, secondary, run }) => (
        <DropdownMenuItem
          key={id}
          className={secondary ? 'text-muted-foreground' : undefined}
          onSelect={run}
        >
          <Icon className="size-(--size-icon-sm)" />
          {label}
        </DropdownMenuItem>
      ))}
    </>
  );
}
