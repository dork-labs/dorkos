import type { ConfigManager } from '../../../core/config-manager.js';
import { BrokerError } from '../../egress/broker/errors.js';
export interface BrowserIdentityChoicePermit {
  readonly kind: 'browser-identity-choice';
}
const originals = new WeakMap<
  BrowserIdentityChoicePermit,
  { config: ConfigManager; value: boolean; current: () => boolean; expires: number }
>();
/** Constructor-private original Off owner; no route/config DTO can manufacture the receiver. */
export function mintBrowserIdentityChoicePermit(
  config: ConfigManager,
  value: boolean,
  current: () => boolean
): BrowserIdentityChoicePermit {
  const permit = Object.freeze({ kind: 'browser-identity-choice' as const });
  originals.set(permit, { config, value, current, expires: Date.now() + 1000 });
  return permit;
}
/** Reserve before the original admission can reenter; bind receiver and exact selected value. */
export function consumeBrowserIdentityChoicePermit(
  permit: BrowserIdentityChoicePermit,
  config: ConfigManager,
  value: unknown
): () => void {
  const original = originals.get(permit);
  if (!original || original.config !== config || original.value !== value)
    throw new BrokerError('UNAVAILABLE');
  originals.delete(permit);
  const check = () => {
    if (Date.now() > original.expires || !original.current()) throw new BrokerError('UNAVAILABLE');
  };
  check();
  return check;
}
