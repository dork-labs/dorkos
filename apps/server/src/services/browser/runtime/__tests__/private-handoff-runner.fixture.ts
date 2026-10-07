import { BrowserProductionStatusSchema } from '@dorkos/shared/browser-schemas';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublicNativeInput } from './public-native-input.js';
import { installPrivateBrowserAcceptance } from '../private-acceptance.js';
import { createPrivateNativeAcceptance } from '../private-native-acceptance.js';
import { createHandoffPageReceiver } from './handoff-page-receiver.fixture.js';
import {
  driveOriginalCodexHandoffTurn,
  guardOriginalCodexTransport,
  runOriginalBornBrowserHandoff,
  resolveOriginalInputAcceptanceObserver,
} from './real-turn-handoff.fixture.js';

/** Private fresh-home preparation only: original file-first workspace store, no
 * principal, binding, approval, controller or native proof is manufactured. */
export async function prepareOriginalHandoffWorkspace(home: string) {
  const [{ createDb, runMigrations }, { WorkspaceStore }, { WorkspaceSchema }] = await Promise.all([
    import('@dorkos/db'),
    import('../../../workspace/workspace-store.js'),
    import('@dorkos/shared/workspace'),
  ]);
  if (
    (await realpath(home)) !== home ||
    !home.includes('/T/') ||
    !home.split('/').at(-1)?.startsWith('public-native-')
  )
    throw new Error('HANDOFF_EXCLUSIVE_PREPARED_HOME_REQUIRED');
  const db = createDb(join(home, 'dork.db'));
  try {
    runMigrations(db);
    const store = new WorkspaceStore(db, join(home, 'workspaces'));
    if (store.getByKey('handoff', 'original')) throw new Error('HANDOFF_WORKSPACE_ALREADY_EXISTS');
    const path = store.checkoutPath('handoff', 'original');
    await mkdir(path, { recursive: true });
    const at = new Date().toISOString();
    const workspace = WorkspaceSchema.parse({
      id: randomUUID(),
      projectKey: 'handoff',
      key: 'original',
      path,
      source: path,
      branch: null,
      provider: 'clone',
      status: 'ready',
      portBase: 6480,
      portBlockSize: 10,
      hostname: null,
      url: null,
      pinned: false,
      owner: { kind: 'agent', ref: path },
      createdAt: at,
      lastUsedAt: at,
    });
    await store.write(workspace);
    const original = store.getByKey('handoff', 'original');
    if (!original || original.owner?.ref !== path)
      throw new Error('HANDOFF_FILE_FIRST_WORKSPACE_NOT_REGISTERED');
    return Object.freeze({ workspaceId: original.id, agentPath: path });
  } finally {
    db.$client.close();
  }
}

/** One isolated original process, installed native journal and actual server
 * constructors. Caller supplies the existing campaign guard/outer deadline;
 * this function adds no campaign budget and never invokes a paid model. */
export async function runPrivateOriginalHandoff(options: {
  input: PublicNativeInput;
  workspace: Awaited<ReturnType<typeof prepareOriginalHandoffWorkspace>>;
  current(): void;
  signal: AbortSignal;
  retain(report: unknown): Promise<void>;
}) {
  const originalCurrent = options.current.bind(options);
  const current = () => {
    originalCurrent();
    options.signal.throwIfAborted();
  };
  const retain = options.retain.bind(options);
  const jobs: Promise<unknown>[] = [];
  const own = <T>(original: Promise<T>): Promise<T> => {
    jobs.push(original);
    void original.catch(() => {});
    return original;
  };
  let first: Readonly<{ value: unknown }> | undefined;
  let releaseTurnAbort: (() => void) | undefined;
  let owner: ReturnType<typeof installPrivateBrowserAcceptance> | undefined;
  let receiver: Awaited<ReturnType<typeof createHandoffPageReceiver>> | undefined;
  let resources: ReturnType<typeof createPrivateNativeAcceptance> | undefined;
  let native:
    | Awaited<
        ReturnType<
          (typeof import('@dorkos/browser/runtime-installation'))['verifyInstalledNativeJournal']
        >
      >
    | undefined;
  const providerGuards: ReturnType<typeof guardOriginalCodexTransport>[] = [];
  const assertProviderNotEntered = () => {
    if (providerGuards.length !== 1)
      throw new Error('HANDOFF_ONE_ORIGINAL_CODEX_TRANSPORT_REQUIRED');
    for (const guard of providerGuards) guard.assertNotEntered();
  };
  try {
    current();
    const input = options.input;
    const { verifyPublicNativeEmits } = await import('./public-native-input.js');
    await own(verifyPublicNativeEmits(input, current));
    const installInputObserver = await own(resolveOriginalInputAcceptanceObserver(input, current));
    if (
      process.env.DORK_HOME !== input.home ||
      process.env.DORKOS_PORT !== String(input.port) ||
      process.env.NODE_ENV !== 'production' ||
      ['1', 'true'].includes(process.env.DORKOS_TEST_RUNTIME ?? '')
    )
      throw new Error('HANDOFF_ORIGINAL_PRODUCTION_BOOT_ENV_REQUIRED');
    const {
      resolveInstalledRuntimeConfiguration,
      createRuntimeInstallation,
      verifyInstalledNativeJournal,
    } = await import('@dorkos/browser/runtime-installation');
    const configuration = await own(
      resolveInstalledRuntimeConfiguration(pathToFileURL(input.cliEntry), input.home)
    );
    const installed = await own(createRuntimeInstallation(configuration).inspectExisting());
    if (installed.state !== 'installed-files')
      throw new Error('HANDOFF_ORIGINAL_INSTALLATION_REQUIRED');
    native = await own(verifyInstalledNativeJournal(configuration));
    current();
    resources = createPrivateNativeAcceptance({
      manager: native.manager,
      processes: native.processes,
      own,
      current,
    });
    owner = installPrivateBrowserAcceptance({
      resources: resources.resources,
      viewerSamples: resources.viewerSamples,
      wrapOriginalCodexTransport(original) {
        const guard = guardOriginalCodexTransport(original);
        providerGuards.push(guard);
        return guard.transport;
      },
    });
    // The actual index starts actual composition; no alternate app or mode factory.
    await own(import('../../../../index.js'));
    const listener = await own(owner.waitForListener());
    const address = listener.address();
    if (!address || typeof address === 'string' || address.port !== input.port)
      throw new Error('HANDOFF_ORIGINAL_LISTENER_REQUIRED');
    const base = `http://127.0.0.1:${address.port}`;
    let cookie = '';
    const ownerRequest = async (path: string, body: unknown) => {
      current();
      const budget = path === '/api/browser/runtime/enable' ? 60000 : 20000;
      const response = await own(
        fetch(base + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: base,
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(budget)]),
        })
      );
      const bytes = await own(response.arrayBuffer());
      current();
      const value: unknown = bytes.byteLength
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        : null;
      return { response, value, bytes: new Uint8Array(bytes) };
    };
    const signed = await ownerRequest('/api/auth/sign-in/email', {
      email: input.email,
      password: input.password,
    });
    if (signed.response.status !== 200) throw new Error('HANDOFF_REAL_OWNER_SIGN_IN_REFUSED');
    cookie = signed.response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error('HANDOFF_REAL_OWNER_COOKIE_REQUIRED');
    const registered = await ownerRequest('/api/agents', {
      path: options.workspace.agentPath,
      name: 'browser-handoff-fixture',
      runtime: 'codex',
    });
    if (registered.response.status !== 201)
      throw new Error('HANDOFF_REAL_AGENT_REGISTRATION_REFUSED');
    const enabled = await ownerRequest('/api/browser/runtime/enable', {
      enabled: true,
    });
    if (
      enabled.response.status !== 200 ||
      !enabled.value ||
      typeof enabled.value !== 'object' ||
      !('state' in enabled.value) ||
      enabled.value.state !== 'ready'
    )
      throw new Error('HANDOFF_ORIGINAL_BROWSER_ENABLE_REFUSED');
    const originals = owner.originals(),
      { composition, runtime, mode } = originals;
    if (!composition.mesh.getByPath(options.workspace.agentPath))
      throw new Error('HANDOFF_REAL_REGISTERED_AGENT_ABSENT');
    const session = randomUUID();
    if (
      !(await own(
        composition.runtimeRegistry.persistSessionRuntime(
          session,
          'codex',
          { kind: 'interactive' },
          options.workspace.agentPath
        )
      ))
    )
      throw new Error('HANDOFF_ORIGINAL_SESSION_NOT_BOUND');
    const interrupt = () => {
      own(runtime.interruptQuery(session));
    };
    options.signal.addEventListener('abort', interrupt, { once: true });
    releaseTurnAbort = () => options.signal.removeEventListener('abort', interrupt);
    if (options.signal.aborted) interrupt();
    runtime.ensureSession(session, {
      cwd: options.workspace.agentPath,
      permissionMode: 'read-only',
    });
    receiver = await own(createHandoffPageReceiver());
    const originalReceiver = receiver;
    await own(
      driveOriginalCodexHandoffTurn({
        runtime,
        connectorTools: composition.connectorTools,
        principals: composition.snapshots,
        expected: {
          runtime: 'codex',
          canonicalSessionId: session,
          agentPath: options.workspace.agentPath,
          canonicalCwd: options.workspace.agentPath,
        },
        messageOptions: {
          cwd: options.workspace.agentPath,
          forAgent: options.workspace.agentPath,
        },
        assertProviderNotEntered,
        run: (context) =>
          own(
            runOriginalBornBrowserHandoff({
              mode,
              principals: composition.principals,
              authors: composition.authors,
              context,
              installInputObserver,
              receiver: originalReceiver,
              ownerRequest,
              retain,
            })
          ),
      })
    );
    releaseTurnAbort();
    assertProviderNotEntered();
    resources.assertCurrent();
    const off = await ownerRequest('/api/browser/runtime/enable', { enabled: false });
    if (
      off.response.status !== 200 ||
      BrowserProductionStatusSchema.parse(off.value).state !== 'disabled'
    )
      throw new Error('HANDOFF_REAL_EXPERIMENT_OFF_REFUSED');
  } catch (value) {
    first = { value };
  } finally {
    releaseTurnAbort?.();
    // Drain actual browser/turn cleanup before service shutdown and every retained original promise.
    for (const effect of [
      receiver ? () => receiver!.close() : undefined,
      owner ? () => owner!.close() : undefined,
    ])
      if (effect) {
        try {
          await own(effect());
        } catch (value) {
          first ??= { value };
        }
      }
    for (const result of await Promise.allSettled(jobs))
      if (result.status === 'rejected') first ??= { value: result.reason };
    if (native && resources)
      for (const birth of resources.originalKnownBirths()) {
        if (birth.pid === native.manager.pid && birth.birth === native.manager.birth) continue;
        try {
          const observation = await native.processes.observe(birth, new AbortController().signal);
          if (observation.status !== 'dead')
            first ??= { value: new Error('HANDOFF_ORIGINAL_BIRTH_RETIREMENT_UNVERIFIED') };
        } catch (value) {
          first ??= { value };
        }
      }
  }
  if (first) throw first.value;
}
