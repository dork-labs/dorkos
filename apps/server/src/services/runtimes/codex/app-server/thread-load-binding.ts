/** Authenticate MCP discovery with the already-open turn while Codex loads a thread. */
import type { ConnectorThreadKeyPort } from '../../../connectors/runtime-principal-port.js';
import type { ThreadLoadInput } from './thread-loader.js';

/**
 * Codex initializes its MCP clients during start, resume and fork. The key
 * must resolve during that load, before the transport attaches it for the
 * model turn. Always detach here, including a failed load; the transport owns
 * the next attachment and its terminal cleanup.
 *
 * @param input - The session and the binding its runtime already opened.
 * @param keyId - The newly minted thread key, when tools were injected.
 * @param keys - The composition root's thread-key registry.
 * @param load - The protected thread-load RPC.
 */
export async function withThreadLoadBinding<T>(
  input: Pick<ThreadLoadInput, 'sessionId' | 'tools'>,
  keyId: string | undefined,
  keys: ConnectorThreadKeyPort | undefined,
  load: () => Promise<T>
): Promise<T> {
  const bindingId = input.tools.connectorBindingId;
  if (!keys || keyId === undefined || bindingId === undefined) return load();
  keys.attach(keyId, { bindingId, canonicalSessionId: input.sessionId });
  try {
    return await load();
  } finally {
    keys.detach(keyId, bindingId);
  }
}
