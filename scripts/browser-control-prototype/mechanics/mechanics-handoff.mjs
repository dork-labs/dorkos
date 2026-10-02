import assert from 'node:assert/strict';
import { center, distribution, assertObservation } from './mechanics-helpers.mjs';
/** Real Page input state crosses manager dispatch/reset, with an already-started wait each round. */
export async function probeHandoffs(s, rounds = 100) {
  const actionReceipts = [];
  const acks = [],
    first = [],
    outcomes = { aborted: 0, rejected: 0 };
  const text = await center(s.tab.page, '#text'),
    drag = await center(s.tab.page, '#drag'),
    increment = await center(s.tab.page, '#increment');
  const dispatch = s.manager.dispatchInput.bind(s.manager);
  let started;
  s.manager.dispatchInput = async (tabId, step, options) => {
    if (step.type === 'wait') started?.();
    return dispatch(tabId, step, options);
  };
  try {
    for (let i = 0; i < rounds; i++) {
      if (s.control.state(s.tab.tabId).controllerId !== 'mechanics-agent')
        await s.control.handoff(s.human, s.tab.tabId, 'mechanics-agent').barrier;
      await s.tab.page.locator('#text').fill('');
      await s.submit(s.agent, { type: 'click', ...text });
      if (i % 3 === 2) {
        await s.submit(s.agent, { type: 'composition', text: '仮' });
        assert.equal(await s.tab.page.locator('#text').inputValue(), '仮');
      } else {
        await s.submit(s.agent, { type: 'keyDown', key: 'Shift' });
        await s.submit(s.agent, {
          type: 'sequence',
          steps: [
            { type: 'mouseMove', ...drag },
            { type: 'mouseDown', button: 'left' },
          ],
        });
        assert.equal(
          (await s.tab.page.evaluate(() => globalThis.fixture.inputState())).dragging,
          true
        );
      }
      const before = await s.tab.page.locator('#revision').textContent();
      const inFlight = new Promise((resolve) => (started = resolve));
      const composite = s.submit(s.agent, {
        type: 'sequence',
        steps: [
          { type: 'wait', ms: i % 20 === 0 ? 500 : 40 },
          { type: 'click', ...increment },
          { type: 'keyUp', key: 'Shift' },
          { type: 'mouseUp', button: 'left' },
        ],
      });
      await inFlight;
      const queued = s.submit(s.agent, { type: 'click', ...increment });
      const start = performance.now();
      const takeover = s.control.takeover(s.human, s.tab.tabId);
      acks.push(performance.now() - start);
      await takeover.barrier;
      // The reset must precede this new-controller input, rather than relying on cancelled releases.
      await s.submit(s.human, { type: 'click', ...text });
      await s.submit(s.human, {
        type: 'sequence',
        steps: [
          { type: 'keyDown', key: 'a' },
          { type: 'keyUp', key: 'a' },
        ],
      });
      first.push(performance.now() - start);
      assert.equal(await s.tab.page.locator('#text').inputValue(), 'a');
      assert.equal(
        (await s.tab.page.evaluate(() => globalThis.fixture.inputState())).dragging,
        false
      );
      assert.equal(await s.tab.page.locator('#revision').textContent(), before);
      const events = await s.tab.page.evaluate(() => globalThis.fixture.inputEvents);
      assert.equal(events.filter((e) => e.type === 'keydown').at(-1).shift, false);
      const compositeReceipt = await composite;
      actionReceipts.push(compositeReceipt);
      assert.equal(compositeReceipt.outcome, 'aborted');
      outcomes.aborted++;
      const queuedReceipt = await queued;
      actionReceipts.push(queuedReceipt);
      assert.equal(queuedReceipt.outcome, 'rejected');
      outcomes.rejected++;
    }
    assert.ok(distribution('ack', 'ms', acks).p95 < 100);
    assert.ok(Math.max(...first) <= 2000);
    return {
      samples: rounds,
      subjectIds: [s.tab.tabId, s.browser.browserId, 'mechanics-agent', 'mechanics-human'],
      actionReceipts,
      measurements: [
        distribution('takeover-ack', 'ms', acks),
        distribution('first-human-input', 'ms', first),
        distribution('aborted-inflight', 'count', [outcomes.aborted]),
        distribution('rejected-queued', 'count', [outcomes.rejected]),
      ],
    };
  } finally {
    s.manager.dispatchInput = dispatch;
  }
}
/** Same actor before and after an epoch change isolates revocation from controller identity checks. */
export async function probeRevokedEpoch(s) {
  const point = await center(s.tab.page, '#increment');
  const old = s.request({ type: 'click', ...point });
  await s.control.takeover(s.human, s.tab.tabId).barrier;
  await s.control.handoff(s.human, s.tab.tabId, 'mechanics-agent').barrier;
  const before = await s.tab.page.locator('#revision').textContent();
  const receipt = await s.control.submit(s.agent, old);
  const after = await s.tab.page.locator('#revision').textContent();
  if (receipt.outcome === 'completed' && Number(after) === Number(before) + 1)
    assertObservation(false, 'revoked-epoch-executed');
  assert.equal(receipt.outcome, 'rejected');
  assert.equal(after, before);
  return { samples: 1 };
}
/** Queue refusal must happen before the ninth admitted operation can execute. */
export async function probeQueueBound(s) {
  const pending = Array.from({ length: 8 }, () => s.submit(s.agent, { type: 'wait', ms: 20 }));
  let refused = false;
  try {
    s.submit(s.agent, { type: 'wait', ms: 0 });
  } catch (error) {
    if (error.message !== 'queue-full') throw error;
    refused = true;
  }
  assertObservation(refused, 'unbounded-queue-admitted');
  await Promise.all(pending);
  return { samples: 9 };
}
/** Revoking a disconnected controller clears each real held-input kind before its successor acts. */
export async function probeDisconnectReset(s) {
  for (const kind of ['mouse', 'modifier', 'composition']) {
    const text = await center(s.tab.page, '#text');
    await s.tab.page.locator('#text').fill('');
    await s.submit(s.agent, { type: 'click', ...text });
    if (kind === 'composition') {
      await s.submit(s.agent, { type: 'composition', text: '仮' });
      assert.equal(await s.tab.page.locator('#text').inputValue(), '仮');
    } else {
      await s.submit(s.agent, { type: 'keyDown', key: 'Shift' });
      await s.submit(s.agent, {
        type: 'sequence',
        steps: [
          { type: 'mouseMove', ...(await center(s.tab.page, '#drag')) },
          { type: 'mouseDown', button: 'left' },
        ],
      });
      assert.equal(
        (await s.tab.page.evaluate(() => globalThis.fixture.inputState())).dragging,
        true
      );
    }
    const barriers = s.control.disconnect(s.agent);
    assert.equal(barriers.length, 1);
    await barriers[0].barrier;
    await s.control.acquire(s.human, s.tab.tabId).barrier;
    await s.submit(s.human, { type: 'click', ...text });
    await s.submit(s.human, {
      type: 'sequence',
      steps: [
        { type: 'keyDown', key: 'a' },
        { type: 'keyUp', key: 'a' },
      ],
    });
    assert.equal(await s.tab.page.locator('#text').inputValue(), 'a');
    assert.equal(
      (await s.tab.page.evaluate(() => globalThis.fixture.inputState())).dragging,
      false
    );
    assert.equal(
      (await s.tab.page.evaluate(() => globalThis.fixture.inputEvents))
        .filter((e) => e.type === 'keydown')
        .at(-1).shift,
      false
    );
    s.agent = s.control.issueParticipant({
      actorId: 'mechanics-agent',
      kind: 'agent',
      tabIds: [s.tab.tabId],
      canControl: true,
    });
    await s.control.handoff(s.human, s.tab.tabId, 'mechanics-agent').barrier;
  }
  return { samples: 3 };
}
