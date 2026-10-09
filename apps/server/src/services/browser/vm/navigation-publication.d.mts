import type { BrowserBinding } from '@dorkos/browser';
import type { OwnedNavigationWork } from '@dorkos/browser/server-owner';
export function verifyOriginalVMNavigationPublication(
  record: Readonly<{ exactTab(binding: BrowserBinding): unknown }>,
  tab: unknown,
  binding: BrowserBinding,
  token: OwnedNavigationWork,
  work: object,
  url: string,
  signal: AbortSignal,
  policyAllowed: (binding: BrowserBinding, signal: AbortSignal) => Promise<void>
): Promise<BrowserBinding>;
