import { pathToFileURL } from 'node:url';
import { realpath } from 'node:fs/promises';
import {
  createRuntimeInstallation,
  resolveInstalledRuntimeConfiguration,
} from '@dorkos/browser/runtime-installation';
import { verifyPublicNativeEmits, type PublicNativeInput } from './public-native-input.js';
import type { OriginalBrowserQualification } from '../admission/qualification.js';
/** Original isolated fixture inputs only. This grants a qualification run, never accepted readiness. */
export async function captureOriginalQualificationGrant(
  input: PublicNativeInput,
  current: () => void,
  mode: 'native' | 'chrome-compatible' = 'native'
): Promise<OriginalBrowserQualification> {
  current();
  await verifyPublicNativeEmits(input, current);
  if (
    (await realpath(input.home)) !== input.home ||
    !input.home.includes('/T/') ||
    !input.home.split('/').at(-1)?.startsWith('public-native-')
  )
    throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REFUSED');
  const configuration = await resolveInstalledRuntimeConfiguration(
    pathToFileURL(input.cliEntry),
    input.home
  );
  current();
  const installed = await createRuntimeInstallation(configuration).inspectExisting();
  current();
  if (installed.state !== 'installed-files')
    throw new Error('ORIGINAL_BROWSER_QUALIFICATION_REFUSED');
  return Object.freeze({
    home: input.home,
    cliSHA256: input.cliSHA256,
    executableSHA256: installed.executableSHA256,
    mode,
  });
}
