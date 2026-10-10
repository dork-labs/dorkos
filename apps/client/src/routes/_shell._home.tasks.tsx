import { createFileRoute } from '@tanstack/react-router';
import { TasksPage } from '@/layers/widgets/tasks';
import { HomeSurfaceBar } from '@/layers/widgets/one-bar';

export const Route = createFileRoute('/_shell/_home/tasks')({
  staticData: { header: HomeSurfaceBar },
  component: TasksPage,
});
