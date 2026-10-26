import { createFileRoute } from '@tanstack/react-router';
import { TasksPage } from '@/layers/widgets/tasks';
import { HomeSurfaceBar } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { tasksSearchSchema } from '../app/route-search';

export const Route = createFileRoute('/_shell/_home/tasks')({
  staticData: { header: HomeSurfaceBar },
  validateSearch: zodValidator(tasksSearchSchema),
  component: TasksPage,
});
