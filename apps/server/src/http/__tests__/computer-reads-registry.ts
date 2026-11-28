/**
 * This computer's own reads for a route test: the registry the composed app's
 * capability mount reads them from (`HonoApiDeps.capabilities`), with the
 * running server's reader wired in as boot wires it (DOR-4978).
 *
 * @module http/__tests__/computer-reads-registry
 */
import { noopLogger } from '@dorkos/shared/logger';
import {
  composeRegistry,
  type CapabilityRegistry,
} from '../../services/core/capabilities/index.js';
import {
  computerReadsDomains,
  setComputerReader,
} from '../../services/core/runtime-doors/computer-read-capabilities.js';
import { computerReader } from '../../routes/runtime-settings-reader.js';

/**
 * The registry of this computer's reads, after wiring the real reader.
 *
 * @returns The registry, for `composedListener(admission, { capabilities })`.
 */
export function computerReadsRegistry(): CapabilityRegistry {
  setComputerReader(computerReader());
  return composeRegistry([...computerReadsDomains], { logger: noopLogger });
}
