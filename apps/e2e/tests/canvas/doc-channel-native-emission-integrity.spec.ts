/** Original authenticated Room producer/frame/receipt control; source-only until named allocation. */
import { originalHeldTurnHasText } from '../../fixtures/doc-channel-consumer/live-session-snapshot.js';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { startIsolatedConsumerHost } from '../../fixtures/doc-channel-consumer/server.js';
import { signInOriginalConsumerHost } from '../../fixtures/doc-channel-consumer/browser-bootstrap.js';

for (const integrityCase of ['select-builder', 'event-codec'] as const) {
  test(
    'original native Room ' +
      integrityCase +
      ' fault preserves the first ack and refuses the second emission',
    async ({ page }) => {
      const host = await startIsolatedConsumerHost('room', integrityCase);
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
          if (!result.ok()) throw new Error('Original authenticated replay unavailable');
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
              data: {
                v: 1,
                id,
                type: 'task.comment',
                payload: { text: 'Original input ' + index },
              },
            })
          )
        );
        for (const response of responses) expect(response.status()).toBe(201);
        expect(await host.startNativeEmissionIntegrityObservation()).toEqual({ started: true });
        await step(); // Releases only the preceding genuine busy turn.
        // Do not run replay/row decoders while the genuine descriptor fault is armed.
        await expect
          .poll(async () => {
            const data = await host.readNativeEmissionIntegrityData();
            if (data.observerFailed)
              throw new Error('Original integrity observer failed: ' + data.observerFailure);
            return data.phase;
          })
          .toBe('armed');
        const armed = await host.readNativeEmissionIntegrityData();
        expect(armed).toMatchObject({
          caseName: integrityCase,
          phase: 'armed',
          retired: false,
          observerFailed: false,
        });
        expect(armed.ackId).not.toBeNull();
        await step();
        held = false;
        // A real accepted HTTP step resumes the same original ONE scenario. Only its
        // actual retirement lets the owner restore the descriptor and permit replay.
        await expect
          .poll(async () => {
            const data = await host.readNativeEmissionIntegrityData();
            if (data.observerFailed)
              throw new Error('Original integrity observer failed: ' + data.observerFailure);
            return data.phase === 'restored' && data.retired === true;
          })
          .toBe(true);
        const final = await replay();
        const acknowledgements = final.events.filter(
          (row: { event: { type: string } }) => row.event.type === 'app.ack'
        );
        expect(acknowledgements).toHaveLength(1);
        expect(acknowledgements[0].event.id).toBe(armed.ackId);
        expect(
          final.events.filter(
            (row: { event: { type: string } }) => row.event.type === 'agent.reply'
          )
        ).toHaveLength(0);
        const subjects = (await host.readOriginalRoomScenarioData()).batches.filter((batch) =>
          ids.every((id) => batch.eventIds.includes(id))
        );
        expect(subjects).toHaveLength(1);
        const subject = subjects[0]!;
        expect(subject.eventIds).toHaveLength(2);
        expect(new Set(subject.eventIds)).toEqual(new Set(ids));
        await expect
          .poll(async () => {
            const evidence = (await host.readOriginalRoomScenarioData()).batches.find(
              (batch) =>
                batch.batchId === subject.batchId && batch.generation === subject.generation
            )?.evidence;
            return (
              evidence?.scenarioStarts === 1 &&
              evidence.retired === true &&
              evidence.operationFailed === true &&
              evidence.cleanupClosed === true
            );
          })
          .toBe(true); // Original owner records actual failed operation plus positive peer/native-stage drains.
        expect(subject.evidence).toMatchObject({ scenarioStarts: 1, retired: true });
        const ack = acknowledgements[0].event.payload;
        expect(ack).toMatchObject({
          batchId: subject.batchId,
          routeId: 'consumer',
          outcome: 'handled',
        });
        expect(ack.eventIds).toEqual([subject.eventIds[0]]);
        const deliveries = (id: string) =>
          final.receipts.find((row: { receipt: { id: string } }) => row.receipt.id === id)
            .deliveries;
        expect(deliveries(subject.eventIds[0])[0].ackOutcome).toBe('handled');
        expect(deliveries(subject.eventIds[1])[0].ackOutcome ?? null).toBeNull();
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
    }
  );
}
