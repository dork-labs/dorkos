import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));

/** Shared generation options; each app constructs its own Vite plugin. */
export function clientRouterOptions() {
  return {
    target: 'react' as const,
    routesDirectory: path.join(clientRoot, 'src/routes'),
    generatedRouteTree: path.join(clientRoot, 'src/routeTree.gen.ts'),
    autoCodeSplitting: true,
  };
}
