import { configureComputerMesh } from '../startup/computer-agent.js';
import type { MeshCore } from '@dorkos/mesh';
import { getComputerService, computerSetupFailed } from '../startup/computers.js';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  ComputerInputSchema,
  ComputerStatusSchema,
  ComputerFrameSchema,
  ComputerControlLeaseSchema,
  ComputerSessionSchema,
} from '@dorkos/shared/computer-schemas';
import { type ComputerService, ComputerRefusal } from '../services/computers/computer-service.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import type { ApiEnv } from '../http/api-chain.js';

/** Narrow service boundary for the authenticated computer routes. */
export type ComputerRoutesService = Pick<
  ComputerService,
  | 'status'
  | 'create'
  | 'start'
  | 'stop'
  | 'signIn'
  | 'session'
  | 'frame'
  | 'acquire'
  | 'release'
  | 'input'
>;
const releaseSchema = z.object({ leaseId: z.string().min(1).max(128) }).strict();
const clientSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Mount owner-only local computer actions under `/api/computers`. */
export function createComputerRoutes(service: ComputerRoutesService): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  routes.use('*', async (c, next) => {
    const facts = honoRequestFacts(c);
    const refusal = refuseUnlessAccountOwner(facts);
    if (refusal)
      return c.json({ error: 'Only the owner can use this computer.', code: refusal }, 403);
    const client = clientSchema.safeParse(c.req.header('X-Client-Id'));
    if (!client.success)
      return c.json({ error: 'A valid app window is required.', code: 'invalid-client' }, 400);
    await next();
  });
  const owner = (c: Context<ApiEnv>) =>
    JSON.stringify([
      honoRequestFacts(c).user?.userId ?? 'local-owner',
      c.req.header('X-Client-Id'),
    ]);
  const execute = async (
    c: Context<ApiEnv>,
    action: () => Promise<unknown>,
    schema: z.ZodType = z.unknown()
  ) => {
    try {
      return c.json(schema.parse(await action()));
    } catch (error) {
      if (error instanceof ComputerRefusal) {
        const status =
          error.code === 'control-lost' || error.code === 'cleanup-uncertain'
            ? 409
            : error.code === 'unavailable' ||
                error.code === 'not-ready' ||
                error.code === 'setup-failed'
              ? 503
              : 400;
        return c.json({ error: 'Computer action unavailable.', code: error.code }, status);
      }
      return c.json({ error: 'Computer action unavailable.', code: 'unavailable' }, 503);
    }
  };
  routes.get('/', (c) => execute(c, () => service.status(), ComputerStatusSchema));
  routes.post('/', (c) => execute(c, () => service.create(), ComputerStatusSchema));
  routes.post('/start', (c) => execute(c, () => service.start(), ComputerStatusSchema));
  routes.post('/stop', (c) => execute(c, () => service.stop(), ComputerStatusSchema));
  routes.post('/sign-in', (c) => execute(c, () => service.signIn(), ComputerStatusSchema));
  routes.post('/sessions', (c) => execute(c, () => service.session(), ComputerSessionSchema));
  routes.get('/frame', (c) => execute(c, () => service.frame(owner(c)), ComputerFrameSchema));
  routes.post('/control', (c) =>
    execute(c, () => service.acquire(owner(c)), ComputerControlLeaseSchema)
  );
  routes.delete('/control', async (c) => {
    const body = releaseSchema.safeParse(await readJsonBody(c));
    if (!body.success)
      return c.json({ error: 'Invalid control request.', code: 'invalid-input' }, 400);
    return execute(c, async () => {
      await service.release(owner(c), body.data.leaseId);
      return { ok: true };
    });
  });
  routes.post('/input', async (c) => {
    const body = ComputerInputSchema.safeParse(await readJsonBody(c));
    if (!body.success)
      return c.json({ error: 'Invalid computer input.', code: 'invalid-input' }, 400);
    return execute(c, async () => {
      await service.input(owner(c), body.data);
      return { ok: true };
    });
  });
  return routes;
}

/** Mount the current startup service, or an explicit route-test service. */
export function mountComputerRoutes(
  app: Hono<ApiEnv>,
  injected?: ComputerRoutesService,
  mesh?: Pick<MeshCore, 'registerByPath'>
): void {
  if (mesh) configureComputerMesh(mesh);
  const service = injected ?? getComputerService();
  if (service) app.route('/api/computers', createComputerRoutes(service));
  else if (computerSetupFailed()) {
    const unavailable = async () => {
      throw new ComputerRefusal('unavailable');
    };
    app.route(
      '/api/computers',
      createComputerRoutes({
        status: async () => ({
          id: 'local',
          name: 'Agent computer',
          supported: process.platform === 'darwin' && process.arch === 'arm64',
          phase: 'failed',
          generation: 0,
          ready: false,
          error: { code: 'setup-failed' },
        }),
        create: unavailable,
        start: unavailable,
        stop: unavailable,
        signIn: unavailable,
        session: unavailable,
        frame: unavailable,
        acquire: unavailable,
        release: unavailable,
        input: unavailable,
      })
    );
  }
}
