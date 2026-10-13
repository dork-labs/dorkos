/** Bound guest JSON bytes before allocating an entire response body. */
export async function readBoundedJson(
  response: Response,
  maxBytes = 16 * 1024 * 1024
): Promise<unknown> {
  if (!response.body) throw new Error('COMPUTER_RESPONSE_EMPTY');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error('COMPUTER_RESPONSE_LIMIT');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
