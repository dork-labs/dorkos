/**
 * The card copy for a stopped server half (DOR-2686) is one source for the
 * server and the app: every code has a sentence within the app-copy cap, and
 * a code it does not own gets none, so the card keeps its own wording there.
 */
import { describe, it, expect } from 'vitest';
import {
  EXTENSION_SERVER_ERROR_CODES,
  extensionRestartingCopy,
  extensionServerErrorCopy,
  isExtensionServerErrorCode,
} from '../extension-server-status.js';

/** Words as the copy-length gate counts them: tokens with a letter or digit. */
function words(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

describe('extension server status copy', () => {
  // Purpose: each code names the extension and stays within 15 words.
  it.each(EXTENSION_SERVER_ERROR_CODES)('%s has a short sentence naming the extension', (code) => {
    const line = extensionServerErrorCopy(code, 'Mail');
    expect(line).toMatch(/^Mail /);
    expect(words(line!)).toBeLessThanOrEqual(15);
    expect(isExtensionServerErrorCode(code)).toBe(true);
  });

  // Purpose: a rebuild failure is not this map's to word.
  it('owns no other code', () => {
    expect(extensionServerErrorCopy('compilation_failed', 'Mail')).toBeNull();
    expect(isExtensionServerErrorCode('compilation_failed')).toBe(false);
  });

  // Purpose: the restart line names the extension.
  it('says which extension is restarting', () => {
    expect(extensionRestartingCopy('Mail')).toBe('Restarting Mail…');
  });
});
