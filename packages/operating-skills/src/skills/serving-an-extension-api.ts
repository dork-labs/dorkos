import type { OperatingSkill } from '../pack.js';
import { TOOL_NAME_NOTE } from '../tool-name-note.js';

/**
 * Teaches an agent the one way an extension's server half serves its API: a
 * Hono app returned as `{ fetch }`, with `requirePerson()` on every route that
 * changes something, and how to move an extension off the old Express router
 * (DOR-2858).
 */
export const servingAnExtensionApi: OperatingSkill = {
  name: 'serving-an-extension-api',
  description:
    "Use when writing or changing an extension's server half (server.ts), when an extension " +
    'needs its own API at /api/ext/<id>/, or when asked to update an extension whose card in ' +
    'Settings > Extensions says it uses an older server style. Covers the Hono fetch handler, requirePerson(), ' +
    'what replies may carry, and moving routes off the old Express router.',
  body: `# Serving an extension's API

${TOOL_NAME_NOTE}

An extension's server half (\`server.ts\`) answers web requests at
\`/api/ext/<id>/\`. Its page calls them with \`fetch('/api/ext/<id>/items')\`.
Write that API one way: a Hono app, returned as \`{ fetch }\`. Hono is built in,
so \`import { Hono } from 'hono'\` works with nothing installed.

## The shape

\`\`\`typescript
import { Hono } from 'hono';
import { requirePerson, type DataProviderContext } from '@dorkos/extension-api/server';

export default function register(_router: unknown, ctx: DataProviderContext) {
  const app = new Hono();
  app.get('/items', async (c) => c.json((await ctx.storage.loadData()) ?? []));
  app.put('/items', requirePerson(), async (c) => {
    await ctx.storage.saveData(await c.req.json());
    return c.json({ ok: true });
  });
  return { fetch: app.fetch };
}
\`\`\`

- Routes are the path after \`/api/ext/<id>\`: \`app.get('/items')\` answers
  \`GET /api/ext/<id>/items\`.
- \`requirePerson()\` keeps a route to people. Put it on every route that
  changes something. You are an agent, so it refuses you: test those routes by
  asking the person, never by working around it.
- \`c.env.person.ok\` says whether a person is asking, for a route that reads.
- Return \`{ fetch, cleanup }\` when \`register\` starts something to stop, such as
  \`ctx.schedule\`. An entry that needs nothing from \`ctx\` can \`export default app\`.
- Replies can't set cookies or run scripts in a page, and a redirect stays
  inside the extension: \`c.redirect('/done')\` goes to \`/api/ext/<id>/done\`.

## Update an extension that uses the old router

An extension whose \`register(router, ctx)\` adds routes with \`router.get(...)\`
uses the old Express router, which DorkOS will stop running. Its card in
Settings > Extensions says so. To update it:

1. Read its \`server.ts\`. List every \`router.<method>(path, ...)\` route.
2. Make a Hono app. Move each route across:
   - \`router.get('/x', handler)\` → \`app.get('/x', (c) => ...)\`
   - \`req.params.id\` → \`c.req.param('id')\`; \`req.query.q\` → \`c.req.query('q')\`
   - \`req.body\` → \`await c.req.json()\`
   - \`res.json(body)\` → \`return c.json(body)\`; \`res.status(404).json(b)\` →
     \`return c.json(b, 404)\`; \`res.send(text)\` → \`return c.text(text)\`
   - \`req.get('x')\` or \`req.headers['x']\` → \`c.req.header('x')\`
   - \`ctx.requirePerson\` before a handler → \`requirePerson()\` from
     \`@dorkos/extension-api/server\`
   - \`router.use(mw)\` → \`app.use(...)\` with Hono middleware
   - A catch-all \`'/*splat'\` → \`'/*'\`; read the path with \`c.req.path\`
   - Hono treats a trailing slash as a different path: \`new Hono({ strict: false })\`
     keeps \`/x/\` working like \`/x\`.
3. Stop adding routes to \`router\`, and return \`{ fetch: app.fetch }\` (keep any
   cleanup: \`{ fetch: app.fetch, cleanup }\`). Remove \`import ... from 'express'\`.
4. Reload the extension and call each route once to check it answers as before.
   Its page needs no change: the addresses stay the same.
`,
};
