import assert from 'node:assert/strict';
import { distribution, viewerPoint, cleanupLifo } from './mechanics-helpers.mjs';
import { injectRtt } from './mechanics-transport.mjs';
import { canonicalHash } from './mechanics-pixels.mjs';
import { instrumentRenderBoundary } from './mechanics-render-instrument.mjs';
export async function probeLatency(s, { samples = 100, rttMs = 0, stall = false } = {}) {
  const captures = [],
    bytes = [];
  const capture = s.manager.capture.bind(s.manager);
  s.manager.capture = async (...args) => {
    const start = performance.now();
    const result = await capture(...args);
    captures.push(performance.now() - start);
    bytes.push(result.bytes.length);
    return result;
  };
  let slowId, leaseTimer, view, transport, primaryFailure;
  const latencies = [];
  const cleanups = [
    () => {
      s.manager.capture = capture;
    },
  ];
  const headers = { Authorization: `Bearer ${s.human}`, Origin: s.viewer.url };
  async function api(path, body) {
    return fetch(s.viewer.url + path, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  try {
    view = await s.open();
    await view.getByRole('button', { name: 'Take control' }).click();
    await view.waitForFunction(
      () =>
        globalThis.viewer.controlState()?.status === 'ready' &&
        globalThis.viewer.controlState()?.controllerId === 'mechanics-human'
    );
    await instrumentRenderBoundary(view);
    if (rttMs) {
      transport = await injectRtt(view, rttMs);
      cleanups.push(() => transport.close());
    }
    const baselineDrops = s.viewer.stats().dropped;
    if (stall) {
      const subscribed = await (await api('/subscribe', { tabId: s.tab.tabId })).json();
      slowId = subscribed.viewerId;
      cleanups.push(async () => {
        const response = await api('/unsubscribe', { viewerId: slowId });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      });
      const first = await api('/frame', { viewerId: slowId });
      assert.equal(first.status, 200);
      await first.arrayBuffer();
      // Refresh retained subscription without acknowledging the rendered frame. 409 is expected.
      leaseTimer = setInterval(
        () =>
          api('/frame', { viewerId: slowId })
            .then((r) => r.arrayBuffer())
            .catch(() => {}),
        700
      );
      cleanups.push(() => clearInterval(leaseTimer));
    }
    await view.evaluate(() => (globalThis.measured.acks.length = 0));
    captures.length = 0;
    bytes.length = 0;
    const start = performance.now();
    let maxPending = 0,
      maxBytes = 0,
      stallObservations = 0;
    for (let i = 0; i < samples || (stall && performance.now() - start < 10000); i++) {
      if (transport?.error()) throw transport.error();
      const before = Number(await s.tab.page.locator('#revision').textContent());
      const point = await viewerPoint(view, s.manager.getTab(s.tab.tabId), '#increment');
      await view.mouse.click(point.x, point.y);
      await s.tab.page.waitForFunction(
        (n) => Number(globalThis.document.querySelector('#revision').textContent) === n,
        before + 1
      );
      const expected = await canonicalHash(view, s.manager.getTab(s.tab.tabId));
      await view.waitForFunction(
        (hash) =>
          globalThis.measured.acks.some(
            (a) => a.hash === hash && a.time >= globalThis.measured.inputAt
          ),
        expected,
        { timeout: 4000 }
      );
      const measured = await view.evaluate((hash) => {
        const m = globalThis.measured;
        const ack = m.acks.find((a) => a.hash === hash && a.time >= m.inputAt);
        return { elapsed: ack.time - m.inputAt, receipt: ack.receipt };
      }, expected);
      assert.equal(measured.receipt.tabId, s.tab.tabId);
      assert.equal(measured.receipt.width, 1280);
      assert.equal(measured.receipt.height, 720);
      latencies.push(measured.elapsed);
      if (slowId) {
        const state = s.viewer.stats().viewerStates.find((v) => v.viewerId === slowId);
        assert.ok(state, 'SLOW_VIEWER_EVICTED');
        maxPending = Math.max(maxPending, state.pendingFrames);
        maxBytes = Math.max(maxBytes, state.pendingBytes);
        assert.ok(state.pendingFrames <= 1);
        assert.ok(state.pendingBytes <= 2 * 1024 * 1024);
        stallObservations++;
      }
    }
    const elapsed = performance.now() - start;
    const latency = distribution(rttMs ? 'render-synthetic-rtt' : 'render-local', 'ms', latencies);

    if (stall) {
      assert.ok(elapsed >= 10000);
      assert.equal(maxPending, 1);
      assert.ok(stallObservations > 0);
    }
    const deliveredBytes = await view.evaluate(() =>
      globalThis.measured.acks.reduce((sum, ack) => sum + ack.receipt.byteLength, 0)
    );
    const result = {
      samples: latencies.length,
      subjectIds: [s.tab.tabId, s.browser.browserId],
      measurements: [
        latency,
        distribution('capture-and-jpeg', 'ms', captures),
        distribution('jpeg-payload', 'bytes', bytes),
        distribution('capture-produced-jpeg-rate', 'bytes/s', [
          bytes.reduce((a, b) => a + b, 0) / (elapsed / 1000),
        ]),
        distribution('acknowledged-jpeg-delivery-rate', 'bytes/s', [
          deliveredBytes / (elapsed / 1000),
        ]),
        distribution('dropped-frames', 'count', [s.viewer.stats().dropped - baselineDrops]),
        ...(stall
          ? [
              distribution('slow-viewer-duration', 'ms', [elapsed]),
              distribution('slow-max-pending', 'count', [maxPending]),
              distribution('slow-max-bytes', 'bytes', [maxBytes]),
            ]
          : []),
      ],
    };
    try {
      assert.ok(latency.p95 < (rttMs ? 600 : 250), 'INPUT_TO_RENDER_P95');
    } catch (error) {
      error.result = result;
      throw error;
    }
    return result;
  } catch (error) {
    primaryFailure = error;
    error.failureCode =
      error instanceof assert.AssertionError
        ? 'render-assertion'
        : error.name === 'TimeoutError'
          ? 'render-wait-timeout'
          : 'render-infrastructure';
    error.result ??= {
      samples: latencies.length,
      subjectIds: [s.tab.tabId, s.browser.browserId],
      measurements: latencies.length
        ? [
            distribution(
              rttMs ? 'render-synthetic-rtt-partial' : 'render-local-partial',
              'ms',
              latencies
            ),
          ]
        : [],
    };
    throw error;
  } finally {
    await cleanupLifo(cleanups, primaryFailure);
  }
}
