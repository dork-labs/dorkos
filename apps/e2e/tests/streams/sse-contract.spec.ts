import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * The SSE endpoints still work (ADR 260805-041016).
 *
 * The cockpit moved its durable streams onto WebSockets, but the same three
 * paths keep answering Server-Sent Events, because that is the published
 * integration contract (`docs/integrations/sse-protocol.mdx`, which opens "Read
 * this before building any client that talks to a DorkOS session over HTTP")
 * and what the Electron main process reads for its tray count.
 *
 * Nothing the cockpit does exercises that any more. Without this the SSE half
 * could rot silently through any refactor of the shared sequencing, and only a
 * third party would find out.
 *
 * Deliberately NOT through the browser's `EventSource`: an integration is
 * usually a script or a server, and reading the raw bytes is what pins the wire
 * format — the `event:` and `data:` lines, and the headers that keep a proxy
 * from buffering the stream — rather than whatever a parser chose to expose.
 */

/** How long to hold a stream open before deciding what it sent. */
const COLLECT_MS = 5000;

/** One collected SSE connection. */
interface Collected {
  status: number;
  contentType: string | null;
  accelBuffering: string | null;
  raw: string;
}

/** The API origin behind the mock cockpit's Vite proxy. */
function apiUrlFrom(baseURL: string): string {
  return baseURL.replace(/:\d+$/, `:${process.env.DORKOS_MOCK_PORT || '4243'}`);
}

/**
 * Open an SSE stream and read it until `until` is satisfied or the time box
 * expires, then abort.
 *
 * The time box is not laziness: a durable stream never ends on its own, so a
 * plain "read to completion" would hang forever against a healthy server.
 *
 * @param url - The stream URL.
 * @param until - Stop reading once the accumulated text satisfies this.
 */
async function collectSse(url: string, until: (raw: string) => boolean): Promise<Collected> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });

  const collected: Collected = {
    status: response.status,
    contentType: response.headers.get('content-type'),
    accelBuffering: response.headers.get('x-accel-buffering'),
    raw: '',
  };

  if (!response.body) {
    controller.abort();
    return collected;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + COLLECT_MS;
  try {
    while (Date.now() < deadline && !until(collected.raw)) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.raw += decoder.decode(value, { stream: true });
    }
  } finally {
    controller.abort();
  }
  return collected;
}

/** The `data:` payload of the first frame in some SSE text. */
function firstPayload(raw: string): Record<string, unknown> {
  const line = raw.split('\n').find((candidate) => candidate.startsWith('data: '));
  expect(line, 'the stream sent no data frame').toBeDefined();
  return JSON.parse(line!.slice('data: '.length)) as Record<string, unknown>;
}

test.describe('the SSE endpoints remain the integration contract', () => {
  test.setTimeout(60_000);

  test('a session stream answers as SSE and leads with a snapshot frame', async ({
    request,
    baseURL,
  }) => {
    const apiUrl = apiUrlFrom(baseURL!);
    const seeded = await request.post(`${apiUrl}/api/test/seed-agent`);
    expect(seeded.ok(), 'could not seed an agent').toBe(true);
    const { agentDir } = (await seeded.json()) as { agentDir: string };

    const collected = await collectSse(
      `${apiUrl}/api/sessions/${randomUUID()}/events?cwd=${encodeURIComponent(agentDir)}`,
      (raw) => raw.includes('\n\n')
    );

    expect(collected.status).toBe(200);
    expect(collected.contentType).toContain('text/event-stream');
    // Part of the contract, not decoration: it is what stops a proxy holding the
    // stream until it has "enough" of it.
    expect(collected.accelBuffering).toBe('no');

    // The doc's promise for a cold connect: the FIRST frame is the snapshot.
    expect(collected.raw, 'a cold connect must lead with a snapshot frame').toContain(
      'event: snapshot'
    );
    expect(Object.keys(firstPayload(collected.raw))).toEqual(
      expect.arrayContaining([
        'messages',
        'inProgressTurn',
        'status',
        'pendingInteractions',
        'cursor',
      ])
    );
  });

  test('the global stream answers as SSE and announces the connection', async ({ baseURL }) => {
    // The stream the Electron main process reads for its tray count, and the one
    // an integration subscribes to for session-list changes.
    const collected = await collectSse(`${apiUrlFrom(baseURL!)}/api/events`, (raw) =>
      raw.includes('event: connected')
    );

    expect(collected.status).toBe(200);
    expect(collected.contentType).toContain('text/event-stream');
    expect(collected.raw).toContain('event: connected');
    expect(firstPayload(collected.raw)).toHaveProperty('connectedAt');
  });
});
