import { BrokerError } from '../../egress/broker/errors.js';
import type { ConfigManager } from '../../../core/config-manager.js';
export interface ProductionBrowserEnablePermit {
  readonly kind: 'production-browser-enable';
}
type Permit = { config: ConfigManager; current: () => boolean; used: boolean; expires: number };
const permits = new WeakMap<ProductionBrowserEnablePermit, Permit>();
/** Internal startup issuer only; no HTTP DTO or public package export reaches this mint. */
export function mintProductionBrowserEnablePermit(
  config: ConfigManager,
  current: () => boolean
): ProductionBrowserEnablePermit {
  const permit = Object.freeze({ kind: 'production-browser-enable' as const });
  permits.set(permit, { config, current, used: false, expires: Date.now() + 1000 });
  return permit;
}
/** Exact config receiver consumes the one-use original immediately before its store effect. */
export function consumeProductionBrowserEnablePermit(
  value: ProductionBrowserEnablePermit,
  config: ConfigManager
): () => void {
  const original = permits.get(value);
  if (!original || original.used || original.config !== config || Date.now() > original.expires)
    throw new BrokerError('UNAVAILABLE');
  // Reserve consumption before the original current predicate can reenter this consumer.
  original.used = true;
  permits.delete(value);
  const check = () => {
    if (Date.now() > original.expires || !original.current()) throw new BrokerError('UNAVAILABLE');
  };
  check();
  return check;
}
