/** Load the normal tsx hooks with a suite-owned compiler cache before app imports. */
import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const privateTmp = process.env.TMPDIR;
const compilerTmp = process.env.DORK_ORIGINAL_TRANSFORM_TMP;
assert(privateTmp && compilerTmp, 'Missing private child or compiler-cache root');
assert(path.isAbsolute(privateTmp) && path.isAbsolute(compilerTmp));
assert.notEqual(await realpath(privateTmp), await realpath(compilerTmp));
const current = await lstat(compilerTmp);
assert(current.isDirectory() && !current.isSymbolicLink());
assert.equal(current.mode & 0o777, 0o700);
if (process.getuid) assert.equal(current.uid, process.getuid());
process.env.TMPDIR = compilerTmp;
try {
  // Keep both normal ESM and CJS registration. This interval imports no app.
  await import(import.meta.resolve('tsx'));
} finally {
  process.env.TMPDIR = privateTmp;
  delete process.env.DORK_ORIGINAL_TRANSFORM_TMP;
}
assert.equal(process.env.TMPDIR, privateTmp);
