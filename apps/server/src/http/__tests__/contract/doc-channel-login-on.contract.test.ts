/**
 * The visual companion's page channel, end to end through the composed server
 * with login ON: a `browser` document on a loopback dev-server preview
 * (`127.0.0.1:<port>`, the preview-listener path) emits `companion.review.send`,
 * and the agent that opened the page gets it as a turn.
 *
 * Booted the way the e2e test-mode leg boots the server, on its own port and
 * data directory, so login can be turned on without touching a shared server.
 * The page's POST is sent exactly as the signed-in browser sends it: the
 * owner's session cookie, the app's own `Origin`, and the document generation
 * header the client attaches. The agent does what the designer agent does:
 * `browser_navigate`, then `configure_doc_channel` with a `companion.*` route to
 * `agent:owner`, coalesced, then `approve_doc_route` as the page's opener, with
 * no write binding, so no person is asked.
 *
 * @module http/__tests__/contract/doc-channel-login-on.contract
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CanvasChannelEventReceiptSchema,
  CanvasChannelReplayResponseSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { bootComposedServer, BOOT_HOOK_TIMEOUT_MS, type ComposedServer } from './harness.js';
import {
  COMPANION_DOC_TURN_PREFIX,
  COMPANION_ROUTE,
} from '../../../services/runtimes/test-mode/doc-frame/doc-frame-companion-scenario.js';

/**
 * Keep the boot from reaching out, as the other login-on contracts do, and give
 * it the e2e leg's free `claude-code`-typed test runtime: the agent's own tools
 * (opening the page, approving its route) run on a claude-code turn.
 */
const ENV = {
  DORKOS_CLOUD_URL: 'http://127.0.0.1:9',
  NGROK_AUTHTOKEN: '',
  DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: 'true',
};
const OWNER = {
  email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
  password: 'a-long-password-1',
};

/** The preview document is titled by its loopback host. */
const PREVIEW_TITLE = /^(?:127\.0\.0\.1|localhost)\b/;

/** Poll `read` until `done` holds, or fail with the last value seen. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out; last value: ${JSON.stringify(last)?.slice(0, 600)}`);
}

describe('contract: a preview page’s companion event wakes its agent with login on', () => {
  let server: ComposedServer | undefined;
  let preview: Server | undefined;
  let previewUrl: string;
  let origin: string;
  let cookie: string;

  /** A request as the signed-in owner's browser makes it. */
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(new URL(path, server!.baseUrl), {
      method,
      headers: {
        cookie,
        origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
  }
  async function ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const answer = await call(method, path, body);
    if (answer.status >= 300)
      throw new Error(
        `${method} ${path} answered ${answer.status}: ${JSON.stringify(answer.json)}`
      );
    return answer.json;
  }

  beforeAll(async () => {
    // A dev server for the preview to point at; the page itself is not loaded here.
    preview = createServer((_req, res) => res.end('<!doctype html><title>preview</title>'));
    await new Promise<void>((resolve) => preview!.listen(0, '127.0.0.1', resolve));
    previewUrl = `http://127.0.0.1:${(preview.address() as AddressInfo).port}/`;
    server = await bootComposedServer(ENV);
    origin = server.baseUrl;
    cookie = '';
    await ok('POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' });
    await ok('PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await fetch(new URL('/api/auth/sign-in/email', server.baseUrl), {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(OWNER),
    });
    expect(signedIn.ok).toBe(true);
    cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0]!)
      .join('; ');
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => (preview ? preview.close(() => resolve()) : resolve()));
  }, 30_000);

  it('records the page’s companion.review.send for the signed-in owner and starts the opener’s turn with it', async () => {
    const seed = (await ok('POST', '/api/test/seed-agent', { instance: randomUUID() })) as {
      agentDir: string;
      agentId: string;
    };
    await ok('PATCH', `/api/mesh/agents/${encodeURIComponent(seed.agentId)}`, {
      runtime: 'claude-code',
    });
    const draftId = randomUUID();
    await ok('POST', '/api/test/scenario', { name: 'doc-frame-companion', sessionId: draftId });
    const created = (await ok('POST', `/api/sessions/${draftId}/messages`, {
      content: `Show me the companion at ${previewUrl}`,
      cwd: seed.agentDir,
      // The chat the app starts in an agent's folder names the agent and runtime.
      agentPath: seed.agentDir,
      runtime: 'claude-code',
      create: true,
    })) as { sessionId: string };
    const sessionId = created.sessionId;

    // The agent opened the companion's pages; find the dev-server preview.
    const listed = await until(
      async () =>
        (await ok('GET', `/api/sessions/${encodeURIComponent(sessionId)}/canvas`)) as {
          documents: { id: string; title: string }[];
        },
      (value) => value.documents.some((doc) => PREVIEW_TITLE.test(doc.title))
    );
    const documentId = listed.documents.find((doc) => PREVIEW_TITLE.test(doc.title))!.id;

    // The setup turn approves the route as the opener, and is done.
    await ok('POST', '/api/test/step', { sessionId });
    const channel = await until(
      async () =>
        CanvasChannelReplayResponseSchema.parse(
          await ok('GET', `/api/canvas/docs/${encodeURIComponent(documentId)}/channel`)
        ),
      (value) => value.routing?.enabled === true
    );
    expect(channel.routing).toMatchObject({ enabled: true, approvedEventTypes: ['companion.*'] });

    // Without the session cookie the page's POST is refused, so login is really on.
    const event = {
      v: 1,
      id: randomUUID(),
      type: 'companion.review.send',
      payload: { message: 'Pick b', notes: [{ n: 1, text: 'b' }], screen: 'layout' },
    };
    const path = `/api/canvas/docs/${encodeURIComponent(documentId)}/events`;
    const generation = { 'x-dorkos-doc-generation': channel.incarnation!.generation };
    const anonymous = await fetch(new URL(path, server!.baseUrl), {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...generation },
      body: JSON.stringify(event),
    });
    expect(anonymous.status).toBe(401);

    const posted = await call('POST', path, event, generation);
    expect(posted.status).toBe(201);
    const receipt = CanvasChannelEventReceiptSchema.parse(posted.json);
    expect(receipt.receipt).toMatchObject({ id: event.id, status: 'recorded' });
    expect(receipt.deliveries).toEqual([
      expect.objectContaining({ eventId: event.id, routeId: COMPANION_ROUTE.id }),
    ]);

    // The coalesced batch becomes one turn of the agent that opened the page.
    const delivered = await until(
      async () =>
        CanvasChannelEventReceiptSchema.parse(await ok('GET', `${path}/${event.id}`))
          .deliveries[0]!,
      (value) => value.turnId !== null
    );
    expect(['turn_started', 'turn_done', 'handled']).toContain(delivered.status);
    const history = await until(
      async () =>
        JSON.stringify(await ok('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`)),
      (text) => text.includes(COMPANION_DOC_TURN_PREFIX) && text.includes(event.id)
    );
    expect(history).toContain('companion.review.send');
  }, 180_000);
});
