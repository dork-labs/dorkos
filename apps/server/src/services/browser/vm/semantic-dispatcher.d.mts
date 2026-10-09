import type { PrivateBrowserSemanticDispatcher } from '@dorkos/browser/server-owner';
import type { EnginePolicy } from '@dorkos/browser';
export function createOriginalVMSemanticDispatcher(
  records: unknown,
  policy: Pick<EnginePolicy, 'authorizeAction'>
): PrivateBrowserSemanticDispatcher;
