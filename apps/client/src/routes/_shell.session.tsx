import { createFileRoute } from '@tanstack/react-router';
import { SessionPage } from '@/layers/widgets/session';
import { SessionRouteHeader } from '@/layers/widgets/one-bar';
import { zodValidator } from '@tanstack/zod-adapter';
import { sessionSearchSchema } from '@/layers/shared/lib';
import { sessionLoaderDeps, sessionRouteLoader } from '../app/session-route-loader';

export const Route = createFileRoute('/_shell/session')({
  staticData: { header: SessionRouteHeader },
  validateSearch: zodValidator(sessionSearchSchema),
  component: SessionPage,
  loaderDeps: sessionLoaderDeps,
  loader: sessionRouteLoader,
});
