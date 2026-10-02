import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { LIMITS, validateFrameReceipt } from './contracts.mjs';

const html = await readFile(new URL('./viewer-page.html', import.meta.url));
const client = await readFile(new URL('./viewer-client.mjs', import.meta.url));
const pointerClient = await readFile(new URL('./viewer-pointer.mjs', import.meta.url));
const FRAME_BUDGET = LIMITS.maxFrameBytes - 4096;
function fail(code) {
  throw Error(code);
}
function exact(value, keys) {
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k))
  );
}
async function body(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > LIMITS.maxActionBytes) fail('payload-limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Optional local pixel viewers; subscription lifetime never owns browser/control lifetime. */
export async function startViewer({
  manager,
  createControl,
  port = 0,
  frameIntervalMs = 80,
  maxViewers = 8,
}) {
  if (
    typeof createControl !== 'function' ||
    !Number.isInteger(frameIntervalMs) ||
    frameIntervalMs < 20 ||
    frameIntervalMs > 1000 ||
    !Number.isInteger(maxViewers) ||
    maxViewers < 1 ||
    maxViewers > 32
  )
    fail('invalid-config');
  const viewers = new Map();
  const tabs = new Map();
  const renderAcks = [];
  let origin,
    control,
    closed = false;
  const metrics = {
    captures: 0,
    rendered: 0,
    acksDropped: 0,
    dropped: 0,
    wrongFrames: 0,
    oversizedFrames: 0,
    maxPendingBytes: 0,
    maxWritableBytes: 0,
  };
  function remove(viewer) {
    if (!viewer) return;
    viewers.delete(viewer.id);
    viewer.pending = null;
    if (viewer.response) {
      viewer.response.writeHead(410);
      viewer.response.end();
      viewer.response = null;
    }
    const tab = tabs.get(viewer.tabId);
    if (tab && !subscribers(viewer.tabId).length) {
      clearTimeout(tab.timer);
    }
  }
  function subscribers(tabId) {
    return [...viewers.values()].filter((v) => v.tabId === tabId);
  }
  function tabState(tabId) {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { paused: false, timer: null, capturing: null };
      tabs.set(tabId, tab);
    }
    return tab;
  }
  function send(viewer) {
    if (!viewer.response || !viewer.pending || viewer.awaiting || viewer.writing) return;
    const response = viewer.response;
    const frame = viewer.pending;
    viewer.response = null;
    viewer.pending = null;
    viewer.awaiting = frame.receipt;
    viewer.sentAt = performance.now();
    viewer.writing = response;
    response.writeHead(200, {
      'content-type': 'image/jpeg',
      'content-length': frame.bytes.length,
      'cache-control': 'no-store',
      'x-frame-receipt': JSON.stringify(frame.receipt),
      'x-control-state': JSON.stringify(control.state(viewer.tabId)),
      'x-input-pointer': JSON.stringify(frame.pointer ?? null),
      'x-browser-mode':
        manager.listBrowsers().find((b) => b.browserId === frame.receipt.browserId)?.mode ??
        'unknown',
    });
    response.end(frame.bytes);
    metrics.maxWritableBytes = Math.max(metrics.maxWritableBytes, response.writableLength);
    response.once('finish', () => {
      viewer.writing = null;
    });
    response.once('close', () => {
      viewer.writing = null;
      if (!response.writableFinished) remove(viewer);
    });
  }
  function publish(tabId, frame) {
    validateFrameReceipt(frame.receipt);
    const canonical = manager.getTab(tabId);
    if (
      frame.receipt.tabId !== tabId ||
      frame.receipt.browserId !== canonical.browserId ||
      frame.receipt.navigationGeneration !== canonical.navigationGeneration ||
      frame.receipt.viewportVersion !== canonical.viewportVersion ||
      frame.receipt.width !== canonical.viewport.width ||
      frame.receipt.height !== canonical.viewport.height
    ) {
      metrics.wrongFrames++;
      fail('frame-identity');
    }
    if (
      !Buffer.isBuffer(frame.bytes) ||
      frame.bytes.length !== frame.receipt.byteLength ||
      frame.bytes.length > FRAME_BUDGET
    ) {
      metrics.oversizedFrames++;
      fail('frame-size');
    }
    if (
      frame.pointer &&
      (!exact(frame.pointer, ['tabId', 'navigationGeneration', 'viewportVersion', 'x', 'y']) ||
        ['tabId', 'navigationGeneration', 'viewportVersion'].some(
          (key) => frame.pointer[key] !== frame.receipt[key]
        ) ||
        !Number.isFinite(frame.pointer.x) ||
        !Number.isFinite(frame.pointer.y) ||
        frame.pointer.x < 0 ||
        frame.pointer.y < 0 ||
        frame.pointer.x >= frame.receipt.width ||
        frame.pointer.y >= frame.receipt.height)
    )
      fail('pointer-identity');
    const tab = tabState(tabId);
    if (tab.lastSequence !== undefined && frame.receipt.captureSequence <= tab.lastSequence)
      fail('frame-sequence');
    tab.lastSequence = frame.receipt.captureSequence;
    for (const viewer of subscribers(tabId)) {
      if (viewer.writing) {
        metrics.dropped++;
        continue;
      }
      if (viewer.pending) metrics.dropped++;
      viewer.pending = frame;
      metrics.maxPendingBytes = Math.max(metrics.maxPendingBytes, frame.bytes.length);
      send(viewer);
    }
  }
  async function capture(tabId) {
    const tab = tabState(tabId);
    if (closed || tab.paused || !subscribers(tabId).length || tab.capturing) return;
    tab.capturing = (async () => {
      try {
        const frame = await manager.capture(tabId, { epoch: control.state(tabId).epoch });
        metrics.captures++;
        publish(tabId, frame);
      } catch {
        for (const viewer of subscribers(tabId)) {
          if (viewer.response) {
            json(viewer.response, 409, { error: 'capture-failed' });
            viewer.response = null;
          }
        }
      }
    })();
    try {
      await tab.capturing;
    } finally {
      tab.capturing = null;
      if (!closed && !tab.paused && subscribers(tabId).length)
        tab.timer = setTimeout(() => capture(tabId), frameIntervalMs);
    }
  }
  function acknowledge(viewer, receipt) {
    validateFrameReceipt(receipt);
    if (!viewer.awaiting || JSON.stringify(receipt) !== JSON.stringify(viewer.awaiting))
      fail('ack-denied');
    metrics.rendered++;
    viewer.renderMs = performance.now() - viewer.sentAt;
    if (renderAcks.length === 1024) {
      renderAcks.shift();
      metrics.acksDropped++;
    }
    renderAcks.push({
      viewerId: viewer.id,
      receipt: { ...viewer.awaiting },
      renderMs: viewer.renderMs,
    });
    viewer.awaiting = null;
  }
  async function handle(request, response) {
    const path = request.url;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (
      request.headers.host !== new URL(origin).host ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      json(response, 403, { error: 'origin-denied' });
      return;
    }
    if (request.method === 'GET' && ['/viewer-client.mjs', '/viewer-pointer.mjs'].includes(path)) {
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      response.end(path === '/viewer-client.mjs' ? client : pointerClient);
      return;
    }
    if (request.method === 'GET' && path === '/') {
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
      return;
    }
    if (request.method !== 'POST') {
      json(response, 405, { error: 'method-denied' });
      return;
    }
    let token;
    try {
      token = control.authorizeRequest({
        authorization: request.headers.authorization,
        origin: request.headers.origin,
      });
    } catch {
      json(response, 403, { error: 'unauthorized' });
      return;
    }
    let input;
    try {
      input = await body(request);
    } catch {
      json(response, 400, { error: 'invalid-request' });
      return;
    }
    try {
      if (path === '/subscribe') {
        if (!exact(input, ['tabId'])) fail('invalid-request');
        control.authorizeView(token, input.tabId);
        if (viewers.size >= maxViewers) {
          json(response, 429, { error: 'viewer-limit' });
          return;
        }
        const viewer = {
          id: randomUUID(),
          token,
          tabId: input.tabId,
          pending: null,
          response: null,
          awaiting: null,
          writing: null,
          lastSeen: performance.now(),
        };
        viewers.set(viewer.id, viewer);
        json(response, 200, { viewerId: viewer.id, control: control.state(input.tabId) });
        capture(input.tabId);
        return;
      }
      if (path === '/actions') {
        const receipt = await control.submit(token, input);
        json(response, 200, receipt);
        return;
      }
      if (path === '/control') {
        if (!exact(input, ['tabId', 'op']) && !exact(input, ['tabId', 'op', 'targetActorId']))
          fail('invalid-request');
        const methods = {
          acquire: () => control.acquire(token, input.tabId),
          takeover: () => control.takeover(token, input.tabId),
          handoff: () => control.handoff(token, input.tabId, input.targetActorId),
        };
        if (!Object.hasOwn(methods, input.op)) fail('invalid-request');
        const result = methods[input.op]();
        json(response, 200, { epoch: result.epoch, status: 'barrier' });
        return;
      }
      if (path === '/state') {
        if (!exact(input, ['tabId'])) fail('invalid-request');
        control.authorizeView(token, input.tabId);
        json(response, 200, control.state(input.tabId));
        return;
      }
      if (path === '/selection') {
        if (!exact(input, ['tabId', 'navigationGeneration', 'viewportVersion']))
          fail('invalid-request');
        control.authorizeView(token, input.tabId);
        const tab = manager.getTab(input.tabId);
        if (
          tab.navigationGeneration !== input.navigationGeneration ||
          tab.viewportVersion !== input.viewportVersion
        )
          fail('selection-stale');
        const text = await tab.page.evaluate(() => {
          const active = globalThis.document.activeElement;
          return typeof active?.value === 'string' && Number.isInteger(active.selectionStart)
            ? active.value.slice(active.selectionStart, active.selectionEnd).slice(0, 2048)
            : (globalThis.getSelection()?.toString() ?? '').slice(0, 2048);
        });
        const current = manager.getTab(input.tabId);
        if (
          current.navigationGeneration !== input.navigationGeneration ||
          current.viewportVersion !== input.viewportVersion
        )
          fail('selection-stale');
        json(response, 200, { text });
        return;
      }
      if (path === '/semantic') {
        if (!exact(input, ['tabId'])) fail('invalid-request');
        control.authorizeView(token, input.tabId);
        const tab = manager.getTab(input.tabId);
        const identity = {
          tabId: tab.tabId,
          navigationGeneration: tab.navigationGeneration,
          viewportVersion: tab.viewportVersion,
        };
        const snapshot = await tab.page.locator('body').ariaSnapshot({ timeout: 1000 });
        let focused = 'No page element focused';
        try {
          focused = await tab.page.locator(':focus').ariaSnapshot({ timeout: 100 });
        } catch {
          /* No focus is a valid page state. */
        }
        const current = manager.getTab(input.tabId);
        if (
          current.navigationGeneration !== identity.navigationGeneration ||
          current.viewportVersion !== identity.viewportVersion
        )
          fail('semantic-stale');
        json(response, 200, {
          ...identity,
          snapshot: snapshot.slice(0, 12000),
          focused: focused.slice(0, 1000),
          truncated: snapshot.length > 12000,
        });
        return;
      }
      if (path === '/disconnect-control') {
        if (!exact(input, [])) fail('invalid-request');
        control.disconnect(token);
        for (const active of [...viewers.values()]) if (active.token === token) remove(active);
        json(response, 200, { status: 'revoked' });
        return;
      }
      if (
        !exact(input, path === '/ack' ? ['viewerId', 'receipt'] : ['viewerId']) &&
        !(path === '/frame' && exact(input, ['viewerId', 'receipt']))
      )
        fail('invalid-request');
      const viewer = viewers.get(input.viewerId);
      if (!viewer || viewer.token !== token) fail('viewer-denied');
      control.authorizeView(token, viewer.tabId);
      viewer.lastSeen = performance.now();
      if (path === '/unsubscribe') {
        remove(viewer);
        json(response, 200, { status: 'disconnected' });
        return;
      }
      if (path === '/ack') {
        acknowledge(viewer, input.receipt);
        json(response, 200, { status: 'rendered' });
        send(viewer);
        return;
      }
      if (path === '/frame') {
        if (viewer.response || viewer.writing) {
          json(response, 409, { error: 'frame-in-flight' });
          return;
        }
        if (Object.hasOwn(input, 'receipt')) acknowledge(viewer, input.receipt);
        if (viewer.awaiting) {
          json(response, 409, { error: 'frame-in-flight' });
          return;
        }
        viewer.response = response;
        response.once('close', () => {
          if (viewer.response === response) {
            viewer.response = null;
            remove(viewer);
          }
        });
        send(viewer);
        if (!tabState(viewer.tabId).timer) capture(viewer.tabId);
        return;
      }
      json(response, 404, { error: 'route-missing' });
    } catch {
      json(response, 403, { error: 'request-denied' });
    }
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'viewer-failed' });
      else res.destroy();
    });
  });
  server.requestTimeout = 2500;
  server.headersTimeout = 2500;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    control = createControl(origin);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  const sweep = setInterval(() => {
    for (const viewer of viewers.values())
      if (performance.now() - viewer.lastSeen > 2500) remove(viewer);
  }, 500);
  return {
    url: origin,
    control,
    stats: () => ({
      ...metrics,
      viewers: viewers.size,
      pendingFrames: [...viewers.values()].filter((v) => v.pending).length,
      renderMs: [...viewers.values()].map((v) => v.renderMs).filter(Number.isFinite),
      renderAcks: renderAcks.map((ack) => ({ ...ack, receipt: { ...ack.receipt } })),
      viewerStates: [...viewers.values()].map((v) => ({
        viewerId: v.id,
        pendingFrames: v.pending ? 1 : 0,
        pendingBytes: v.pending?.bytes.length ?? 0,
        writableBytes: v.writing?.writableLength ?? 0,
      })),
    }),
    publish,
    async pauseCapture(tabId) {
      const tab = tabState(tabId);
      tab.paused = true;
      clearTimeout(tab.timer);
      await tab.capturing;
    },
    resumeCapture(tabId) {
      const tab = tabState(tabId);
      tab.paused = false;
      capture(tabId);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const tab of tabs.values()) clearTimeout(tab.timer);
      for (const viewer of [...viewers.values()]) remove(viewer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await Promise.all([...tabs.values()].map((tab) => tab.capturing));
    },
  };
}
