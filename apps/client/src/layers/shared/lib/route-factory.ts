/** Typed destinations for every core page. Route declarations stay in src/routes. */
import { linkOptions } from '@tanstack/react-router';

/** Build navigation options once, then add the page's typed search or history options. */
export const appRoutes = {
  home: () => linkOptions({ to: '/' }),
  activity: () => linkOptions({ to: '/activity' }),
  team: () => linkOptions({ to: '/team' }),
  agents: () => linkOptions({ to: '/agents' }),
  channels: () => linkOptions({ to: '/channels' }),
  connections: () => linkOptions({ to: '/connections' }),
  tasks: () => linkOptions({ to: '/tasks' }),
  workspaces: () => linkOptions({ to: '/workspaces' }),
  marketplace: () => linkOptions({ to: '/marketplace' }),
  marketplaceSources: () => linkOptions({ to: '/marketplace/sources' }),
  feedbackRequests: () => linkOptions({ to: '/feedback-requests' }),
  browser: () => linkOptions({ to: '/browser' }),
};
