/** Original authenticated Room producer/frame/receipt control; source-only until named allocation. */
import { originalHeldTurnHasText } from '../../fixtures/doc-channel-consumer/live-session-snapshot.js';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';

test('original two-input Room native FIRST partially acknowledges then replies to the remaining exact input', async ({
  page,
}) => {
  const host = await startIsolatedConsumerHost('room');
  let failed = false;
  let first: unknown;
  let held = false;
  try {
    await page.goto(host.origin + '/channels?id=' + host.roomId);
    await signInOriginalConsumerHost(page, host);
    const configure = async (name: string) => {
      const result = await page.request.post(host.origin + '/api/test/scenario', {
        data: { sessionId: host.sessionId, name },
      });
      expect(result.ok()).toBe(true);
    };
    const step = async () => {
      let attempts = 0;
      await expect
        .poll(async () => {
          if (++attempts > 16) throw new Error('Original native step readiness bound');
          const result = await page.request.post(host.origin + '/api/test/step', {
            data: { sessionId: host.sessionId },
          });
          if (!result.ok()) throw new Error('Original authenticated step refused');
          return (await result.json()).released;
        })
        .toBe(true);
    };
    const replay = async () => {
      const result = await page.request.get(
        host.origin + '/api/canvas/docs/' + host.documentId + '/channel'
      );
      if (!result.ok())
        throw new Error('Original authenticated replay unavailable (HTTP ' + result.status() + ')');
      return result.json();
    };
    await configure('stoppable-turn');
    held = true;
    expect(
      (
        await page.request.post(host.origin + '/api/sessions/' + host.sessionId + '/messages', {
          data: { content: 'Original native admission barrier', cwd: host.root },
        })
      ).status()
    ).toBe(202);
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
    const initial = await replay();
    const ids = [randomUUID(), randomUUID()];
    const responses = await Promise.all(
      ids.map((id, index) =>
        page.request.post(host.origin + '/api/canvas/docs/' + host.documentId + '/events', {
          headers: { 'X-DorkOS-Doc-Generation': initial.incarnation.generation },
          data: { v: 1, id, type: 'task.comment', payload: { text: 'Original input ' + index } },
        })
      )
    );
    for (const response of responses) expect(response.status()).toBe(201);
    await step(); // Releases only the preceding genuine busy turn.
    await expect
      .poll(
        async () =>
          (await replay()).events.filter(
            (row: { event: { type: string } }) => row.event.type === 'app.ack'
          ).length
      )
      .toBe(1);
    const partial = await replay();
    const acknowledgements = partial.events.filter(
      (row: { event: { type: string } }) => row.event.type === 'app.ack'
    );
    expect(acknowledgements).toHaveLength(1);
    const ack = acknowledgements[0].event.payload;
    const data = await host.readOriginalRoomScenarioData();
    const subjects = data.batches.filter((batch) => ids.every((id) => batch.eventIds.includes(id)));
    expect(subjects).toHaveLength(1);
    const subject = subjects[0]!;
    expect(subject.eventIds).toHaveLength(2);
    expect(new Set(subject.eventIds)).toEqual(new Set(ids));
    expect(ack).toMatchObject({
      batchId: subject.batchId,
      routeId: 'consumer',
      outcome: 'handled',
    });
    expect(ack.eventIds).toEqual([subject.eventIds[0]]);
    const deliveries = (id: string) =>
      partial.receipts.find((row: { receipt: { id: string } }) => row.receipt.id === id).deliveries;
    expect(deliveries(subject.eventIds[0])[0].ackOutcome).toBe('handled');
    expect(deliveries(subject.eventIds[1])[0].ackOutcome ?? null).toBeNull();
    expect(
      partial.events.filter((row: { event: { type: string } }) => row.event.type === 'agent.reply')
    ).toHaveLength(0);
    expect(subject.evidence).toMatchObject({
      scenarioStarts: 1,
      retired: false,
      operationFailed: false,
    }); // Missing remains UNKNOWN, never zero.
    await step();
    held = false;
    await expect
      .poll(
        async () =>
          (await replay()).events.filter(
            (row: { event: { type: string } }) => row.event.type === 'agent.reply'
          ).length
      )
      .toBe(1);
    const final = await replay();
    const reply = final.events.find(
      (row: { event: { type: string } }) => row.event.type === 'agent.reply'
    );
    expect(reply.event.payload.inReplyTo).toEqual([subject.eventIds[1]]);
    expect(
      final.events.filter((row: { event: { type: string } }) => row.event.type === 'app.ack')
    ).toHaveLength(1);
    await expect
      .poll(async () => {
        const actual = (await host.readOriginalRoomScenarioData()).batches.find(
          (batch) => batch.batchId === subject.batchId && batch.generation === subject.generation
        );
        return actual?.evidence?.scenarioStarts === 1 &&
          actual.evidence.retired === true &&
          actual.evidence.operationFailed === false &&
          actual.evidence.cleanupClosed === true
          ? 'ONE_CLOSED'
          : 'UNKNOWN_OR_ACTIVE';
      })
      .toBe('ONE_CLOSED');
  } catch (cause) {
    failed = true;
    first = cause;
  }
  if (held) {
    try {
      await page.request.post(host.origin + '/api/sessions/' + host.sessionId + '/interrupt');
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  try {
    await host.close();
  } catch (cause) {
    if (!failed) {
      failed = true;
      first = cause;
    }
  }
  if (failed) throw first;
});
