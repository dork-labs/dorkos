import { createFileRoute } from '@tanstack/react-router';
import { ThreadsPage } from '@/layers/widgets/room-view';
import { ThreadsBar } from '../app/route-headers';

export const Route = createFileRoute('/_shell/threads')({
  staticData: { header: ThreadsBar },
  component: ThreadsPage,
});
