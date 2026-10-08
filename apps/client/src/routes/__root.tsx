import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { onboardingStageSearchSchema } from '@/layers/features/onboarding';
import { NotFoundFallback } from '@/layers/shared/ui';
import type { RouterContext } from '../app/router-context';

export const Route = createRootRouteWithContext<RouterContext>()({
  staticData: { header: null },
  validateSearch: zodValidator(onboardingStageSearchSchema),
  component: () => <Outlet />,
  notFoundComponent: NotFoundFallback,
});
