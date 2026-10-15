import { requireOriginalWorkerOperations } from '../server-worker.js';
import { startupAwait } from '../server-startup-data.js';
import { startNativeConsumerFixture } from '../server-native-fixture.js';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
/** Original resource bootstrap after owner-bound IPC/retirement registration. */
export async function startOriginalWorkerResources(operationKey: object) {
  const context = requireOriginalWorkerOperations(operationKey);
  try {
    const apiPort = Number(process.env.DORKOS_PORT),
      vitePort = Number(process.env.VITE_PORT),
      home = process.env.DORK_HOME;
    if (
      !process.send ||
      process.env.DORKOS_TEST_RUNTIME !== 'true' ||
      !home ||
      !Number.isInteger(apiPort) ||
      !Number.isInteger(vitePort) ||
      apiPort < 1 ||
      apiPort > 65535 ||
      vitePort < 1 ||
      vitePort > 65535 ||
      apiPort === vitePort
    )
      throw new Error('Owned bootstrap environment unavailable');
    const { MainRequestAdmission } = await startupAwait(
      'admission-import',
      () => import('../../../../server/src/services/core/lifecycle/main-request-admission.js')
    );
    const target = process.argv[3];
    if (target !== 'session' && target !== 'room')
      throw new Error('Finite original scope required');
    const integrityCase = process.argv[4];
    const standalone = process.argv[5];
    const frameMode = process.argv[6];
    if (
      process.argv.length !== 7 ||
      (frameMode !== 'routed' && frameMode !== 'log-only') ||
      (frameMode === 'log-only' &&
        (target !== 'session' || integrityCase !== 'none' || standalone !== 'none')) ||
      (standalone !== 'none' && standalone !== 'bearer' && standalone !== 'canonical') ||
      (standalone !== 'none' && (target !== 'room' || integrityCase !== 'none')) ||
      (integrityCase !== 'none' &&
        integrityCase !== 'select-builder' &&
        integrityCase !== 'event-codec') ||
      (integrityCase !== 'none' && target !== 'room')
    )
      throw new Error('Finite original native integrity startup required');
    const clientRoot = fileURLToPath(new URL('../../../../client/', import.meta.url));
    const clientRequire = createRequire(
      new URL('../../../../client/package.json', import.meta.url)
    );
    // Resolve the installed Vite module; its owned resource startup below overlaps native setup.
    // Reflect rejection immediately so fixture failure remains the original first cause.
    const viteModuleWork = Promise.resolve()
      .then(() => import(pathToFileURL(clientRequire.resolve('vite')).href))
      .then(
        (module) => ({ ok: true as const, module }),
        (cause: unknown) => ({ ok: false as const, cause })
      );
    const privateApiOrigin = 'http://127.0.0.1:' + apiPort;
    // Start only this owned Vite resource. Readiness still waits for every native prerequisite.
    // Reflect failure immediately; original native/preview failure remains the first cause.
    const viteStartupWork = (async () => {
      if (context.retired) throw new Error('Owned bootstrap retired');
      const { createServer: createViteServer } = await startupAwait('vite-import', async () => {
        const result = await viteModuleWork;
        if (!result.ok) throw result.cause;
        return result.module;
      });
      if (context.retired) throw new Error('Owned bootstrap retired');
      context.vite = await startupAwait('vite-create', () =>
        createViteServer({
          root: clientRoot,
          configFile: join(clientRoot, 'vite.config.ts'),
          cacheDir: join(home, 'vite-cache'),
          server: {
            warmup: { clientFiles: ['./src/main.tsx'] },
            host: '127.0.0.1',
            port: vitePort,
            strictPort: true,
            hmr: false,
            proxy: { '/api': { target: privateApiOrigin, changeOrigin: true, ws: true } },
          },
        })
      );
      if (context.retired) throw new Error('Owned bootstrap retired');
      await startupAwait('vite-listen', () =>
        (context.vite as typeof context.vite & { listen(): Promise<void> }).listen()
      );
      if (context.retired) throw new Error('Owned bootstrap retired');
    })().then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause })
    );
    context.joinViteStartup = async () => {
      await viteStartupWork;
    };
    context.fixture = await startupAwait('native-fixture', () =>
      startNativeConsumerFixture(
        new MainRequestAdmission(),
        apiPort,
        home,
        target,
        integrityCase,
        frameMode
      )
    );
    if (context.retired) throw new Error('Owned bootstrap retired');
    if (standalone === 'canonical') context.fixture.native.prepareCanonicalRecovery();
    const { previewListeners } = await startupAwait(
      'preview-import',
      () => import('../../../../server/src/services/workbench-serve/preview-listener.js')
    );
    context.previews = previewListeners; // Same singleton used by authenticated workbench/sign, owned only here.
    if (context.retired) throw new Error('Owned bootstrap retired');
    if (context.fixture.origin !== privateApiOrigin)
      throw new Error('Owned native API origin mismatch');
    const viteResult = await viteStartupWork;
    if (!viteResult.ok) throw viteResult.cause;
    if (context.retired) throw new Error('Owned bootstrap retired');
    // Original Better Auth API created the owner before native grant capture.
    // The browser signs in over actual HTTP to obtain its genuine cookie; no
    // DB-inserted cookie/public actor DTO or synthetic session is supplied.
    const { configManager } = await startupAwait(
      'config-import',
      () => import('../../../../server/src/services/core/config-manager.js')
    );
    configManager.set('auth', { enabled: true });
    if (context.retired) throw new Error('Owned bootstrap retired');
    const standaloneToken =
      standalone === 'bearer'
        ? await startupAwait('standalone-token', () =>
            context.fixture!.native.issueStandaloneToken()
          )
        : undefined;
    if (context.retired) throw new Error('Owned bootstrap retired');
    context.settleStartup();
    process.send({
      kind: 'ready',
      ...(standaloneToken === undefined ? {} : { standaloneToken }),
      origin: 'http://127.0.0.1:' + vitePort,
      apiOrigin: context.fixture.origin,
      sessionId: context.fixture.native.sessionId,
      roomId: context.fixture.native.roomId,
      documentId: context.fixture.native.documentId,
      frameDeclarationAbsent: context.fixture.native.readOriginalFrameDeclarationAbsent(),
      root: context.fixture.vault.root,
    });
  } catch (cause) {
    // Join eventual Vite ownership before startup settlement and original ordered retirement.
    // A separate Vite failure does not replace the original fixture/setup failure.
    await context.joinViteStartup?.();
    context.settleStartup();
    console.error('Original owned worker setup cause:', cause);
    if (process.connected) {
      try {
        process.send?.({ kind: 'failed', undefinedCause: cause === undefined }, () => {
          /* Original setup cause remains primary on disconnected delivery. */
        });
      } catch {
        /* Preserve setup cause before cooperative cleanup. */
      }
    }
    try {
      await context.close();
    } catch {
      /* Preserve setup cause; no readiness on failure. */
    }
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
