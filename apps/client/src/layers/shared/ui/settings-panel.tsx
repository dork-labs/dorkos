import type { ReactNode } from 'react';
import { NavigationLayoutPanel, NavigationLayoutPanelHeader } from './navigation-layout';

export interface SettingsPanelProps {
  /** Tab ID matching a `NavigationLayoutItem` value. */
  value: string;
  /** Panel title shown in the header. */
  title: string;
  /** Optional header actions (e.g., a "Reset" button). */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Settings panel shorthand — wraps `NavigationLayoutPanel` with the
 * standard `space-y-4` + `NavigationLayoutPanelHeader` boilerplate.
 *
 * Use inside a bare `NavigationLayout` (without `TabbedDialog`).
 * `TabbedDialog` already renders this wrapper internally — you don't
 * need to use this when using `TabbedDialog`.
 */
export function SettingsPanel({ value, title, actions, children }: SettingsPanelProps) {
  return (
    <NavigationLayoutPanel value={value}>
      <div className="space-y-4">
        <NavigationLayoutPanelHeader actions={actions}>{title}</NavigationLayoutPanelHeader>
        {children}
      </div>
    </NavigationLayoutPanel>
  );
}
