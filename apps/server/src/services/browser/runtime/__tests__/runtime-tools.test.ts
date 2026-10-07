import { parseBrowserId, parseTabId, parseBrowserResult } from '@dorkos/browser';
import { z } from 'zod';
import {
  SemanticSnapshotV1Schema,
  SemanticActionV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { capabilitiesForMcpServer } from '../../../core/capabilities/mcp-projection.js';
import { capabilityMcpTools } from '../../../runtimes/claude-code/mcp-tools/capability-mcp-tools.js';
import { toolSurfaceDigest } from '../../../runtimes/claude-code/mcp-tools/tool-surface.js';
import { createAgentRuntimeMcpServer } from '../../../runtimes/connector-mcp/agent-runtime-server.js';
import { managedBrowserDomain, managedBrowserOptionalDomain } from '../browser-capabilities.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserRetirementReceiver,
  PrivateBrowserInputDispatcher,
} from '@dorkos/browser/server-owner';
import {
  BrowserBindingSchema,
  BrowserInputRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserUploadRequestSchema,
  BrowserDownloadRequestSchema,
} from '@dorkos/shared/browser-schemas';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { OwnedBrowserGrants } from '../../api/grants.js';
import { OwnedBrowserController } from '../../api/controller.js';
import { BrowserControllerNavigation } from '../../api/controller-navigation.js';
import { BrowserControllerInput } from '../../api/controller-input.js';
import { BrowserApiRefusal } from '../../api/service.js';
import {
  createManagedBrowserRuntimeTools,
  ManagedBrowserSemanticActionSchema,
  ManagedBrowserTabsSchema,
  type RuntimeBrowserActorCapabilities,
} from '../runtime-tools.js';

function originalInputResult(value: unknown) {
  const parsed = parseBrowserResult(value);
  if (parsed.kind !== 'action') throw new Error('UNIT_ORIGINAL_ACTION_REQUIRED');
  return parsed;
}
function fixture(
  runtime: 'claude-code' | 'codex' | 'opencode' = 'claude-code',
  actorCapabilities?: RuntimeBrowserActorCapabilities,
  withNavigation = false
) {
  let enabled = true,
    authenticated = true;
  let binding = BrowserBindingSchema.parse({
    browserId: 'browser_tools_________',
    browserGeneration: 1,
    tabId: 'tab_tools_____________',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  });
  const initial = binding;
  const principal = createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'user', userId: 'owner_tools___________' },
    bindingId: 'turn_tools____________',
    runtime,
    canonicalSessionId: 'session_tools_________',
    agentId: 'agent_tools___________',
    agentPath: '/fixture/agent',
  });
  const credential = {},
    owner = () => ({ owner: 'owner_tools___________', credential });
  const pending: Promise<unknown>[] = [];
  const releases: Array<() => void> = [];
  const expected = new Set<unknown>();
  let finish!: () => void;
  const observation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retained: {
    tools?: ReturnType<typeof createManagedBrowserRuntimeTools>;
    input?: BrowserControllerInput;
  } = {};
  let navigation: BrowserControllerNavigation | undefined;
  const grants = new OwnedBrowserGrants(
    { birthOwner: () => ({ registerBirth: vi.fn(), refuseBirth: vi.fn() }) },
    () => true,
    () => enabled
  );
  // Install cleanup before the original birth/dispatcher producers.
  onTestFinished(async () => {
    for (const release of releases) release();
    finish();
    grants.closeExpiry();
    const results = await Promise.allSettled([
      ...pending,
      ...(retained.tools ? [retained.tools.close()] : []),
      ...(retained.input ? [retained.input.close()] : []),
      ...(navigation ? [navigation.close()] : []),
    ]);
    enabled = false;
    for (const result of results)
      if (result.status === 'rejected' && !expected.has(result.reason)) throw result.reason;
  });
  const listTabs = vi.fn(() => [binding]);
  let resetting: Promise<{ binding: typeof binding; status: 'ready' }> | undefined;
  const resetInput = vi.fn(() => {
    // The actual engine shares an in-flight reset; the double must not advance
    // two independent epochs for concurrent losses of the same original seat.
    if (resetting) return resetting;
    const original = Promise.resolve().then(() => {
      binding = BrowserBindingSchema.parse({
        ...binding,
        epoch: binding.epoch + 1,
        inputGeneration: binding.inputGeneration + 1,
      });
      return { binding, status: 'ready' as const };
    });
    resetting = original;
    void original.then(() => {
      if (resetting === original) resetting = undefined;
    });
    return original;
  });
  const engine = { listTabs, resetInput } as unknown as BrowserLifecycleEngine;
  grants.bindEngine(engine);
  grants.birthOwner('owner_tools___________', { mode: 'ephemeral' }).registerBirth({
    browserId: binding.browserId,
    browserGeneration: 1,
    isOrdinary: () => true,
    isAuthorityCurrent: () => enabled,
    authorityRevoked: () => observation,
    observation,
  } as unknown as PrivateBrowserRetirementReceiver);
  let registryFailure: { reason: unknown } | undefined;
  const controller = new OwnedBrowserController(
    {
      instance: () => {
        if (registryFailure) throw registryFailure.reason;
        return {
          browserId: binding.browserId,
          browserGeneration: 1,
          mode: 'ephemeral',
          status: 'running',
        };
      },
      stop: vi.fn(),
    },
    engine,
    () => enabled,
    grants
  );
  grants.bindController(controller);
  const input = (retained.input = new BrowserControllerInput());
  const dispatch = vi.fn<PrivateBrowserInputDispatcher['input']>(async (value, proof) => {
    const command = BrowserInputRequestSchema.parse(value);
    if (!proof.isCurrent()) throw new Error('NATIVE_ADMISSION_LOST');
    return originalInputResult({
      kind: 'action',
      requestId: command.requestId,
      binding: command.binding,
      outcome: 'completed',
    });
  });
  input.owner.registerDispatcher({ input: dispatch });
  const principals = {
    revalidatePrincipal: vi.fn(async () => authenticated),
    isPrincipalCurrent: vi.fn(() => authenticated),
  };
  const author = {
    id: 'author_tools__________',
    kind: 'agent' as const,
    naturalKey: '/fixture/agent',
    displayName: 'Fixture Agent',
    handle: null,
    emoji: null,
    color: null,
    imageUrl: null,
    mintedForManifestId: 'agent_tools___________',
    linkedOwnerKey: null,
  };
  const authors = { resolveAgent: vi.fn(() => author) };
  const navigateNative = vi.fn(async (value: unknown) => {
    const command = BrowserNavigateRequestSchema.parse(value);
    binding = BrowserBindingSchema.parse({
      ...command.binding,
      epoch: command.binding.epoch + 1,
      inputGeneration: command.binding.inputGeneration + 1,
      navigationGeneration: command.binding.navigationGeneration + 1,
    });
    return binding;
  });
  let navigationReady: Promise<void> = Promise.resolve();
  const navigationFence = vi.fn(() => navigationReady);
  if (withNavigation) {
    controller.bindNavigationViews({ bindingLost: navigationFence });
    navigation = new BrowserControllerNavigation();
    navigation.bindActorController(controller);
    navigation.owner.registerDispatcher({
      navigate: async (command, original, signal) => {
        if (signal?.aborted || !original.isCurrent()) throw new Error('NATIVE_NAVIGATION_LOST');
        const next = await navigateNative(command);
        return {
          ...next,
          browserId: parseBrowserId(next.browserId),
          tabId: parseTabId(next.tabId),
        };
      },
    });
  }
  const tools = (retained.tools = createManagedBrowserRuntimeTools({
    principals,
    authors,
    grants,
    controller,
    input,
    engine,
    enabled: () => enabled,
    actorCapabilities,
    navigation,
  }));
  const context = {
    serverPrincipal: principal,
    identity: {
      agentPath: '/fixture/agent',
      displayName: 'Fixture Agent',
      createdAt: '2026-10-06T00:00:00Z',
    },
    sessionId: 'session_tools_________',
  };
  const grant = (permissions: Parameters<OwnedBrowserGrants['issue']>[4]) => {
    const original = grants.issue(
      owner,
      binding,
      author.id,
      { kind: 'session', sessionId: 'session_tools_________' },
      permissions,
      new Date(Date.now() + 60000).toISOString()
    );
    // Owner issuance verifies its live tab; tool-entry assertions start after this setup.
    listTabs.mockClear();
    return { grantId: original.grantId, revision: original.grantRevision };
  };
  return {
    tools,
    navigateNative,
    navigationFence,
    owner,
    holdNavigation() {
      let release!: () => void;
      navigationReady = new Promise<void>((yes) => {
        release = yes;
      });
      releases.push(release);
      return release;
    },
    context,
    grants,
    grant,
    listTabs,
    resetInput,
    dispatch,
    principals,
    authors,
    author,
    failRegistry: (reason: unknown) => {
      registryFailure = { reason };
    },
    pending,
    expected,
    releases,
    binding: () => binding,
    disable: () => {
      enabled = false;
    },
    enable: () => {
      enabled = true;
    },
    revokePrincipal: () => {
      authenticated = false;
    },
  };
}

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'uses original grant/controller/input banks for %s',
  async (runtime) => {
    const f = fixture(runtime),
      reference = f.grant(['browser.view', 'browser.control']);
    const rows = await f.tools.tabs(f.context, {
      binding: f.binding(),
      grant: reference,
    });
    expect(rows).toEqual([f.binding()]);
    const controlled = await f.tools.control(f.context, {
      binding: f.binding(),
      grant: reference,
    });
    expect(controlled.binding.epoch).toBe(1);
    expect(f.resetInput).toHaveBeenCalledOnce();
    const command = BrowserInputRequestSchema.parse({
      kind: 'input',
      requestId: 'request_tools_________',
      binding: controlled.binding,
      steps: [{ kind: 'mouseMove', x: 2, y: 3 }],
    });
    const result = await f.tools.input(f.context, {
      command,
      controllerId: controlled.controllerId,
      grant: reference,
    });
    expect(result.outcome).toBe('completed');
    expect(f.dispatch).toHaveBeenCalledOnce();
  }
);
it('copied principal and outsider identity fail before original tab/native entry without poisoning later owner-granted work', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view']);
  await expect(
    f.tools.tabs(
      {
        ...f.context,
        serverPrincipal: JSON.parse(JSON.stringify(f.context.serverPrincipal)),
      },
      { binding: f.binding(), grant }
    )
  ).rejects.toThrow();
  await expect(
    f.tools.tabs(
      {
        ...f.context,
        identity: { ...f.context.identity, agentPath: '/fixture/outsider' },
      },
      { binding: f.binding(), grant }
    )
  ).rejects.toThrow();
  expect(f.listTabs).not.toHaveBeenCalled();
  expect(await f.tools.tabs(f.context, { binding: f.binding(), grant })).toEqual([f.binding()]);
});
it('a view-only original grant cannot take control or issue native input, and its local refusal leaves later view healthy', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view']);
  await expect(f.tools.control(f.context, { binding: f.binding(), grant })).rejects.toThrow();
  expect(f.resetInput).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(await f.tools.tabs(f.context, { binding: f.binding(), grant })).toEqual([f.binding()]);
});
it('revocation during held original turn refresh prevents tab extraction and close joins that exact refresh', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view']);
  let release!: (value: boolean) => void, entered!: () => void;
  const held = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.releases.push(() => release(false));
  f.principals.revalidatePrincipal.mockImplementationOnce(() => {
    entered();
    return held;
  });
  const original = f.tools.tabs(f.context, { binding: f.binding(), grant });
  f.pending.push(original);
  await entering;
  let done = false;
  const close = f.tools.close();
  f.pending.push(close);
  void close.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  f.revokePrincipal();
  release(false);
  const refusal = await original.then(
    () => {
      throw new Error('Expected local refusal');
    },
    (reason) => reason
  );
  f.expected.add(refusal);
  expect(refusal).toBeInstanceOf(Error);
  await close;
  expect(f.listTabs).not.toHaveBeenCalled();
});
it('an unqualified original refresh rejection undefined is sticky through exact close and cannot be upgraded', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view']);
  f.expected.add(undefined);
  f.principals.revalidatePrincipal.mockRejectedValueOnce(undefined);
  const original = f.tools.tabs(f.context, { binding: f.binding(), grant });
  f.pending.push(original);
  await expect(original).rejects.toBeUndefined();
  await expect(f.tools.close()).rejects.toBeUndefined();
  expect(f.tools.available()).toBe(false);
  expect(f.listTabs).not.toHaveBeenCalled();
});

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'actual shared %s projection changes Off→On→Off and stale tool invocation remains refused',
  async (runtime) => {
    const f = fixture(runtime, optionalReceivers()),
      grant = f.grant(['browser.view']);
    const registry = composeRegistry([managedBrowserDomain, managedBrowserOptionalDomain], {
      logger: noopLogger,
      managedBrowserDeps: {
        describeFileApproval: () => {
          throw new Error('File approval not used by this control');
        },
        issueFileApproval: async () => {
          throw new Error('File approval not used by this control');
        },
        describeDelegation: () => {
          throw new Error('NO_DELEGATION');
        },
        openDelegated: async () => {
          throw new Error('NO_DELEGATION');
        },
        current: f.tools.available,
        optionalAvailable: f.tools.optionalAvailable,
        open: async () => {
          throw new Error('Birth requires the separately tested production issuer.');
        },
        close: async () => {
          throw new Error('Closure requires the separately tested production issuer.');
        },
        resolve: () => f.tools,
      },
    });
    const receipts: Array<ReturnType<typeof createAgentRuntimeMcpServer>> = [];
    const clients: Client[] = [];
    const connections: Promise<unknown>[] = [];
    onTestFinished(async () => {
      const results = await Promise.allSettled([
        ...clients.map((client) => client.close()),
        ...receipts.map((server) => server.close()),
        ...connections,
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
    const names: string[][] = [];
    const digests: string[] = [];
    for (const enabled of [false, true, false]) {
      if (enabled) f.enable();
      else f.disable();
      const definitions = capabilityMcpTools(registry, 'in-session');
      digests.push(
        toolSurfaceDigest(
          definitions.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          }))
        )
      );
      const server = createAgentRuntimeMcpServer(
        registry,
        f.context.serverPrincipal,
        f.context.identity
      );
      receipts.push(server);
      const client = new Client({
        name: 'managed-tools-conformance',
        version: '1',
      });
      clients.push(client);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const connecting = Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);
      connections.push(connecting);
      await connecting;
      // The actual SDK omits tools/list when the original handshake advertises no tools.
      names.push(
        client.getServerCapabilities()?.tools
          ? (await client.listTools()).tools.map((tool) => tool.name).sort()
          : []
      );
      expect(names[names.length - 1]).toEqual(
        capabilitiesForMcpServer(registry, 'in-session')
          .map((cap) => cap.surfaces.mcp!.toolName)
          .sort()
      );
    }
    expect(names).toEqual([
      [],
      [
        'managed_browser_close',
        'managed_browser_control',
        'managed_browser_download',
        'managed_browser_file_access',
        'managed_browser_input',
        'managed_browser_navigate',
        'managed_browser_open',
        'managed_browser_open_delegated',
        'managed_browser_semantic_action',
        'managed_browser_semantic_read',
        'managed_browser_stage_upload',
        'managed_browser_tabs',
        'managed_browser_upload',
      ],
      [],
    ]);
    expect(digests[0]).toBe(digests[2]);
    expect(digests[1]).not.toBe(digests[0]);
    await expect(
      registry.invoke('browser.tabs', { binding: f.binding(), grant }, f.context)
    ).rejects.toThrow();
    expect(f.listTabs).not.toHaveBeenCalled();
  }
);

it('returns an original uncertain native receipt once without replaying the command', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view', 'browser.control']);
  const controlled = await f.tools.control(f.context, {
    binding: f.binding(),
    grant,
  });
  f.dispatch.mockImplementationOnce(async (value) => {
    const command = BrowserInputRequestSchema.parse(value);
    return originalInputResult({
      kind: 'action',
      requestId: command.requestId,
      binding: command.binding,
      outcome: 'uncertain',
      reason: 'dispatchFailed',
    });
  });
  const command = BrowserInputRequestSchema.parse({
    kind: 'input',
    requestId: 'request_uncertain_____',
    binding: controlled.binding,
    steps: [{ kind: 'mouseMove', x: 2, y: 3 }],
  });
  const result = await f.tools.input(f.context, {
    command,
    controllerId: controlled.controllerId,
    grant,
  });
  expect(result.outcome).toBe('uncertain');
  expect(f.dispatch).toHaveBeenCalledOnce();
});

it('a canonical author occupancy replacement refuses the original turn grant without entering native input', async () => {
  const f = fixture(),
    grant = f.grant(['browser.view', 'browser.control']);
  f.authors.resolveAgent.mockReturnValue({
    ...f.author,
    id: 'author_replaced________',
    mintedForManifestId: 'agent_replaced_________',
  });
  await expect(f.tools.tabs(f.context, { binding: f.binding(), grant })).rejects.toBeInstanceOf(
    Error
  );
  expect(f.listTabs).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
  await f.tools.close();
});

it.each([undefined, null, 0, 'true', {}])(
  'a nonboolean availability result %s cannot list, get or invoke a hidden shared capability',
  async (value) => {
    const f = fixture(),
      grant = f.grant(['browser.view']);
    const registry = composeRegistry(
      [{ ...managedBrowserDomain, available: () => value as boolean }],
      {
        logger: noopLogger,
        managedBrowserDeps: {
          describeFileApproval: () => {
            throw new Error('File approval not used by this control');
          },
          issueFileApproval: async () => {
            throw new Error('File approval not used by this control');
          },
          describeDelegation: () => {
            throw new Error('NO_DELEGATION');
          },
          openDelegated: async () => {
            throw new Error('NO_DELEGATION');
          },
          current: () => true,
          optionalAvailable: () => false,
          resolve: () => f.tools,
          open: async () => {
            throw new Error('Unavailable');
          },
          close: async () => {
            throw new Error('Unavailable');
          },
        },
      }
    );
    expect(capabilitiesForMcpServer(registry, 'in-session')).toEqual([]);
    expect(registry.get('browser.tabs')).toBeUndefined();
    await expect(
      registry.invoke('browser.tabs', { binding: f.binding(), grant }, f.context)
    ).rejects.toThrow();
    expect(f.listTabs).not.toHaveBeenCalled();
  }
);

it.each([undefined, new BrowserApiRefusal('inaccessible')])(
  'strict original controller registry failure %s retains its exact unknown cause before native entry',
  async (reason) => {
    const f = fixture(),
      grant = f.grant(['browser.view', 'browser.control']);
    const control = await f.tools.control(f.context, {
      binding: f.binding(),
      grant,
    });
    f.expected.add(reason);
    f.failRegistry(reason);
    const command = BrowserInputRequestSchema.parse({
      kind: 'input',
      requestId: 'request_strict_failure_00001',
      binding: control.binding,
      steps: [{ kind: 'mouseMove', x: 2, y: 3 }],
    });
    const operation = f.tools.input(f.context, {
      command,
      controllerId: control.controllerId,
      grant,
    });
    f.pending.push(operation);
    await expect(operation).rejects.toBe(reason);
    await expect(f.tools.close()).rejects.toBe(reason);
    expect(f.dispatch).not.toHaveBeenCalled();
  }
);

function optionalReceivers() {
  return {
    readSemanticForActor: vi.fn<RuntimeBrowserActorCapabilities['readSemanticForActor']>(),
    actionSemanticForActor: vi.fn<RuntimeBrowserActorCapabilities['actionSemanticForActor']>(),
    streamSemanticForActor: vi.fn<RuntimeBrowserActorCapabilities['streamSemanticForActor']>(),
    stageForActor: vi.fn<RuntimeBrowserActorCapabilities['stageForActor']>(),
    uploadForActor: vi.fn<RuntimeBrowserActorCapabilities['uploadForActor']>(),
    downloadForActor: vi.fn<RuntimeBrowserActorCapabilities['downloadForActor']>(),
  };
}
it.each(['claude-code', 'codex', 'opencode'] as const)(
  'optional %s common projection follows original host presence and Off→On→Off',
  async (runtime) => {
    const originals = optionalReceivers(),
      f = fixture(runtime, originals);
    const registry = composeRegistry([managedBrowserOptionalDomain], {
      logger: noopLogger,
      managedBrowserDeps: {
        current: f.tools.available,
        optionalAvailable: f.tools.optionalAvailable,
        resolve: () => f.tools,
        describeFileApproval: () => {
          throw new Error('File approval not used by this control');
        },
        issueFileApproval: async () => {
          throw new Error('File approval not used by this control');
        },
        describeDelegation: () => {
          throw new Error('NO_DELEGATION');
        },
        openDelegated: async () => {
          throw new Error('NO_DELEGATION');
        },
        open: async () => {
          throw new Error('NO_BIRTH');
        },
        close: async () => {
          throw new Error('NO_BIRTH');
        },
      },
    });
    for (const on of [false, true, false]) {
      if (on) f.enable();
      else f.disable();
      const names = capabilityMcpTools(registry, 'in-session')
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual(
        on
          ? [
              'managed_browser_download',
              'managed_browser_semantic_action',
              'managed_browser_semantic_read',
              'managed_browser_stage_upload',
              'managed_browser_upload',
            ]
          : []
      );
      expect(registry.get('browser.stage_upload') !== undefined).toBe(on);
    }
    expect(originals.stageForActor).not.toHaveBeenCalled();
    const absent = fixture(runtime);
    expect(absent.tools.optionalAvailable()).toBe(false);
  }
);
it.each(['claude-code', 'codex', 'opencode'] as const)(
  'the %s stage consumer passes the genuine durable actor and zeroes its bounded copy',
  async (runtime) => {
    const originals = optionalReceivers(),
      f = fixture(runtime, originals);
    let originalBytes: Uint8Array | undefined;
    originals.stageForActor.mockImplementation(
      async (actor, binding, reference, name, mime, bytes) => {
        const admitted = await actor.refresh();
        expect(admitted.owner).toBe(f.author.id);
        expect(actor.current()).toBe(admitted);
        expect(binding).toEqual(f.binding());
        expect(reference).toEqual({
          grantId: 'artifact_tools________',
          revision: 0,
        });
        expect(name).toBe('note.txt');
        expect(mime).toBe('text/plain');
        expect(Buffer.from(bytes).toString()).toBe('hello');
        originalBytes = bytes;
        return {
          artifactId: 'staged_tools__________',
          byteLength: bytes.length,
        };
      }
    );
    const result = await f.tools.stageUpload(f.context, {
      binding: f.binding(),
      artifactGrant: { grantId: 'artifact_tools________', revision: 0 },
      name: 'note.txt',
      mimeType: 'text/plain',
      bytesBase64: Buffer.from('hello').toString('base64'),
    });
    expect(result).toEqual({
      artifactId: 'staged_tools__________',
      byteLength: 5,
    });
    expect(originals.stageForActor).toHaveBeenCalledOnce();
    expect(originalBytes && Buffer.from(originalBytes).equals(Buffer.alloc(5))).toBe(true);
  }
);
it('an original optional producer undefined remains sticky and refuses subsequent producers', async () => {
  const originals = optionalReceivers(),
    f = fixture('codex', originals);
  originals.stageForActor.mockRejectedValueOnce(undefined);
  f.expected.add(undefined);
  const value = {
    binding: f.binding(),
    artifactGrant: { grantId: 'artifact_tools________', revision: 0 },
    name: 'note.txt',
    mimeType: 'text/plain',
    bytesBase64: 'aGVsbG8=',
  };
  await expect(f.tools.stageUpload(f.context, value)).rejects.toBeUndefined();
  await expect(f.tools.stageUpload(f.context, value)).rejects.toBeUndefined();
  expect(originals.stageForActor).toHaveBeenCalledOnce();
  await expect(f.tools.close()).rejects.toBeUndefined();
});

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'recipient %s navigation consumes actual grant/controller flow and returns canonical advance',
  async (runtime) => {
    const f = fixture(runtime, undefined, true),
      grant = f.grant(['browser.view', 'browser.control']);
    const controlled = await f.tools.control(f.context, {
      binding: f.binding(),
      grant,
    });
    const command = BrowserNavigateRequestSchema.parse({
      kind: 'navigate',
      requestId: 'navigate_tools________',
      binding: controlled.binding,
      url: 'https://example.test/next',
    });
    const result = await f.tools.navigate(f.context, {
      command,
      controllerId: controlled.controllerId,
      grant,
    });
    expect(result.navigationGeneration).toBe(controlled.binding.navigationGeneration + 1);
    expect(result.epoch).toBe(controlled.binding.epoch + 1);
    expect(result.inputGeneration).toBe(controlled.binding.inputGeneration + 1);
    expect(f.navigateNative).toHaveBeenCalledOnce();
    await expect(
      f.tools.input(f.context, {
        command: {
          kind: 'input',
          requestId: 'input_old_navigation__',
          binding: controlled.binding,
          steps: [{ kind: 'mouseMove', x: 1, y: 1 }],
        },
        controllerId: controlled.controllerId,
        grant,
      })
    ).rejects.toBeInstanceOf(BrowserApiRefusal);
    expect(f.dispatch).not.toHaveBeenCalled();
  }
);
it('recipient navigation retains an original registry undefined instead of converting it into denial', async () => {
  const f = fixture('opencode', undefined, true),
    grant = f.grant(['browser.view', 'browser.control']);
  const controlled = await f.tools.control(f.context, {
    binding: f.binding(),
    grant,
  });
  f.failRegistry(undefined);
  f.expected.add(undefined);
  await expect(
    f.tools.navigate(f.context, {
      command: {
        kind: 'navigate',
        requestId: 'navigate_tools________',
        binding: controlled.binding,
        url: 'https://example.test/next',
      },
      controllerId: controlled.controllerId,
      grant,
    })
  ).rejects.toBeUndefined();
  expect(f.navigateNative).not.toHaveBeenCalled();
  await expect(f.tools.close()).rejects.toBeUndefined();
});

it('recipient grant revocation while the original viewer join is held refuses navigation and joins cleanup', async () => {
  const f = fixture('codex', undefined, true),
    grant = f.grant(['browser.view', 'browser.control']);
  const controlled = await f.tools.control(f.context, {
    binding: f.binding(),
    grant,
  });
  const release = f.holdNavigation();
  const original = f.tools.navigate(f.context, {
    command: {
      kind: 'navigate',
      requestId: 'navigate_tools________',
      binding: controlled.binding,
      url: 'https://example.test/next',
    },
    controllerId: controlled.controllerId,
    grant,
  });
  f.pending.push(original);
  await vi.waitFor(() => expect(f.navigationFence).toHaveBeenCalledOnce());
  expect(f.navigateNative).not.toHaveBeenCalled();
  f.grants.revoke(f.owner, grant.grantId, grant.revision);
  release();
  const observed = await original.then(
    () => {
      throw new Error('Expected original refusal');
    },
    (reason: unknown) => reason
  );
  expect(observed).toBeInstanceOf(BrowserApiRefusal);
  f.expected.add(observed);
  expect(f.navigateNative).not.toHaveBeenCalled();
  await f.tools.close();
});

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'recipient %s semantic edit uses only its retained original stream and joins it on close',
  async (runtime) => {
    const originals = optionalReceivers(),
      f = fixture(runtime, originals),
      grant = f.grant(['browser.view', 'browser.control']);
    const streamClose = vi.fn(async () => {});
    const controlled = await f.tools.control(f.context, {
      binding: f.binding(),
      grant,
    });
    const binding = controlled.binding;
    const snapshot = SemanticSnapshotV1Schema.parse({
      version: 1,
      ...binding,
      treeId: 'tree_runtime_tools______',
      treeRevision: 1,
      grantRevision: grant.revision,
      semanticLeaseId: 'lease_runtime_tools_____',
      capturedAt: new Date().toISOString(),
      expiresInMs: 2000,
      rootRefs: [],
      nodes: [],
      focusedRef: null,
      focusState: 'none',
      focusRevision: 0,
      completeness: 'complete',
    });
    originals.readSemanticForActor.mockResolvedValue(snapshot);
    originals.streamSemanticForActor.mockResolvedValue({
      eventStreamId: 'private_original_stream_',
      next: async () => null,
      close: streamClose,
    });
    originals.actionSemanticForActor.mockImplementation(async (actor, value) => {
      const current = await actor.refresh();
      expect(actor.current()).toEqual(current);
      const exact = ManagedBrowserSemanticActionSchema.extend({
        request: SemanticActionV1Schema,
      }).parse(value);
      expect(exact.request.eventStreamId).toBe('private_original_stream_');
      const { semanticLeaseId: _lease, ...identity } = exact.request.identity;
      return {
        version: 1,
        requestId: exact.request.requestId,
        identity,
        outcome: 'completed',
      };
    });
    await f.tools.semanticRead(f.context, { binding, grant });
    const {
      capturedAt: _time,
      expiresInMs: _expiry,
      rootRefs: _roots,
      nodes: _nodes,
      focusedRef: _focused,
      focusState: _focus,
      focusRevision: _revision,
      completeness: _complete,
      ...identity
    } = snapshot;
    const request = {
      requestId: 'edit_runtime_tools______',
      identity,
      frameId: 'frame_runtime_tools_____',
      frameNavigationGeneration: 0,
      nodeRef: 'node_runtime_tools______',
      focusRevision: 0,
      action: { kind: 'insertText', text: 'hello' },
    };
    // A copied/public stream selector cannot be accepted by the advertised tool input.
    expect(
      ManagedBrowserSemanticActionSchema.safeParse({
        binding,
        grant,
        controllerId: controlled.controllerId,
        request: { ...request, eventStreamId: 'caller_selected_stream__' },
      }).success
    ).toBe(false);
    const receipt = await f.tools.semanticAction(f.context, {
      binding,
      grant,
      controllerId: controlled.controllerId,
      request,
    });
    expect(receipt.outcome).toBe('completed');
    expect(originals.actionSemanticForActor).toHaveBeenCalledOnce();
    await f.tools.close();
    expect(streamClose).toHaveBeenCalledOnce();
  }
);

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'recipient %s file consumers preserve distinct artifact, file and control selectors through original actor hosts',
  async (runtime) => {
    const originals = optionalReceivers(),
      f = fixture(runtime, originals);
    const controlGrant = f.grant(['browser.view', 'browser.control']);
    const controlled = await f.tools.control(f.context, {
      binding: f.binding(),
      grant: controlGrant,
    });
    const artifactGrant = f.grant(['browser.artifact']),
      uploadGrant = f.grant(['browser.upload']),
      downloadGrant = f.grant(['browser.download']);
    originals.uploadForActor.mockImplementation(
      async (actor, command, controllerId, artifact, upload, control) => {
        const admitted = await actor.refresh();
        expect(admitted.owner).toBe(f.author.id);
        expect(actor.current()).toBe(admitted);
        expect([controllerId, artifact, upload, control]).toEqual([
          controlled.controllerId,
          artifactGrant,
          uploadGrant,
          controlGrant,
        ]);
        const parsed = BrowserUploadRequestSchema.parse(command);
        return originalInputResult({
          kind: 'action',
          requestId: parsed.requestId,
          binding: parsed.binding,
          outcome: 'completed',
        });
      }
    );
    originals.downloadForActor.mockImplementation(
      async (actor, command, controllerId, artifact, download, control) => {
        const admitted = await actor.refresh();
        expect(actor.current()).toBe(admitted);
        expect([controllerId, artifact, download, control]).toEqual([
          controlled.controllerId,
          artifactGrant,
          downloadGrant,
          controlGrant,
        ]);
        const parsed = BrowserDownloadRequestSchema.parse(command);
        return {
          input: {
            kind: 'action',
            requestId: parsed.requestId,
            binding: parsed.binding,
            outcome: 'completed',
          },
          artifact: {
            artifactId: 'download_runtime_tools__',
            byteLength: 5,
            name: 'unit-download.txt',
            mimeType: 'text/plain',
          },
        };
      }
    );
    await f.tools.upload(f.context, {
      command: {
        kind: 'upload',
        requestId: 'upload_runtime_tools____',
        binding: controlled.binding,
        artifactId: 'staged_runtime_tools____',
        activation: { x: 10, y: 20 },
      },
      controllerId: controlled.controllerId,
      artifactGrant,
      uploadGrant,
      controlGrant,
    });
    const downloaded = await f.tools.download(f.context, {
      command: {
        kind: 'download',
        requestId: 'download_runtime_tools__',
        binding: controlled.binding,
        activation: { x: 10, y: 20 },
      },
      controllerId: controlled.controllerId,
      artifactGrant,
      downloadGrant,
      controlGrant,
    });
    expect(downloaded.artifact.byteLength).toBe(5);
    expect(originals.uploadForActor).toHaveBeenCalledOnce();
    expect(originals.downloadForActor).toHaveBeenCalledOnce();
    await f.tools.close();
  }
);

function reservedSemanticSnapshot(
  binding: ReturnType<typeof BrowserBindingSchema.parse>,
  revision: number
) {
  return SemanticSnapshotV1Schema.parse({
    version: 1,
    ...binding,
    treeId: 'tree_runtime_reservation_',
    treeRevision: 1,
    grantRevision: revision,
    semanticLeaseId: 'lease_runtime_reserved__',
    capturedAt: new Date().toISOString(),
    expiresInMs: 2000,
    rootRefs: [],
    nodes: [],
    focusedRef: null,
    focusState: 'none',
    focusRevision: 0,
    completeness: 'complete',
  });
}
it('a held original semantic stream reserves its exact key and cannot be overwritten by another read', async () => {
  const originals = optionalReceivers(),
    f = fixture('claude-code', originals),
    grant = f.grant(['browser.view']);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.releases.push(release);
  const close = vi.fn(async () => {});
  originals.readSemanticForActor.mockImplementation(async (_actor, value) => {
    const exact = ManagedBrowserTabsSchema.parse(value);
    return reservedSemanticSnapshot(exact.binding, exact.grant.revision);
  });
  originals.streamSemanticForActor.mockImplementation(async () => {
    await held;
    return {
      eventStreamId: 'stream_runtime_reserved_',
      next: async () => null,
      close,
    };
  });
  const first = f.tools.semanticRead(f.context, {
    binding: f.binding(),
    grant,
  });
  f.pending.push(first);
  await vi.waitFor(() => expect(originals.streamSemanticForActor).toHaveBeenCalledOnce());
  await expect(
    f.tools.semanticRead(f.context, { binding: f.binding(), grant })
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(originals.readSemanticForActor).toHaveBeenCalledOnce();
  expect(originals.streamSemanticForActor).toHaveBeenCalledOnce();
  release();
  await first;
  await f.tools.close();
  expect(close).toHaveBeenCalledOnce();
});
it('eight held original semantic stream births reserve the complete key capacity before a ninth native read', async () => {
  const originals = optionalReceivers(),
    f = fixture('codex', originals),
    grant = f.grant(['browser.view']);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.releases.push(release);
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  originals.readSemanticForActor.mockImplementation(async (_actor, value) => {
    const exact = ManagedBrowserTabsSchema.parse(value);
    return reservedSemanticSnapshot(exact.binding, exact.grant.revision);
  });
  originals.streamSemanticForActor.mockImplementation(async () => {
    const index = closes.length,
      close = vi.fn(async () => {});
    closes.push(close);
    await held;
    return {
      eventStreamId: `stream_runtime_slot_${index}__`,
      next: async () => null,
      close,
    };
  });
  // Hosts are the original protocol doubles; this control tests the issuer's key/receipt
  // budget, not native tab or grant admission (covered by the actual host controls).
  const binding = (index: number) =>
    BrowserBindingSchema.parse({
      ...f.binding(),
      tabId: `tab_runtime_slot_${index}____`,
    });
  const originalsHeld = Array.from({ length: 8 }, (_, index) =>
    f.tools.semanticRead(f.context, { binding: binding(index), grant })
  );
  f.pending.push(...originalsHeld);
  await vi.waitFor(() => expect(originals.streamSemanticForActor).toHaveBeenCalledTimes(8));
  await expect(
    f.tools.semanticRead(f.context, { binding: binding(8), grant })
  ).rejects.toBeInstanceOf(BrowserApiRefusal);
  expect(originals.readSemanticForActor).toHaveBeenCalledTimes(8);
  release();
  await Promise.all(originalsHeld);
  await f.tools.close();
  expect(closes).toHaveLength(8);
  for (const close of closes) expect(close).toHaveBeenCalledOnce();
});

it('only the current original semantic denial receipt qualifies a plain native refusal, not a later replay', async () => {
  const originals = optionalReceivers(),
    f = fixture('opencode', originals),
    grant = f.grant(['browser.view']);
  const issued = new Error('SEMANTIC_LEASE_REFUSED');
  originals.readSemanticForActor.mockImplementationOnce(async (actor) => {
    actor.onOriginalDenial?.(issued);
    throw issued;
  });
  await expect(f.tools.semanticRead(f.context, { binding: f.binding(), grant })).rejects.toBe(
    issued
  );
  expect(f.tools.available()).toBe(true);
  originals.readSemanticForActor.mockRejectedValueOnce(issued);
  f.expected.add(issued);
  await expect(f.tools.semanticRead(f.context, { binding: f.binding(), grant })).rejects.toBe(
    issued
  );
  await expect(f.tools.close()).rejects.toBe(issued);
  expect(originals.streamSemanticForActor).not.toHaveBeenCalled();
});

it('original principal-current reentrant close fences the next author lookup inside grant admission', async () => {
  const f = fixture('codex'),
    grant = f.grant(['browser.view']);
  let calls = 0;
  const bank: { close?: Promise<void> } = {};
  f.principals.isPrincipalCurrent.mockImplementation(() => {
    if (++calls === 3) bank.close = f.tools.close();
    return true;
  });
  const original = f.tools.tabs(f.context, { binding: f.binding(), grant });
  f.pending.push(original);
  const refusal = await original.then(
    () => {
      throw new Error('Original admission unexpectedly completed');
    },
    (reason: unknown) => {
      f.expected.add(reason);
      return reason;
    }
  );
  expect(refusal).toBeInstanceOf(BrowserApiRefusal);
  expect(calls).toBe(3);
  // Initial mapping and its actual current revalidation precede the callback loss.
  expect(f.authors.resolveAgent).toHaveBeenCalledTimes(2);
  expect(f.listTabs).not.toHaveBeenCalled();
  await bank.close;
});
it('original initial author mapping reentrant close refuses before a second mapping producer', async () => {
  const f = fixture('opencode'),
    grant = f.grant(['browser.view']);
  const bank: { close?: Promise<void> } = {};
  f.authors.resolveAgent.mockImplementationOnce(() => {
    bank.close = f.tools.close();
    return f.author;
  });
  const original = f.tools.tabs(f.context, { binding: f.binding(), grant });
  f.pending.push(original);
  const refusal = await original.then(
    () => {
      throw new Error('Original admission unexpectedly completed');
    },
    (reason: unknown) => {
      f.expected.add(reason);
      return reason;
    }
  );
  expect(refusal).toBeInstanceOf(BrowserApiRefusal);
  expect(f.authors.resolveAgent).toHaveBeenCalledOnce();
  expect(f.listTabs).not.toHaveBeenCalled();
  await bank.close;
});

it('an original tool input getter throwing a fresh ZodError is sticky, not a local parser denial', async () => {
  const f = fixture('codex'),
    grant = f.grant(['browser.view']);
  const originalFailure = new z.ZodError([]);
  const getter = vi.fn(() => {
    throw originalFailure;
  });
  const value = {
    get binding() {
      return getter();
    },
    grant,
  };
  f.expected.add(originalFailure);
  const original = f.tools.tabs(f.context, value);
  f.pending.push(original);
  await expect(original).rejects.toBe(originalFailure);
  await expect(f.tools.tabs(f.context, { binding: f.binding(), grant })).rejects.toBe(
    originalFailure
  );
  expect(getter).toHaveBeenCalledOnce();
  expect(f.principals.revalidatePrincipal).not.toHaveBeenCalled();
  expect(f.listTabs).not.toHaveBeenCalled();
  await expect(f.tools.close()).rejects.toBe(originalFailure);
});
