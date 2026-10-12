/** Real Node routing for original native document tests; no caller facts or authority are supplied. */
import type { RequestListener } from 'node:http';
import { createApiApp } from '../../../../http/api-chain.js';
import { createFrontDoor, frontDoorListener } from '../../../../http/front-door.js';
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
 * with the exact original constructor-issued composition. The optional legacy
 * listener owns only unmoved test controls, never migrated document/file routes.
 */
export function originalDocHttpListener(
  source: () =>
    | (ReturnType<typeof createDocChannelHttpComposition> & Pick<DocChannelHttp, 'metrics'>)
    | undefined,
  options: {
    docMount?: string;
    fileMount?: string;
    legacy?: RequestListener;
    capabilities?: ReturnType<typeof composeRegistry>;
  } = {}
): RequestListener {
  const rule = canvasDocBodyRule(() => source()?.metrics);
  const app = createApiApp({
    admission: new MainRequestAdmission(),
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
  const legacy: RequestListener =
    options.legacy ??
    ((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
  return frontDoorListener(createFrontDoor(legacy, { api: app }));
}
