/**
 * One Installed row's update line: checking, an update from one version to
 * another, updating, up to date, or why it couldn’t be checked — plus the
 * reason a last attempt to update it failed.
 *
 * @module features/marketplace/ui/InstallationUpdateStatus
 */
import { CircleArrowUp, CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { Spinner } from '@/layers/shared/ui';
import { formatCheckVersion, type RowUpdateState } from '../lib/installed-updates';

/** A status line's layout: icon then text, wrapping under the icon's column. */
const LINE = 'flex items-start gap-1.5 text-xs';
const ICON = 'mt-0.5 size-3 shrink-0';

/** A caveat on a known answer (a rollback, a default branch), under its line. */
function Note({ text }: { text: string }) {
  return <p className="text-muted-foreground pl-4.5 text-xs">{text}</p>;
}

/**
 * The update line for one row. Renders nothing for a row with no answer
 * (`unchecked`): the summary above the list says why there is none.
 */
export function InstallationUpdateStatus({ state }: { state: RowUpdateState }) {
  switch (state.kind) {
    case 'checking':
      return (
        <p className={`${LINE} text-muted-foreground`}>
          <Spinner size="xs" className={ICON} />
          Checking for updates…
        </p>
      );
    case 'applying':
      return (
        <p className={`${LINE} text-muted-foreground`}>
          <Spinner size="xs" className={ICON} />
          {state.check
            ? `Updating to ${formatCheckVersion(state.check.latestVersion, state.check.latestVersionSource)}…`
            : 'Updating…'}
        </p>
      );
    case 'update-available': {
      const { check } = state;
      const from = formatCheckVersion(check.installedVersion, check.installedVersionSource);
      const to = formatCheckVersion(check.latestVersion, check.latestVersionSource);
      return (
        <div className="space-y-0.5">
          <p className={`${LINE} text-status-info-fg font-medium`}>
            <CircleArrowUp className={ICON} aria-hidden />
            <span>
              Update available: {from} <span aria-hidden>→</span>
              <span className="sr-only">to</span> {to}
            </span>
          </p>
          {check.note && <Note text={check.note} />}
          {check.applyError && (
            <p className={`${LINE} text-status-error-fg`}>
              <TriangleAlert className={ICON} aria-hidden />
              <span>Couldn’t update: {check.applyError}</span>
            </p>
          )}
        </div>
      );
    }
    case 'current':
      return (
        <div className="space-y-0.5">
          <p className={`${LINE} text-muted-foreground`}>
            <CircleCheck className={ICON} aria-hidden />
            Up to date
          </p>
          {state.check.note && <Note text={state.check.note} />}
        </div>
      );
    case 'unknown':
      return (
        <p className={`${LINE} text-muted-foreground`}>
          <CircleHelp className={ICON} aria-hidden />
          <span>
            Couldn’t check for updates
            {state.check.note ? `: ${state.check.note}` : ''}
          </span>
        </p>
      );
    case 'unchecked':
      return null;
  }
}
