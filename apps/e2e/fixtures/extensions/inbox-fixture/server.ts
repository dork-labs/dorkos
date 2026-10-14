// inbox-fixture's server half (DOR-2523). One person-only route raises a
// yes-or-no decision in a project the test names, and the action handler
// settles every answer. Served as a fetch handler with Hono, which DorkOS
// builds in, behind `requirePerson()` (DOR-2859).
import { Hono } from 'hono';
import { requirePerson, type DataProviderContext } from '@dorkos/extension-api/server';

/** What the raise route is sent. */
interface RaiseBody {
  key: string;
  title: string;
  project: string;
  projectLabel?: string;
}

/**
 * Register the raise route and the handler.
 *
 * @param _router - The old router, which this fixture leaves empty.
 * @param ctx - The extension's context.
 */
export default function register(_router: unknown, ctx: DataProviderContext) {
  const stop = ctx.inbox.onAction(() => ({ resolve: 'approved' }));
  const app = new Hono();
  app.post('/raise', requirePerson(), async (c) => {
    const body = await c.req.json<RaiseBody>();
    const raised = await ctx.inbox.raise({
      key: body.key,
      title: body.title,
      why: 'It is built and the reviewer agent found nothing. Shipping merges it.',
      project: body.project,
      projectLabel: body.projectLabel,
      actions: { kind: 'yes-no', approveLabel: 'Ship it', rejectLabel: 'Send it back' },
    });
    return c.json(raised);
  });
  // Clean-up for the spec: withdraw what it raised.
  app.post('/resolve', requirePerson(), async (c) => {
    const { key } = await c.req.json<{ key: string }>();
    return c.json({ resolved: await ctx.inbox.resolve(key, { outcome: 'cancelled' }) });
  });
  return { fetch: app.fetch, cleanup: stop };
}
