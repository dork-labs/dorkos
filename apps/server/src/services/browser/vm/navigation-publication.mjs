import { authorizeOwnedNavigation, ownedNavigationCurrent } from '@dorkos/browser/server-owner';
/** Final original publication fence; completion never stands in for fresh permission. */
export async function verifyOriginalVMNavigationPublication(
  record,
  tab,
  binding,
  token,
  work,
  url,
  signal,
  policyAllowed
) {
  if (
    record.exactTab(binding) !== tab ||
    (await authorizeOwnedNavigation(token, work, binding, url, signal)) !== 'allowed' ||
    !ownedNavigationCurrent(token, work)
  )
    throw new Error('VM_NAVIGATION_AUTHORITY');
  await policyAllowed(binding, signal);
  if (record.exactTab(binding) !== tab || !ownedNavigationCurrent(token, work) || signal.aborted)
    throw new Error('VM_NAVIGATION_AUTHORITY');
  return binding;
}
