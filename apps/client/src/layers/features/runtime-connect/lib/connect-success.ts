/**
 * Success-moment copy for the connect flows (spec: opencode-connect-overhaul §6).
 *
 * Each connect path reports its landing to the dialog with a
 * {@link RuntimeConnectSuccess}. The cloud copy is the approved verbatim line; the
 * local copy words the unlock honestly (no frontier claim — frontier stays
 * cloud-only); the login copy is a generic per-runtime confirmation.
 *
 * @module features/runtime-connect/lib/connect-success
 */
import type { RuntimeConnectSuccess } from '@/layers/entities/runtime';

/** The headline shown once OpenCode is connected, whichever path landed it. */
const OPENCODE_CONNECTED_TITLE = 'OpenCode is connected.';

/** The shared closing line: model choice now lives in the toolbar, always. */
const OPENCODE_HANDOFF_LINE =
  'This session will use OpenCode — pick any model from the model menu, anytime.';

/** Cloud (OpenRouter / Direct) success: the approved verbatim frontier-unlock copy. */
export const CLOUD_CONNECT_SUCCESS: RuntimeConnectSuccess = {
  title: OPENCODE_CONNECTED_TITLE,
  body: `Frontier models are unlocked. ${OPENCODE_HANDOFF_LINE}`,
};

/** Local (Ollama) success: honest wording — a local model is never sold as frontier. */
export const LOCAL_CONNECT_SUCCESS: RuntimeConnectSuccess = {
  title: OPENCODE_CONNECTED_TITLE,
  body: `Your local models are ready. ${OPENCODE_HANDOFF_LINE}`,
};

/**
 * Generic success copy for a delegated-login runtime (Codex, Claude), built from
 * its display label so the confirmation names the runtime the person connected.
 *
 * @param label - The runtime's display label (e.g. `"Codex"`).
 */
export function loginConnectSuccess(label: string): RuntimeConnectSuccess {
  return {
    title: `${label} is connected.`,
    body: `This session will use ${label} — pick any model from the model menu, anytime.`,
  };
}
