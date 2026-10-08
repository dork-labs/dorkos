import { createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '../AppShell';

export const Route = createFileRoute('/_shell')({
  staticData: { header: null },
  component: AppShell,
  /**
   * Retire `?relay=open`.
   *
   * That param opened a dialog, on any route, that the Connections page has
   * replaced. Links to it are in bookmarks, tours and old release notes, so
   * rather than breaking them it lands on the Connections page, where chat
   * apps now sit in the one list. Handled on the shell route because the param
   * was never route-specific.
   */
  beforeLoad: ({ search }) => {
    const { relay, ...rest } = search as { relay?: string } & Record<string, unknown>;
    if (!relay) return;
    throw redirect({
      to: '/connections',
      search: rest,
      replace: true,
    });
  },
});
