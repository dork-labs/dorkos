// This expression is constant. It executes only in a broker-created isolated world.
const selectionExpression = `(() => {
  const active = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get.call(document);
  let text;
  if (!active || active instanceof HTMLIFrameElement || active.shadowRoot) return { password: null };
  if (active instanceof HTMLInputElement) {
    const native = (name) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, name).get.call(active);
    const type = native('type');
    if (type === 'password') return { password: true };
    if (!['text','search','url','tel','email'].includes(type)) return { password: null };
    const start = native('selectionStart'), end = native('selectionEnd');
    if (start === null || end === null) return { password: null };
    text = native('value').slice(start, end);
  } else if (active instanceof HTMLTextAreaElement) {
    const native = (name) => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, name).get.call(active);
    text = native('value').slice(native('selectionStart'), native('selectionEnd'));
  } else {
    text = window.getSelection()?.toString() ?? '';
  }
  const bytes = new TextEncoder().encode(text.slice(0, 65536));
  return { text: new TextDecoder().decode(bytes.subarray(0, 65536), { stream: true }), password: false };
})()`;

/** No agent observation API or cache participates in this person-only read. */
export async function readViewerSelection(port: {
  contextId: number;
  readFixedExpression(params: Record<string, unknown>): Promise<unknown>;
  assertPersonControl(): void;
}): Promise<string> {
  port.assertPersonControl();
  if (!Number.isSafeInteger(port.contextId) || port.contextId <= 0) throw Error('viewer_denied');
  const result = (await port.readFixedExpression({
    expression: selectionExpression,
    contextId: port.contextId,
    returnByValue: true,
    awaitPromise: false,
    disableBreaks: true,
  })) as {
    result?: { value?: { text?: unknown; password?: unknown } };
    exceptionDetails?: unknown;
  };
  port.assertPersonControl();
  const value = result.result?.value;
  if (
    result.exceptionDetails ||
    value?.password !== false ||
    typeof value.text !== 'string' ||
    Buffer.byteLength(value.text, 'utf8') > 65_536
  )
    throw Error('viewer_denied');
  return value.text;
}
