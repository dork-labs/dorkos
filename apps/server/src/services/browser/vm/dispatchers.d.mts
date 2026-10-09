import type { EnginePolicy } from '@dorkos/browser';
import type {
  PrivateBrowserBirthOwner,
  PrivateBrowserCaptureDispatcher,
  PrivateBrowserNavigationDispatcher,
  PrivateBrowserInputDispatcher,
} from '@dorkos/browser/server-owner';
import type { VMRecordOwner } from './record.mjs';
export function installOriginalVMDispatchers(
  records: VMRecordOwner,
  birthOwner: PrivateBrowserBirthOwner &
    Required<Pick<PrivateBrowserBirthOwner, 'capture' | 'navigation' | 'input'>>,
  policy: EnginePolicy
): Readonly<{
  capture: PrivateBrowserCaptureDispatcher;
  navigation: PrivateBrowserNavigationDispatcher;
  input: PrivateBrowserInputDispatcher;
}>;
