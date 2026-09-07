/** Event encryption configuration is independent of provider SDK readiness and signing secrets. */
import { z } from 'zod';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import { env } from '@/env';

const KeysSchema = z
  .object({
    activeKeyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    keys: z.record(
      z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
    ),
  })
  .strict();

/** Resolve a separate bounded key ring; malformed or absent keys disable content access safely. */
export function managedEventProtector(
  raw = env.DORKOS_MANAGED_CONNECTOR_EVENT_PAYLOAD_KEYS
): ConnectorEventPayloadProtector | undefined {
  try {
    if (!raw || raw.length > 8192) return undefined;
    const parsed = KeysSchema.parse(JSON.parse(raw));
    const keys = new Map(
      Object.entries(parsed.keys).map(([id, encoded]) => [id, Buffer.from(encoded, 'base64')])
    );
    return new ConnectorEventPayloadProtector({ activeKeyId: parsed.activeKeyId, keys });
  } catch {
    return undefined;
  }
}
