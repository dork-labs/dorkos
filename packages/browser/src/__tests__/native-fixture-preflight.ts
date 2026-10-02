import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

// Explicit acceptance must fail before any fixture listener/profile/child is acquired.
// Standalone fixture arming has no app env dependency.
// eslint-disable-next-line no-restricted-syntax
const supplied = process.env.DORKOS_BROWSER_FIXTURE_EXECUTABLE;
if (!supplied || !isAbsolute(supplied)) throw Error('FIXTURE_EXECUTABLE_REQUIRED');
try {
  await access(supplied, constants.R_OK | constants.X_OK);
  if (!(await stat(supplied)).isFile()) throw Error();
} catch (error) {
  throw Error('FIXTURE_EXECUTABLE_UNAVAILABLE', { cause: error });
}
