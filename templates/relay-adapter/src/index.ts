/**
 * Adapter entry point — factory function and manifest for the DorkOS plugin loader.
 *
 * @module my-adapter/index
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import type { RelayAdapter } from '@dorkos/relay';
import { RELAY_ADAPTER_API_VERSION } from '@dorkos/relay';
import { MyAdapter } from './my-adapter.js';

/**
 * Factory function — called by the DorkOS plugin loader.
 *
 * @param id - Unique adapter instance ID (from adapters.json config)
 * @param config - Adapter-specific configuration
 */
export default function createAdapter(
  id: string,
  config: Record<string, unknown>,
): RelayAdapter {
  return new MyAdapter(id, config);
}

/**
 * Adapter manifest — describes capabilities for the adapter catalog.
 *
 * The `apiVersion` field tells the plugin loader which relay API this adapter
 * was built against. It will emit a warning if the versions are incompatible.
 */
export function getManifest(): AdapterManifest {
  return {
    type: 'my-adapter',
    displayName: 'My Adapter',
    description: 'A custom relay adapter.',
    category: 'custom',
    builtin: false,
    apiVersion: RELAY_ADAPTER_API_VERSION,
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
        description: 'Your service API key.',
      },
    ],
    multiInstance: false,
  };
}
