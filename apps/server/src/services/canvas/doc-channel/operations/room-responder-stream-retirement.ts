import { retireTestModeOriginalRoomResponderStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { retireClaudeOriginalRoomResponderStream } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { retireCodexOriginalRoomResponderStream } from '../../../runtimes/codex/codex-runtime.js';
import { retireOpenCodeOriginalRoomResponderStream } from '../../../runtimes/opencode/opencode-runtime.js';

/** Fixed original SDK cleanup attempts all owners; no caller-supplied closer or cause replacement. */
export async function retireOriginalRoomResponderStream(stream: object): Promise<void> {
  let failed = false,
    first: unknown;
  for (const retire of [
    retireClaudeOriginalRoomResponderStream,
    retireCodexOriginalRoomResponderStream,
    retireOpenCodeOriginalRoomResponderStream,
    retireTestModeOriginalRoomResponderStream,
  ]) {
    try {
      await retire(stream);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
}
