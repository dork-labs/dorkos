/**
 * Which app actions spend money (DOR-4204 spec §6), read from the same rule
 * the server enforces, so the marker and the limit never disagree.
 *
 * @module features/connections/lib/paid-actions
 */
import { isPaidOperation } from '@dorkos/shared/connector-schemas';

/**
 * Whether an action spends money.
 *
 * @param toolkit - The app's service id.
 * @param operationSlug - The action, as the provider names it.
 */
export function isPaidAction(toolkit: string, operationSlug: string): boolean {
  return isPaidOperation({ toolkit, operationSlug });
}

/**
 * Whether an app is one whose actions spend money: every action of a
 * pay-per-use service, unless Security reviewed one as free.
 *
 * @param toolkit - The app's service id.
 */
export function isPaidToolkit(toolkit: string): boolean {
  return isPaidOperation({ toolkit, operationSlug: '' });
}
