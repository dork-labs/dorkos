import { createFileRoute, redirect } from '@tanstack/react-router';
import { HomeRoomPage } from '../app/HomeRoomPage';
import { HomeSurfaceBar } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { homeSearchSchema } from '../app/route-search';
import { toSession, sessionSearchSchema } from '@/layers/shared/lib';

export const Route = createFileRoute('/_shell/_home/')({
  // The same component all four home surfaces declare — see the note on
  // `/activity` below.
  staticData: { header: HomeSurfaceBar },
  validateSearch: zodValidator(homeSearchSchema),
  component: HomeRoomPage,
  // Redirect to /session if ?session= param is present (backward compat for old bookmarks)
  beforeLoad: async ({ location, context }) => {
    const params = new URLSearchParams(location.searchStr);
    const session = params.get('session');
    if (session) {
      const search = sessionSearchSchema.parse(Object.fromEntries(params));
      const profileRef =
        search.profileRef ??
        (search.agentPath
          ? (await context.transport.createSessionLocation(search.agentPath)).id
          : undefined);
      throw redirect(toSession({ ...search, session, profileRef }));
    }
  },
});
