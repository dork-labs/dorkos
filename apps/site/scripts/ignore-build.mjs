import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Vercel: 0 skips deployment, 1 builds. Task inputs affect caching, but
// turbo-ignore's package filter does not select changes outside workspaces.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const previous = process.env.VERCEL_GIT_PREVIOUS_SHA;
if (!previous || !/^[a-f0-9]{40}$/i.test(previous)) {
  console.log('No previous deployment commit; build the site.');
  process.exit(1);
}

const content = spawnSync('git', ['diff', '--quiet', previous, 'HEAD', '--', 'docs/', 'blog/'], {
  cwd: root,
  timeout: 10_000,
  stdio: 'ignore',
});
if (content.status !== 0) {
  console.log('Root content changed or could not be compared; build the site.');
  process.exit(1);
}

// Preserve existing workspace/dependency selection. An unavailable detector
// cannot prove the site is unaffected, so errors also request a build.
const workspace = spawnSync('npx', ['turbo-ignore'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  timeout: 90_000,
  stdio: 'inherit',
});
process.exit(workspace.status === 0 ? 0 : 1);
