/** Immutable owner authentication request identity shared with raw MCP recovery admission. */
import { createHash } from 'node:crypto';

/** Hash the exact original request; labels and reconnect identity are authority-bound metadata. */
export function connectorAuthenticationRequestHash(input: {
  providerInstanceId: string;
  toolkit: string;
  label?: string;
  reconnectConnectionId?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerInstanceId: input.providerInstanceId,
        toolkit: input.toolkit,
        label: input.label ?? null,
        reconnectConnectionId: input.reconnectConnectionId ?? null,
      })
    )
    .digest('hex');
}
