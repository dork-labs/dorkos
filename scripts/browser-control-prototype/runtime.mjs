import { isEntrypoint } from './entrypoint.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { arch, platform, release } from 'node:os';
import { validateRuntimeReceipt, serializeEvidence } from './contracts.mjs';

/** Errors carry fixed codes, never a captured environment or credential-bearing output. */
export class RuntimeUnavailableError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeUnavailableError';
    this.code = code;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Resolve the lockfile-installed e2e dependency; this function never downloads a browser. */
export async function loadPlaywright({ repoRoot, expectedVersion = '1.63.0' }) {
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    throw new TypeError('An absolute repository root is required.');
  }
  const requireE2e = createRequire(resolve(repoRoot, 'apps/e2e/package.json'));
  let requireCore;
  let chromium;
  let packagePath;
  try {
    const testPath = requireE2e.resolve('@playwright/test');
    const requireTest = createRequire(testPath);
    const requirePlaywright = createRequire(requireTest.resolve('playwright'));
    packagePath = requirePlaywright.resolve('playwright-core/package.json');
    requireCore = createRequire(packagePath);
    ({ chromium } = requireCore('playwright-core'));
  } catch {
    throw new RuntimeUnavailableError(
      'PLAYWRIGHT_MISSING',
      'Playwright is unavailable. Run pnpm install --frozen-lockfile explicitly before the experiment.'
    );
  }
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  if (metadata.version !== expectedVersion) {
    throw new RuntimeUnavailableError(
      'VERSION_MISMATCH',
      'Installed Playwright does not match the experiment version. Check the lockfile and explicit install.'
    );
  }
  const browsers = JSON.parse(
    await readFile(resolve(dirname(packagePath), 'browsers.json'), 'utf8')
  );
  const pinned = browsers.browsers.find((browser) => browser.name === 'chromium');
  if (!pinned)
    throw new RuntimeUnavailableError(
      'REVISION_MISSING',
      'The installed Playwright package has no Chromium revision.'
    );
  if (pinned.revisionOverrides && Object.keys(pinned.revisionOverrides).length > 0) {
    throw new RuntimeUnavailableError(
      'REVISION_OVERRIDE',
      'This executable needs platform-specific revision resolution before it can be used as evidence.'
    );
  }
  const executablePath = chromium.executablePath();
  try {
    await access(executablePath, constants.R_OK | constants.X_OK);
    if (!(await stat(executablePath)).isFile()) throw new Error('Not an executable file.');
  } catch {
    throw new RuntimeUnavailableError(
      'EXECUTABLE_MISSING',
      'Chromium is absent or not executable. Explicitly run pnpm --filter @dorkos/e2e exec playwright install chromium; no action will download it.'
    );
  }
  const receipt = validateRuntimeReceipt({
    kind: 'runtime',
    libraryVersion: metadata.version,
    chromiumRevision: String(pinned.revision),
    executablePath,
    executableSha256: await sha256(executablePath),
    os: { platform: platform(), release: release(), arch: arch() },
  });
  // Pin launch to the exact executable that was hashed, including headless launches.
  return { chromium, receipt, launchOptions: Object.freeze({ executablePath, headless: true }) };
}

if (isEntrypoint(import.meta.url)) {
  try {
    const { receipt } = await loadPlaywright({ repoRoot: resolve(process.argv[2] ?? '.') });
    process.stdout.write(
      serializeEvidence(receipt, { publicReport: process.argv[3] !== '--local' })
    );
  } catch (error) {
    const code = error instanceof RuntimeUnavailableError ? error.code : 'RUNTIME_ERROR';
    process.stderr.write(JSON.stringify({ status: 'unverified', code }) + '\n');
    process.exitCode = 1;
  }
}
