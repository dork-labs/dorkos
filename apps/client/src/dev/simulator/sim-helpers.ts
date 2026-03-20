import type { SimStep } from './sim-types';

/**
 * Generate a sequence of stream_text_chunk steps for one text block.
 *
 * Splits text at word boundaries and groups ~4 words per chunk to simulate
 * realistic LLM token streaming where several words arrive at once.
 *
 * @param messageId - Target message to append text to
 * @param text - Full text to stream
 * @param wordsPerChunk - Approximate words per chunk (default 4)
 * @param delayMs - Milliseconds between chunks (default 100)
 */
export function buildStreamingTextSteps(
  messageId: string,
  text: string,
  wordsPerChunk = 4,
  delayMs = 100,
): SimStep[] {
  const steps: SimStep[] = [];
  // Split preserving whitespace tokens so we can reconstruct exactly
  const tokens = text.split(/(\s+)/);
  let buffer = '';
  let wordCount = 0;

  for (const token of tokens) {
    buffer += token;
    // Count non-whitespace tokens as words
    if (/\S/.test(token)) wordCount++;

    if (wordCount >= wordsPerChunk) {
      steps.push({
        type: 'stream_text_chunk',
        messageId,
        text: buffer,
        delayMs,
      });
      buffer = '';
      wordCount = 0;
    }
  }

  // Flush remainder without delay (nothing follows)
  if (buffer) {
    steps.push({
      type: 'stream_text_chunk',
      messageId,
      text: buffer,
    });
  }

  return steps;
}
