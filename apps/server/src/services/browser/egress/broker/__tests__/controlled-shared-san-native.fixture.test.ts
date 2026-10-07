import { it, onTestFinished } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import { RuntimeDescriptorSchema } from '../../../../../../../../packages/browser/src/runtime-descriptor.js';
import { createDarwinEngineProcesses } from '../../../../../../../../packages/browser/src/runtime/darwin-engine-processes.js';
import {
  boundedOriginalFile,
  readPublicNativeInput,
  verifyPublicNativeEmits,
} from '../../../runtime/__tests__/public-native-input.js';
import { openOriginalQuickTunnelPreflight } from './quick-tunnel-preflight.fixture.js';
import { runOriginalControlledSharedSANCase } from './controlled-shared-san-native.fixture.js';

// Explicit accountless controlled native window only; ordinary repository tests are inert.
const fixturePath = process.env.DORKOS_CONTROLLED_SHARED_SAN_FIXTURE;
it.skipIf(!fixturePath || process.platform !== 'darwin')(
  'observes original controlled shared-SAN H2 denial, causal mutant and revocation',
  async () => {
    const config = z
      .object({
        input: z.string().startsWith('/'),
        artifacts: z.string().startsWith('/'),
        binary: z
          .object({
            path: z.string().startsWith('/'),
            sha256: z.literal('72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830'),
            size: z.literal(39364384),
            receiptPath: z.string().startsWith('/'),
            receiptSHA256: z.literal(
              'becf67f072317ff2e93c659e5d219a98b710665472f18e829b7a0b97cd5f24f8'
            ),
          })
          .strict(),
      })
      .strict()
      .parse(JSON.parse((await boundedOriginalFile(fixturePath!, 16384)).toString('utf8')));
    const entry = await lstat(config.artifacts);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (await realpath(config.artifacts)) !== config.artifacts ||
      (await readdir(config.artifacts)).length
    )
      throw new Error('CONTROLLED_EXCLUSIVE_ARTIFACT_DIRECTORY_REQUIRED');
    const lifetime = new AbortController();
    const timer = setTimeout(
      () => lifetime.abort(new Error('CONTROLLED_ORIGINAL_NATIVE_WINDOW_EXPIRED')),
      150000
    );
    onTestFinished(() => {
      clearTimeout(timer);
    });
    let first: { value: unknown } | undefined;
    const fail = (value: unknown) => {
      first ??= { value };
    };
    const current = () => {
      if (first) throw first.value;
      lifetime.signal.throwIfAborted();
    };
    const input = await readPublicNativeInput(config.input, current);
    await verifyPublicNativeEmits(input, current);
    const installed = await resolveInstalledRuntimeConfiguration(
      pathToFileURL(input.cliEntry),
      input.home
    );
    const status = await createRuntimeInstallation(installed).inspectExisting();
    if (status.state !== 'installed-files')
      throw new Error('CONTROLLED_ORIGINAL_INSTALLATION_REQUIRED');
    const nativeJournal = await verifyInstalledNativeJournal(installed);
    const native = createDarwinEngineProcesses(nativeJournal.journal.artifact);
    const manager = await native.identity(process.pid);
    if (!manager) throw new Error('CONTROLLED_ORIGINAL_MANAGER_UNKNOWN');
    const runtime = RuntimeDescriptorSchema.parse({
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: installed.libraryRoot,
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: join(
          installed.cacheRoot,
          'candidates',
          status.installationId,
          'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        ),
        sha256: status.executableSHA256,
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'native', policyRevision: 1 },
    });
    const home = await realpath(
      await mkdtemp(join(await realpath(tmpdir()), 'original-shared-san-native-'))
    );
    let tunnels: Awaited<ReturnType<typeof openOriginalQuickTunnelPreflight>> | undefined;
    const reports: unknown[] = [];
    let finishing: Promise<void> | undefined;
    const finish = () =>
      (finishing ??= (async () => {
        let tunnelReturn: unknown;
        try {
          tunnelReturn = await tunnels?.close();
        } catch (value) {
          fail(value);
        }
        clearTimeout(timer);
        try {
          await writeFile(
            join(config.artifacts, 'RESULT.json'),
            JSON.stringify({
              kind: 'controlled-original-shared-san-native',
              scope:
                'Controlled broker/native composition. Public CLI inventory, public HTTPS smoke and full protocol matrix are separate.',
              home,
              manager,
              reports,
              tunnelReturn,
              returned: first ? 'FAIL' : 'PASS',
            }) + '\n',
            { flag: 'wx', mode: 0o600 }
          );
        } catch (value) {
          fail(value);
        }
        if (!first) await rm(home, { recursive: true, force: false }).catch(fail);
        if (first) throw first.value;
      })());
    onTestFinished(finish);
    try {
      const artifacts = join(config.artifacts, 'original-tunnels');
      tunnels = await openOriginalQuickTunnelPreflight({
        artifacts,
        binary: config.binary,
        observer: nativeJournal.journal.artifact,
        signal: lifetime.signal,
        current,
        body(_role, path, origins) {
          const worker = /^\/service-worker\/([a-f0-9-]{36})\.js$/.exec(path);
          if (worker) {
            const url = origins[1] + '/forbidden/' + worker[1] + '/service-worker';
            return `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',e=>{e.waitUntil(fetch(${JSON.stringify(url)},{mode:'no-cors',cache:'no-store'}).then(r=>r.arrayBuffer()).then(()=>e.source.postMessage('fulfilled'),()=>e.source.postMessage('rejected')));});`;
          }
          return '<!doctype html><title>Owned tunnel fixture</title>';
        },
      });
      const preflight = tunnels.port();
      for (const subject of ['policy', 'removed-admin-deny-mutant', 'revocation'] as const) {
        current();
        const profileDir = join(home, subject);
        await mkdir(profileDir, { mode: 0o700 });
        await runOriginalControlledSharedSANCase({
          preflight,
          runtime,
          nativeJournal,
          manager,
          profileDir,
          subject,
          signal: lifetime.signal,
          retain: async (report) => {
            if (reports.length >= 16) throw new Error('CONTROLLED_NATIVE_REPORT_CAP');
            reports.push(report);
          },
        });
      }
    } catch (value) {
      fail(value);
    }
    await finish();
  },
  180000
);
