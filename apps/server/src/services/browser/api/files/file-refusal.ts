import { BrowserApiRefusal } from '../service.js';
const refusals = new WeakSet<object>();
/** Actual local file boundary denials, distinct from faults thrown by a native producer. */
export function browserFileRefusal(reason: BrowserApiRefusal['reason']) {
  const value = new BrowserApiRefusal(reason);
  refusals.add(value);
  return value;
}
/** Identify a denial created by this original local file boundary. */
export function isOriginalBrowserFileRefusal(value: unknown): value is BrowserApiRefusal {
  return !!value && typeof value === 'object' && refusals.has(value);
}
