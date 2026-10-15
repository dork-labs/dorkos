/** Real Node routing for original native document tests; no caller facts or authority are supplied. */
import type { RequestListener } from 'node:http';
import type { Hono } from 'hono';
import type { ApiEnv } from '../../../../http/api-chain.js';
import { createStandaloneDocTokenRoutes } from '../../../../routes/canvas-doc-token-events.js';
import { createApiApp } from '../../../../http/api-chain.js';
import { frontDoorListener } from '../../../../http/front-door.js';
import { underMount } from '../../../../http/request-body.js';
import { MainRequestAdmission } from '../../../core/lifecycle/main-request-admission.js';
import {
  canvasDocBodyRule,
  createCanvasDocEventRoutes,
  type DocChannelHttp,
} from '../../../../routes/canvas-doc-events.js';
import { createFileRoutes } from '../../../../routes/files.js';
import { createCanvasDocManagementRouter } from '../../../../routes/canvas-doc-management.js';
import type { composeRegistry } from '../../../core/capabilities/registry.js';
import type { createDocChannelHttpComposition } from '../http-composition.js';

/**
 * Run the production admission/body/session/agent chain on actual raw Node peers,
 * with the exact original constructor-issued composition. Additional test controls
 * are registered on that same native chain, never on a second HTTP application.
 */
export function originalDocHttpListener(
  source: () =>
    | (ReturnType<typeof createDocChannelHttpComposition> & Pick<DocChannelHttp, 'metrics'>)
    | undefined,
  options: {
    docMount?: string;
    fileMount?: string;
    standaloneTokens?: boolean;
    registerRoutes?: (app: Hono<ApiEnv>) => void;
    capabilities?: ReturnType<typeof composeRegistry>;
  } = {}
): RequestListener {
  const rule = canvasDocBodyRule(() => source()?.metrics);
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    beforeCors: options.standaloneTokens
      ? (early) => {
          early.route('/api/canvas/token/docs', createStandaloneDocTokenRoutes(source));
        }
      : undefined,
    bodyRules: options.docMount
      ? [{ ...rule, matches: (_method, path) => underMount(path, options.docMount!) }]
      : [],
  });
  if (options.docMount) {
    if (options.capabilities)
      app.route(
        options.docMount,
        createCanvasDocManagementRouter(() => ({ registry: options.capabilities, http: source() }))
      );
    app.route(options.docMount, createCanvasDocEventRoutes(source));
  }
  if (options.fileMount) app.route(options.fileMount, createFileRoutes(source));
  options.registerRoutes?.(app);
  return frontDoorListener(app);
}
