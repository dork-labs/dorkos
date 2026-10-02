import { createHash } from 'node:crypto';
import { cp, readFile, writeFile, chmod, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

const digest = (text) => createHash('sha256').update(text).digest('hex');
/** Copy, then apply exact pinned replacements; installed files are read-only and never hardlinked. */
export async function stagePatchedPackage({ sourceDir, stagingDir }) {
  const source = await realpath(sourceDir);
  const stage = join(await realpath(dirname(resolve(stagingDir))), basename(stagingDir));
  if (
    stage === source ||
    stage.startsWith(source + '/') ||
    stage.split('/').includes('node_modules')
  )
    throw Error('PRIVATE_STAGING_REQUIRED');
  const patch = JSON.parse(
    await readFile(new URL('./metadata-patch.json', import.meta.url), 'utf8')
  );
  const packageInfo = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  if (packageInfo.version !== patch.version) throw Error('PACKAGE_VERSION_MISMATCH');
  const bundlePath = join(source, 'lib/coreBundle.js');
  const before = await readFile(bundlePath, 'utf8');
  if (digest(before) !== patch.beforeSha256) throw Error('SOURCE_HASH_MISMATCH');
  let after = before;
  for (const replacement of patch.replacements) {
    if (after.split(replacement.before).length !== 2) throw Error('EXACT_PATCH_PATTERN_REQUIRED');
    after = after.replace(replacement.before, replacement.after);
  }
  if (digest(after) !== patch.afterSha256) throw Error('PATCH_RESULT_HASH_MISMATCH');
  await cp(source, stage, { recursive: true, dereference: true, force: false, errorOnExist: true });
  await chmod(stage, 0o700);
  await writeFile(join(stage, 'lib/coreBundle.js'), after, { mode: 0o600 });
  if (digest(await readFile(bundlePath, 'utf8')) !== patch.beforeSha256)
    throw Error('INSTALLED_SOURCE_CHANGED');
  return {
    packageVersion: patch.version,
    beforeSha256: patch.beforeSha256,
    afterSha256: patch.afterSha256,
  };
}
