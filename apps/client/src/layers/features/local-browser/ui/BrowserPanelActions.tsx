import type { ReactNode } from 'react';

/** Keep secondary actions together below the phone primary and beside it when space allows. */
export function BrowserPanelActions({
  primary,
  children,
}: {
  primary: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div data-slot="browser-panel-actions" className="flex flex-wrap items-center gap-2">
      {primary}
      {children && (
        <div
          data-slot="browser-panel-secondary-actions"
          className="flex max-w-full min-w-0 flex-wrap items-center gap-2"
        >
          {children}
        </div>
      )}
    </div>
  );
}
