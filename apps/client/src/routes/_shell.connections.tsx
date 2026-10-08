import { createFileRoute } from '@tanstack/react-router';
import { ConnectionsPage } from '@/layers/widgets/connections';
import { ConnectionsBar } from '../app/route-headers';
import { zodValidator } from '@tanstack/zod-adapter';
import { connectionsSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/connections')({
  staticData: { header: ConnectionsBar },
  validateSearch: zodValidator(connectionsSearchSchema),
  component: ConnectionsPage,
});
