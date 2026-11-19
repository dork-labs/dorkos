import type { SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { CodexTurnRequest } from '../transport/codex-transport.js';

/** Keep the turn's verified fallback local when a newer durable choice owns the next turn. */
export function prepareModelReplacement(
  port: SessionSettingsPort | undefined,
  sessionId: string,
  tracked: string | undefined,
  selected: string | undefined,
  mirror: (model: string) => void
): Pick<CodexTurnRequest, 'onModelReplacement'> {
  try {
    const snapshot = port?.captureCodexModel?.(sessionId);
    if (!snapshot) return {};
    // A tracked value may lag a concurrent PATCH. A per-turn override also
    // cannot replace an independently selected durable preference.
    if (snapshot.model !== null && (snapshot.model !== tracked || snapshot.model !== selected)) {
      return {};
    }
    return {
      onModelReplacement(model) {
        if (snapshot.replaceIfCurrent(model)) mirror(model);
      },
    };
  } catch (error) {
    // A read failure matters only if the account actually requires a replacement.
    return {
      onModelReplacement() {
        throw error;
      },
    };
  }
}
