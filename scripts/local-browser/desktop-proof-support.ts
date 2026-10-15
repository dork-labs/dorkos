/** Packaged proof identity, hashing and owned fixture port helpers. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, writeFile, chmod, readFile, access, readdir } from 'node:fs/promises';
import { LOGIN_SHELL_PATH_MARKER } from '../../apps/desktop/src/shared/login-shell-path.js';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const root = process.cwd();
export interface CandidateIdentity {
  home: string;
  userData: string;
  logs: string;
  appPath: string;
  packaged: boolean;
  electron: string;
  pid: number;
}

/** Hash the actual packaged file bytes. */
export async function digest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
/** Check that a candidate path stays inside its owned directory. */
export function inside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(directory + path.sep);
}
/** Resolve existing ancestors too, since Electron may report a not-yet-created log folder. */
export async function canonicalPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    return path.join(await canonicalPath(path.dirname(file)), path.basename(file));
  }
}
const reservedPorts = new Set<number>();
/** Reserve a distinct available fixture port from the development range. */
export async function unusedPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = 6000 + Math.floor(Math.random() * 1000);
    if (reservedPorts.has(value)) continue;
    const probe = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(value, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      reservedPorts.add(value);
      return value;
    } catch {
      /* Try another proof-owned port. */
    }
  }
  throw new Error('No available 6xxx proof port');
}

/** Locate the shared exclusive verification marker. */
export async function sharedLanePath(): Promise<string> {
  // Verification can share an operator-provided lane; otherwise use the original clone's workspace.
  // eslint-disable-next-line no-restricted-syntax
  const override = process.env.LOCAL_BROWSER_LANE_FILE;
  if (override) return path.resolve(override);
  const common = (
    await exec('git', ['rev-parse', '--git-common-dir'], { cwd: root })
  ).stdout.trim();
  return path.join(
    path.dirname(path.dirname(path.resolve(root, common))),
    '.workspace/shared-local-heavy-producer.lock'
  );
}

/** Seed only the isolated candidate's home before launching its first renderer. */
export async function prepareDesktopEnvironment(options: {
  sandbox: string;
  fixtureHome: string;
  browserCache: string;
  cwd: string;
  dorkData: string;
  port: number;
}) {
  const { sandbox, fixtureHome, browserCache, cwd, dorkData, port } = options;
  const fakeShell = path.join(sandbox, 'fixture-login-shell');
  await writeFile(
    fakeShell,
    `#!/bin/sh\nprintf %s '${LOGIN_SHELL_PATH_MARKER}'; /usr/bin/env; printf %s '${LOGIN_SHELL_PATH_MARKER}'\n`
  );
  await chmod(fakeShell, 0o700);
  // Preserve original HOME/CODEX_HOME values; CoreFoundation is isolated by its own supported knob.
  // Model credentials, paid arms, debug hooks and pre-existing desktop secrets never enter this child.
  const inherited = Object.fromEntries(
    // eslint-disable-next-line no-restricted-syntax
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith('DORKOS_') &&
        !name.startsWith('DORK_') &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALED|PAID|HARNESS_SMOKE|COMMUNITY_LIVE)/.test(
          name
        ) &&
        ![
          'NODE_OPTIONS',
          'NODE_PATH',
          'DEBUG',
          'PWDEBUG',
          'SSH_AUTH_SOCK',
          'ELECTRON_RUN_AS_NODE',
          'ELECTRON_RENDERER_URL',
          'ESBUILD_BINARY_PATH',
          'PLAYWRIGHT_BROWSERS_PATH',
        ].includes(name)
    )
  );
  const environment: Record<string, string> = {
    ...(inherited as Record<string, string>),
    CFFIXED_USER_HOME: fixtureHome,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: fakeShell,
    PLAYWRIGHT_BROWSERS_PATH: browserCache,
    DORKOS_TEST_RUNTIME: 'true',
    DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    DORKOS_TASKS_ENABLED: 'false',
    DORKOS_DEFAULT_CWD: cwd,
    DORKOS_BOUNDARY: fixtureHome,
    DORKOS_PORT: String(port),
    DORKOS_HOST: '127.0.0.1',
    DORKOS_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
    DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT: '1',
  };
  const promptSeedTimestamp = new Date().toISOString();
  const firstRunPromptSeed = {
    onboarding: { dismissedAt: promptSeedTimestamp },
    profile: {
      rolePromptDismissedAt: promptSeedTimestamp,
      identityPromptDismissedAt: promptSeedTimestamp,
    },
    telemetry: { userHasDecided: true },
    ui: { trustNoticeSeenAt: promptSeedTimestamp },
  };
  await writeFile(
    path.join(dorkData, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        server: { port, cwd, boundary: fixtureHome },
        scheduler: { enabled: false },
        heartbeats: { enabled: false, triageOnCredits: false },
        auth: { enabled: false },
        ...firstRunPromptSeed,
      },
      null,
      2
    )
  );
  return { environment, firstRunPromptSeed };
}

/** Check every packed payload hash before a candidate can launch. */
export function verifyArchiveIntegrity(desktopRequire: NodeJS.Require, appArchive: string) {
  // A writer changing a packed file between stat and streaming shifts later ASAR offsets.
  // Verify every packed payload before launching a candidate built from a mutable checkout.
  const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const archive = appBuilderRequire('@electron/asar') as {
    listPackage(file: string): string[];
    statFile(
      file: string,
      entry: string,
      followLinks: boolean
    ): {
      offset?: string;
      integrity?: { algorithm: string; hash: string };
    };
    extractFile(file: string, entry: string): Buffer;
  };
  let packedFiles = 0;
  for (const name of archive.listPackage(appArchive)) {
    const entry = name.replace(/^\//, '');
    const metadata = archive.statFile(appArchive, entry, false);
    if (metadata.offset === undefined) continue;
    assert.equal(metadata.integrity?.algorithm, 'SHA256');
    assert.equal(
      createHash('sha256').update(archive.extractFile(appArchive, entry)).digest('hex'),
      metadata.integrity.hash,
      `Candidate archive payload changed: ${entry}`
    );
    packedFiles++;
  }
  const packagedManifest = JSON.parse(
    archive.extractFile(appArchive, 'package.json').toString('utf8')
  ) as { main: string };
  assert.equal(packagedManifest.main, 'dist/main/index.js');
  return { packedFiles, allPayloadHashesValid: true };
}

/** Verify packaged files and write the isolated preflight script before any launch. */
export async function preparePackagedPreflight(options: {
  desktopRequire: NodeJS.Require;
  appArchive: string;
  executable: string;
  resources: string;
  receipt: Record<string, unknown>;
  checks: Record<string, unknown>;
  browserCache: string;
  candidate: string;
  expectedElectron: string;
  sandbox: string;
}) {
  const {
    desktopRequire,
    appArchive,
    executable,
    resources,
    receipt,
    checks,
    browserCache,
    candidate,
    expectedElectron,
    sandbox,
  } = options;
  const shippedLibrary = path.join(resources, 'app.asar.unpacked/node_modules/playwright-core');
  const shippedInstaller = path.join(shippedLibrary, 'cli.js');
  await access(executable);
  await access(appArchive);
  checks.archiveIntegrity = verifyArchiveIntegrity(desktopRequire, appArchive);
  await access(shippedInstaller);
  const shipped = JSON.parse(await readFile(path.join(shippedLibrary, 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(shipped.version, '1.63.0');
  const descriptor = JSON.parse(
    await readFile(path.join(shippedLibrary, 'browsers.json'), 'utf8')
  ) as { browsers: { name: string; revision: string; browserVersion: string }[] };
  const chromium = descriptor.browsers.find((browser) => browser.name === 'chromium');
  assert(chromium?.browserVersion.startsWith('153.'));
  const installer = await realpath(shippedInstaller);
  assert(inside(installer, path.join(resources, 'app.asar.unpacked')));
  receipt.sourceSHA = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  receipt.dirtyFiles = (await exec('git', ['status', '--short'], { cwd: root })).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
  receipt.candidateDigest = {
    appArchive: await digest(appArchive),
    executable: await digest(executable),
  };
  checks.shippedLibrary = {
    version: shipped.version,
    descriptor: chromium,
    installer,
    installerDigest: await digest(installer),
  };
  assert.equal((await readdir(browserCache)).length, 0);
  const frameworkPlist = path.join(
    candidate,
    'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist'
  );
  const packagedElectron = (
    await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', frameworkPlist])
  ).stdout.trim();
  assert.equal(
    packagedElectron,
    expectedElectron,
    'CoreFoundation preflight must use the candidate’s exact Electron version'
  );
  checks.packagedElectronVersion = packagedElectron;
  // Prove CoreFoundation isolation with the same Electron version before candidate startup.
  const probe = path.join(sandbox, 'corefoundation-preflight.cjs');
  await writeFile(
    probe,
    "const {app}=require('electron');app.whenReady().then(()=>{console.log(JSON.stringify({home:app.getPath('home'),userData:app.getPath('userData'),electron:process.versions.electron}));});"
  );

  return probe;
}

/** Serve only the owned cookie and unique browser-version fixtures. */
export function createBrowserFixture(fixtureUrl: string) {
  const versionProbePath = `/seed?versionProbe=${randomUUID()}`;
  const versionProbeUrl = `${fixtureUrl}${versionProbePath}`;
  const versionRequests: { requestPath: string; userAgent: string }[] = [];
  let fixtureRequests = 0;
  const fixture = createServer((request, response) => {
    if (request.url === versionProbePath)
      versionRequests.push({
        requestPath: request.url,
        userAgent: request.headers['user-agent'] ?? '',
      });
    response.setHeader('Content-Type', 'text/html');
    if (request.url?.startsWith('/seed'))
      response.setHeader(
        'Set-Cookie',
        'dorkos_desktop_proof=owned; Max-Age=3600; Path=/; SameSite=Lax'
      );
    const persisted = request.headers.cookie?.includes('dorkos_desktop_proof=owned') ?? false;
    if (request.url?.startsWith('/resume') && persisted) fixtureRequests++;
    const title =
      request.url?.startsWith('/resume') && persisted
        ? 'Saved fixture sign-in'
        : 'Packaged browser fixture';
    response.end(
      `<title>${title}</title><h1>${title}</h1><label>Name<input aria-label="Name"></label>`
    );
  });

  return { fixture, versionProbeUrl, versionRequests, requestCount: () => fixtureRequests };
}
