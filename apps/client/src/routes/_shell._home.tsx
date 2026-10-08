import { createFileRoute } from '@tanstack/react-router';
import { HomeSurfaceLayout } from '@/layers/widgets/home';

export const Route = createFileRoute('/_shell/_home')({
  staticData: { header: null },
  component: HomeSurfaceLayout,
});
