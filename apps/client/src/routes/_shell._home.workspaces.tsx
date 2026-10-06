import { createFileRoute } from '@tanstack/react-router';
import { WorkspacesPage } from '@/layers/widgets/workspaces';
import { HomeSurfaceBar } from '@/layers/widgets/one-bar';

export const Route = createFileRoute('/_shell/_home/workspaces')({
  staticData: { header: HomeSurfaceBar },
  component: WorkspacesPage,
});
