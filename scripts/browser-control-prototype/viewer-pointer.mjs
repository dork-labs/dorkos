/* global document, window */

/** A cursor overlay reports captured browser input, independently of the operator's local cursor. */
export function createViewerPointer(canvas, current) {
  const marker = document.createElement('span');
  marker.id = 'browser-pointer';
  marker.hidden = true;
  marker.setAttribute('aria-hidden', 'true');
  canvas.parentElement.append(marker);
  let captured = null;
  function refresh() {
    const { frame, state, connected, lastFrameAt } = current();
    const pointer = captured?.pointer,
      receipt = captured?.receipt;
    marker.hidden = true;
    if (
      !connected ||
      !frame ||
      !pointer ||
      !receipt ||
      !state ||
      state.status !== 'ready' ||
      performance.now() - lastFrameAt > 2000 ||
      state.epoch !== receipt.epoch ||
      frame.captureSequence !== receipt.captureSequence ||
      ['tabId', 'navigationGeneration', 'viewportVersion'].some(
        (key) => pointer[key] !== frame[key]
      ) ||
      !Number.isFinite(pointer.x) ||
      !Number.isFinite(pointer.y) ||
      pointer.x < 0 ||
      pointer.y < 0 ||
      pointer.x >= frame.width ||
      pointer.y >= frame.height
    )
      return;
    const rect = canvas.getBoundingClientRect(),
      parent = canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    marker.style.left = rect.left - parent.left + (pointer.x * rect.width) / frame.width + 'px';
    marker.style.top = rect.top - parent.top + (pointer.y * rect.height) / frame.height + 'px';
    marker.hidden = false;
  }
  window.addEventListener('resize', refresh);
  setInterval(refresh, 100);
  return {
    capture(pointer, receipt) {
      captured = { pointer, receipt };
      refresh();
    },
    refresh,
  };
}
