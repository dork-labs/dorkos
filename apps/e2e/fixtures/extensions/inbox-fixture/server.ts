// inbox-fixture's server half (DOR-2523). One person-only route raises a
// yes-or-no decision in a project the test names, and the action handler
// settles every answer. No imports on purpose: the host compiles this with
// esbuild at run time, and only the shapes below are used.

/** The slice of `ctx.inbox` this fixture uses. */
interface FixtureInbox {
  raise(input: {
    key: string;
    title: string;
    why: string;
    project?: string;
    projectLabel?: string;
    actions: { kind: 'yes-no'; approveLabel: string; rejectLabel: string };
  }): Promise<{ id: string }>;
  onAction(handler: () => { resolve: 'approved' }): () => void;
  resolve(key: string, opts: { outcome: 'cancelled' }): Promise<boolean>;
}

/** The slice of the context this fixture uses. */
interface FixtureContext {
  inbox: FixtureInbox;
  requirePerson: (req: unknown, res: unknown, next: () => void) => void;
}

/** The slice of an Express router this fixture uses. */
interface FixtureRouter {
  post(
    path: string,
    guard: FixtureContext['requirePerson'],
    handler: (
      req: { body: { key: string; title: string; project: string; projectLabel?: string } },
      res: { json(body: unknown): void }
    ) => Promise<void>
  ): void;
}

/**
 * Register the raise route and the handler.
 *
 * @param router - The extension's router, mounted at /api/ext/inbox-fixture.
 * @param ctx - The extension's context.
 */
export default function register(router: FixtureRouter, ctx: FixtureContext): () => void {
  const stop = ctx.inbox.onAction(() => ({ resolve: 'approved' }));
  router.post('/raise', ctx.requirePerson, async (req, res) => {
    const raised = await ctx.inbox.raise({
      key: req.body.key,
      title: req.body.title,
      why: 'It is built and the reviewer agent found nothing. Shipping merges it.',
      project: req.body.project,
      projectLabel: req.body.projectLabel,
      actions: { kind: 'yes-no', approveLabel: 'Ship it', rejectLabel: 'Send it back' },
    });
    res.json(raised);
  });
  // Clean-up for the spec: withdraw what it raised.
  router.post('/resolve', ctx.requirePerson, async (req, res) => {
    res.json({ resolved: await ctx.inbox.resolve(req.body.key, { outcome: 'cancelled' }) });
  });
  return stop;
}
