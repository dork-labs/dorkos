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
import { problem, readJsonBody, validationProblem } from '@dorkos/http-kit';
import type { ComputerErrorCode } from '@dorkos/shared/computer-schemas';
import type { ProblemCode } from '@dorkos/shared/problem';
import { logger, logError } from '../lib/logger.js';
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
/**
 * Each computer refusal as a problem (DOR-4979): total by type, so a new
 * refusal can't reach a response without a row here.
 */
const COMPUTER_PROBLEMS: Record<ComputerErrorCode, { code: ProblemCode; detail: string }> = {
  unsupported: {
    code: 'computer_unsupported',
    detail: 'This computer can’t run an agent computer.',
  },
  disabled: { code: 'computer_disabled', detail: 'Agent computers are turned off.' },
  'setup-failed': {
    code: 'computer_setup_failed',
    detail: 'The agent computer couldn’t be set up. Restart DorkOS.',
  },
  'not-ready': {
    code: 'temporarily_unavailable',
    detail: 'The agent computer isn’t ready yet. Try again soon.',
  },
  'sign-in-required': {
    code: 'computer_sign_in_required',
    detail: 'Sign in inside the agent computer first.',
  },
  'control-lost': {
    code: 'computer_control_lost',
    detail: 'Another window took control. Take control again.',
  },
  'cleanup-uncertain': {
    code: 'computer_cleanup_uncertain',
    detail: 'DorkOS can’t confirm the agent computer stopped.',
  },
  unavailable: {
    code: 'temporarily_unavailable',
    detail: 'The agent computer isn’t available. Try again.',
  },
};
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
      return problem(c, refusal === 'not-a-person' ? 'person_only' : 'owner_only', {
        detail: 'Only the owner can use this computer.',
      });
    const client = clientSchema.safeParse(c.req.header('X-Client-Id'));
    if (!client.success)
      return problem(c, 'invalid_request', { detail: 'Open this from the DorkOS app.' });
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
        const { code, detail } = COMPUTER_PROBLEMS[error.code];
        return problem(c, code, { detail });
      }
      logger.warn('[Computers] A computer action failed', logError(error));
      const { code, detail } = COMPUTER_PROBLEMS.unavailable;
      return problem(c, code, { detail });
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
      return validationProblem(c, body.error, { detail: 'Send the control lease to return.' });
    return execute(c, async () => {
      await service.release(owner(c), body.data.leaseId);
      return { ok: true };
    });
  });
  routes.post('/input', async (c) => {
    const body = ComputerInputSchema.safeParse(await readJsonBody(c));
    if (!body.success)
      return validationProblem(c, body.error, { detail: 'That isn’t a desktop action.' });
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
