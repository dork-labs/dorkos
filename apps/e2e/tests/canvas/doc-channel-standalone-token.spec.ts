/** Genuine isolated bootstrap, browser bearer fetch/SSE and original native responder. UNRUN. */
import { originalHeldTurnHasText } from '../../fixtures/doc-channel-consumer/live-session-snapshot.js';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';
// The ephemeral bootstrap credential must not enter Playwright trace/video artifacts.
test.use({ trace: 'off', video: 'off' });
test('standalone bearer submits exact IDs and fetch-SSE sees native partial ack and correlated reply', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('room', 'none', 'bearer');
  let failed = false,
    first: unknown,
    held = false;
  let reading: Promise<unknown> | undefined;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  const step = async () => {
    let attempts = 0;
    await expect
      .poll(async () => {
        if (++attempts > 16) throw new Error('Original step readiness bound');
        const result = await page.request.post(host.origin + '/api/test/step', {
          data: { sessionId: host.sessionId },
        });
        if (!result.ok()) throw new Error('Original authenticated step refused');
        return (await result.json()).released;
      })
      .toBe(true);
  };
  try {
    if (!host.standaloneToken) throw new Error('Original private bootstrap credential unavailable');
    await page.goto(host.origin + '/channels?id=' + host.roomId);
    await signInOriginalConsumerHost(page, host);
    const configure = async (name: string) => {
      const result = await page.request.post(host.origin + '/api/test/scenario', {
        data: { sessionId: host.sessionId, name },
      });
      if (!result.ok()) throw new Error('Original scenario refused');
    };
    await configure('stoppable-turn');
    held = true;
    const busy = await page.request.post(
      host.origin + '/api/sessions/' + host.sessionId + '/messages',
      { data: { content: 'Original standalone admission barrier', cwd: host.root } }
    );
    expect(busy.status()).toBe(202);
    await expect
      .poll(async () => (await host.readOriginalRoomScenarioData()).targetLocked)
      .toBe(true);
    // The native lock alone can precede scenario capture; observe the real held producer.
    await expect
      .poll(() =>
        originalHeldTurnHasText(
          page,
          host.sessionId,
          host.root,
          'STOPPABLE-TURN: working, and I will not finish on my own.'
        )
      )
      .toBe(true);
    await configure('native-room-partial-ack-reply');
    const ids = [randomUUID(), randomUUID()];
    const task = page.evaluate(
      async ({ serverOrigin, documentId, token, ids }) => {
        // Real Vite module and native fetch; the wrapper records only credential-free request DATA.
        const modulePath = '/src/layers/shared/lib/transport/standalone-doc-stream.ts';
        const client = await import(/* @vite-ignore */ modulePath);
        const controller = new AbortController();
        const requests: {
          method: string;
          cookiesOmitted: boolean;
          tokenInUrl: boolean;
          authorization: boolean;
        }[] = [];
        const fetchImpl: typeof fetch = (input, init) => {
          requests.push({
            method: init?.method ?? 'GET',
            cookiesOmitted: init?.credentials === 'omit',
            tokenInUrl: String(input).includes(token),
            authorization: new Headers(init?.headers).has('Authorization'),
          });
          return fetch(input, init);
        };
        const options = { serverOrigin, documentId, token, signal: controller.signal, fetchImpl };
        const stream = client.streamStandaloneDocEvents(options);
        const events: { id: string; type: string; payload: any; direction: string }[] = [];
        let failed = false,
          first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
        };
        const collect = (async () => {
          for await (const frame of stream) {
            if (frame.kind === 'reset') throw new Error('Unexpected original retention reset');
            events.push(frame.event);
            if (events.length > 128) throw new Error('Original standalone frame bound');
            if (frame.event.type === 'agent.reply') return;
          }
          throw new Error('Original reply stream closed early');
        })();
        void collect.catch(() => {});
        let receipts: any[] = [];
        try {
          const inputs = ids.map((id, index) => ({
            v: 1,
            id,
            type: 'task.comment',
            payload: { text: 'Standalone input ' + index },
          }));
          receipts = await Promise.all(
            inputs.map((event) => client.submitStandaloneDocEvent(options, event))
          );
          const duplicate = await client.submitStandaloneDocEvent(options, inputs[0]);
          receipts.push(duplicate);
          const retained = await client.readStandaloneDocEvent(options, ids[0]);
          if (retained.id !== ids[0] || retained.direction !== 'upstream')
            throw new Error('Original filtered event mismatch');
          await collect;
        } catch (cause) {
          remember(cause);
        } finally {
          controller.abort();
          const drain = async (run: () => Promise<unknown>) => {
            try {
              await run();
            } catch (cause) {
              remember(cause);
            }
          };
          // The collection is settled on the positive path; abort releases its real held read on failure.
          await Promise.allSettled([drain(() => stream.return(undefined)), drain(() => collect)]);
        }
        if (failed) throw first;
        return { receipts, events, requests };
      },
      {
        serverOrigin: host.apiOrigin,
        documentId: host.documentId,
        token: host.standaloneToken,
        ids,
      }
    );
    reading = task;
    void task.catch(() => {});
    await expect
      .poll(async () => {
        const data = await host.readOriginalRoomScenarioData();
        return data.batches.some((batch) => ids.every((id) => batch.eventIds.includes(id)));
      })
      .toBe(true);
    await step(); // Release the preceding real busy turn, never a fabricated holder.
    await expect
      .poll(async () => {
        const response = await page.request.get(
          host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
        );
        if (!response.ok()) throw new Error('Original authenticated audit refused');
        return (await response.json()).events.some((row: any) => row.event.type === 'app.ack');
      })
      .toBe(true);
    const partial = await host.readOriginalRoomScenarioData();
    const subject = partial.batches.find((batch) => ids.every((id) => batch.eventIds.includes(id)));
    if (!subject || subject.eventIds.length !== 2)
      throw new Error('Original two-input batch unavailable');
    await step();
    held = false;
    const result = await task;
    expect(result.receipts.map((row: any) => row.receipt.id)).toEqual([ids[0], ids[1], ids[0]]);
    expect(result.receipts[2].receipt.status).toBe('duplicate');
    const ack = result.events.filter((row: any) => row.type === 'app.ack');
    expect(ack).toHaveLength(1);
    expect(ack[0].payload).toMatchObject({
      batchId: subject.batchId,
      routeId: 'consumer',
      outcome: 'handled',
      eventIds: [subject.eventIds[0]],
    });
    const replies = result.events.filter((row: any) => row.type === 'agent.reply');
    expect(replies).toHaveLength(1);
    expect(replies[0].payload.inReplyTo).toEqual([subject.eventIds[1]]);
    expect(
      result.requests.every(
        (row: any) => row.cookiesOmitted && row.authorization && !row.tokenInUrl
      )
    ).toBe(true);
    await expect
      .poll(async () => {
        const actual = (await host.readOriginalRoomScenarioData()).batches.find(
          (batch) => batch.batchId === subject.batchId && batch.generation === subject.generation
        );
        return actual?.evidence?.scenarioStarts === 1 && actual.evidence.retired === true;
      })
      .toBe(true);
  } catch (cause) {
    remember(cause);
  } finally {
    if (held) {
      try {
        await step();
      } catch (cause) {
        remember(cause);
      }
    }
    // Close the page first so its own real fetch is aborted before the native host drain.
    try {
      await page.close();
    } catch (cause) {
      remember(cause);
    }
    if (reading) {
      try {
        await reading;
      } catch (cause) {
        remember(cause);
      }
    }
    try {
      await host.close();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw first;
});
