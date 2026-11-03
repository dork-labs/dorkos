import { createFileRoute } from '@tanstack/react-router';
import { TodosPage } from '@/layers/widgets/todos';
import { TodosBar } from '../app/route-headers';

export const Route = createFileRoute('/_shell/todos')({
  staticData: { header: TodosBar },
  component: TodosPage,
});
