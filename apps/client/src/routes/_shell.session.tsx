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
  // A real navigation owns writes. Its loader may otherwise share an
  // in-flight intent preload, which only reads.
  beforeLoad: ({ context, search, preload, abortController }) => {
    if (!preload && (!search.session || search.agentPath || (search.draft === '1' && search.dir))) {
      return sessionRouteLoader({ context, deps: sessionLoaderDeps({ search }), abortController });
    }
  },
  loader: sessionRouteLoader,
});
