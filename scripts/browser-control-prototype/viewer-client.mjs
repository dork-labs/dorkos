import { createViewerPointer } from './viewer-pointer.mjs';

/* global document, window, requestAnimationFrame, createImageBitmap */

(() => {
  const byId = (id) => document.getElementById(id);
  const canvas = byId('screen');
  const context = canvas.getContext('2d');
  let token = null,
    tabId = null,
    viewerId = null,
    frame = null,
    state = null,
    connected = false,
    request = 0,
    pollGeneration = 0,
    abort = null,
    composing = false,
    pointer = null,
    actionTail = Promise.resolve(),
    pendingActions = 0,
    lastFrameAt = 0;
  const cursor = createViewerPointer(canvas, () => ({ frame, state, connected, lastFrameAt }));
  function status(text) {
    byId('status').textContent = text;
  }
  async function api(path, body, options = {}) {
    const { accessToken = token, ...fetchOptions } = options;
    const response = await fetch(path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...fetchOptions,
    });
    if (!response.ok) throw Error('Request refused (' + response.status + ')');
    return response;
  }
  function refreshIdentity(mode = '') {
    cursor.refresh();
    byId('identity').textContent = frame
      ? `Tab ${frame.tabId} · navigation ${frame.navigationGeneration} · viewport ${frame.viewportVersion} · frame ${frame.captureSequence} · ${mode} · controller ${state?.controllerId ?? 'none'} (${state?.status ?? 'unknown'})`
      : '';
  }
  function adoptState(next) {
    if (
      state &&
      (next.epoch < state.epoch ||
        (next.epoch === state.epoch && state.status === 'ready' && next.status === 'barrier'))
    )
      return;
    state = next;
  }
  async function updateState() {
    if (!token || !tabId) return;
    const requestedTab = tabId,
      generation = pollGeneration;
    const next = await (await api('/state', { tabId: requestedTab })).json();
    if (!connected || requestedTab !== tabId || generation !== pollGeneration) return state;
    adoptState(next);
    refreshIdentity();
    return state;
  }
  function action(action) {
    if (!connected || !frame || performance.now() - lastFrameAt > 2000)
      return Promise.reject(Error('Wait for a current connected view'));
    if (pendingActions >= 64) return Promise.reject(Error('Viewer input queue full'));
    pendingActions++;
    const captured = frame;
    const accessToken = token,
      generation = pollGeneration,
      deadline = performance.now() + 2000;
    const payload = {
      requestId: 'viewer-' + ++request,
      tabId,
      navigationGeneration: captured.navigationGeneration,
      viewportVersion: captured.viewportVersion,
      epoch: state?.epoch ?? captured.epoch,
      action,
    };
    const result = actionTail.then(async () => {
      if (!connected || generation !== pollGeneration) throw Error('View changed before input');
      if (state?.epoch !== payload.epoch || performance.now() >= deadline)
        throw Error('Queued input expired or control changed');
      const receipt = await (await api('/actions', payload, { accessToken })).json();
      if (receipt.outcome !== 'completed') throw Error('Input ' + receipt.outcome);
      return receipt;
    });
    actionTail = result.catch((error) => status(error.message));
    return result.finally(() => {
      pendingActions--;
    });
  }
  function point(event) {
    const rect = canvas.getBoundingClientRect();
    if (!frame || rect.width <= 0 || rect.height <= 0) return null;
    const x = ((event.clientX - rect.left) * frame.width) / rect.width,
      y = ((event.clientY - rect.top) * frame.height) / rect.height;
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
    return { x, y };
  }
  function handled(promise) {
    promise.catch((error) => status(error.message));
  }
  async function poll(generation) {
    let renderedReceipt = null;
    while (connected && generation === pollGeneration) {
      try {
        abort = new AbortController();
        const response = await api(
          '/frame',
          renderedReceipt ? { viewerId, receipt: renderedReceipt } : { viewerId },
          { signal: abort.signal }
        );
        const receipt = JSON.parse(response.headers.get('x-frame-receipt'));
        const nextState = JSON.parse(response.headers.get('x-control-state'));
        const bytes = await response.arrayBuffer();
        if (
          receipt.tabId !== tabId ||
          receipt.byteLength !== bytes.byteLength ||
          bytes.byteLength > 2 * 1024 * 1024 ||
          (frame && receipt.captureSequence <= frame.captureSequence)
        )
          throw Error('Frame identity refused');
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        if (!connected || generation !== pollGeneration) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (!connected || generation !== pollGeneration) return;
        frame = receipt;
        adoptState(nextState);
        lastFrameAt = performance.now();
        cursor.capture(JSON.parse(response.headers.get('x-input-pointer')), receipt);
        refreshIdentity(response.headers.get('x-browser-mode'));
        status('Connected');
        // This boundary follows decode, draw and paint; the next request carries its ACK.
        renderedReceipt = receipt;
      } catch (error) {
        if (connected && generation === pollGeneration) {
          status(error.message);
          frame = null;
          cursor.refresh();
          renderedReceipt = null;
          const previous = viewerId;
          viewerId = null;
          try {
            await api('/unsubscribe', { viewerId: previous });
          } catch {
            /* A lost subscription expires independently. */
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (!connected || generation !== pollGeneration) return;
          try {
            const subscription = await (await api('/subscribe', { tabId })).json();
            if (!connected || generation !== pollGeneration) {
              await api('/unsubscribe', { viewerId: subscription.viewerId });
              return;
            }
            viewerId = subscription.viewerId;
            adoptState(subscription.control);
          } catch (recoveryError) {
            status(recoveryError.message);
          }
        }
      }
    }
  }
  async function disconnect() {
    connected = false;
    cursor.refresh();
    pollGeneration++;
    abort?.abort();
    if (viewerId && token) {
      const id = viewerId;
      viewerId = null;
      try {
        await api('/unsubscribe', { viewerId: id });
      } catch {
        /* Closing a view remains local even if its transport is gone. */
      }
    }
    status('Disconnected');
  }
  async function connect(options) {
    await disconnect();
    token = options.token;
    tabId = options.tabId;
    frame = null;
    state = null;
    byId('token').value = '';
    const result = await (await api('/subscribe', { tabId })).json();
    viewerId = result.viewerId;
    state = result.control;
    connected = true;
    poll(++pollGeneration);
  }
  window.viewer = {
    connect,
    disconnect,
    current: () => frame && { ...frame },
    controlState: () => state && { ...state },
    send: action,
  };
  byId('connect-form').onsubmit = (event) => {
    event.preventDefault();
    handled(connect({ token: byId('token').value, tabId: byId('tab').value }));
  };
  for (const [id, op] of [
    ['acquire', 'acquire'],
    ['takeover', 'takeover'],
    ['handoff', 'handoff'],
  ])
    byId(id).onclick = () =>
      handled(
        (async () => {
          const body = { tabId, op };
          if (op === 'handoff') body.targetActorId = byId('target').value;
          const transition = await (await api('/control', body)).json();
          adoptState({ ...state, ...transition });
          cursor.refresh();
          status('Waiting for input reset');
          for (let i = 0; i < 45; i++) {
            await updateState();
            if (state.status !== 'barrier') break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          status(state.status === 'ready' ? 'Control ready' : 'Browser stopped');
        })()
      );
  byId('close-view').onclick = () => handled(disconnect());
  byId('revoke').onclick = () =>
    handled(
      (async () => {
        await api('/disconnect-control', {});
        await disconnect();
        token = null;
      })()
    );
  canvas.onpointerdown = (event) => {
    const p = point(event);
    if (!p) return;
    event.preventDefault();
    canvas.focus();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      status('Pointer capture unavailable');
    }
    pointer = {
      id: event.pointerId,
      type: event.pointerType,
      last: p,
      start: p,
      button: ['left', 'middle', 'right'][event.button] ?? 'left',
    };
    if (event.pointerType === 'touch') return;
    const pointerStarted = action({
      type: 'sequence',
      steps: [
        { type: 'mouseMove', ...p },
        { type: 'mouseDown', button: ['left', 'middle', 'right'][event.button] ?? 'left' },
      ],
    });
    handled(pointerStarted);
  };
  canvas.onpointermove = (event) => {
    const p = point(event);
    if (!p || !pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    if (pointer.type === 'touch') {
      const dx = pointer.last.x - p.x,
        dy = pointer.last.y - p.y;
      if (Math.abs(dx) + Math.abs(dy) > 0)
        handled(
          action({
            type: 'sequence',
            steps: [
              { type: 'mouseMove', ...p },
              { type: 'wheel', deltaX: dx, deltaY: dy },
            ],
          })
        );
    } else handled(action({ type: 'mouseMove', ...p }));
    pointer.last = p;
  };
  canvas.onpointerup = (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const p = point(event);
    if (pointer.type === 'touch') {
      if (p && Math.abs(pointer.start.x - p.x) + Math.abs(pointer.start.y - p.y) < 5)
        handled(action({ type: 'touch', ...p }));
    } else
      handled(
        action({
          type: 'mouseUp',
          button: pointer.button,
        })
      );
    pointer = null;
  };
  canvas.onpointercancel = () => {
    if (pointer && pointer.type !== 'touch')
      handled(action({ type: 'mouseUp', button: pointer.button }));
    pointer = null;
  };
  canvas.onlostpointercapture = canvas.onpointercancel;
  canvas.onwheel = (event) => {
    if (!frame) return;
    event.preventDefault();
    const p = point(event);
    if (p)
      handled(
        action({
          type: 'sequence',
          steps: [
            { type: 'mouseMove', ...p },
            {
              type: 'wheel',
              deltaX: Math.max(-16384, Math.min(16384, event.deltaX)),
              deltaY: Math.max(-16384, Math.min(16384, event.deltaY)),
            },
          ],
        })
      );
  };
  canvas.oncontextmenu = (event) => event.preventDefault();
  const keys = new Set([
    'Shift',
    'Control',
    'Alt',
    'Meta',
    'Enter',
    'Backspace',
    'Delete',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Escape',
  ]);
  function keyboard(event, type) {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape' && event.target === canvas) {
      event.preventDefault();
      byId('close-view').focus();
      return;
    }
    if ((event.ctrlKey || event.metaKey || event.altKey) && event.key.length === 1) {
      event.preventDefault();
      if (!event.repeat) handled(action({ type, key: event.key }));
      return;
    }
    if (keys.has(event.key)) {
      event.preventDefault();
      if (!event.repeat) handled(action({ type, key: event.key }));
    } else if (
      type === 'keyDown' &&
      event.target === canvas &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      handled(action({ type: 'text', text: event.key }));
    }
  }
  for (const target of [canvas, byId('text-input')]) {
    target.onkeydown = (event) => keyboard(event, 'keyDown');
    target.onkeyup = (event) => keyboard(event, 'keyUp');
  }
  const text = byId('text-input');
  text.onbeforeinput = (event) => {
    if (event.isComposing || composing) return;
    if (event.inputType === 'insertText' && event.data) {
      event.preventDefault();
      handled(action({ type: 'text', text: event.data }));
    }
  };
  text.addEventListener('compositionstart', () => {
    composing = true;
  });
  text.addEventListener('compositionupdate', (event) =>
    handled(action({ type: 'composition', text: event.data ?? '' }))
  );
  text.addEventListener('compositionend', (event) => {
    composing = false;
    handled(action({ type: 'compositionCommit', text: event.data ?? '' }));
    text.value = '';
  });
  text.onpaste = (event) => {
    event.preventDefault();
    const value = event.clipboardData?.getData('text/plain');
    if (value !== undefined) handled(action({ type: 'text', text: value }));
  };
  byId('paste').onclick = () =>
    handled(
      (async () => {
        try {
          const value = await navigator.clipboard.readText();
          await action({ type: 'text', text: value });
          byId('clipboard').textContent = 'Paste sent';
        } catch {
          byId('clipboard').textContent = 'Clipboard read denied or input refused';
        }
      })()
    );
  byId('copy').onclick = () =>
    handled(
      (async () => {
        try {
          if (!frame) throw Error('No frame');
          const result = await (
            await api('/selection', {
              tabId,
              navigationGeneration: frame.navigationGeneration,
              viewportVersion: frame.viewportVersion,
            })
          ).json();
          await navigator.clipboard.writeText(result.text);
          byId('clipboard').textContent = 'Selection copied';
        } catch {
          byId('clipboard').textContent = 'Clipboard write denied or page selection stale';
        }
      })()
    );
  async function semantic() {
    const result = await (await api('/semantic', { tabId })).json();
    if (
      frame &&
      (result.navigationGeneration !== frame.navigationGeneration ||
        result.viewportVersion !== frame.viewportVersion)
    )
      throw Error('Page structure is stale');
    byId('snapshot').textContent =
      result.snapshot + (result.truncated ? '\nSnapshot truncated' : '');
    byId('focused').textContent = 'Focused page element: ' + result.focused;
  }
  byId('semantic').onclick = () => handled(semantic());
  for (const [id, steps] of [
    [
      'next',
      [
        { type: 'keyDown', key: 'Tab' },
        { type: 'keyUp', key: 'Tab' },
      ],
    ],
    [
      'previous',
      [
        { type: 'keyDown', key: 'Shift' },
        { type: 'keyDown', key: 'Tab' },
        { type: 'keyUp', key: 'Tab' },
        { type: 'keyUp', key: 'Shift' },
      ],
    ],
    [
      'activate',
      [
        { type: 'keyDown', key: 'Enter' },
        { type: 'keyUp', key: 'Enter' },
      ],
    ],
  ])
    byId(id).onclick = () =>
      handled(
        (async () => {
          await action({ type: 'sequence', steps });
          await semantic();
        })()
      );
  window.addEventListener('pagehide', () => {
    if (viewerId && token)
      fetch('/unsubscribe', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewerId }),
        keepalive: true,
      }).catch(() => {});
  });
  setInterval(() => {
    if (connected && lastFrameAt && performance.now() - lastFrameAt > 2000)
      status('View stale: waiting for a new frame');
  }, 500);
})();
