import { BrowserApiRefusal } from '../../api/service.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boundedOriginalFile, sha256, type PublicNativeInput } from './public-native-input.js';
import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import {
  BrowserBindingSchema,
  BrowserControlSchema,
  BrowserActionReceiptSchema,
  type BrowserBinding,
  type BrowserControl,
} from '@dorkos/shared/browser-schemas';
import type { CodexRuntime } from '../../../runtimes/codex/codex-runtime.js';
import type { CodexTransport } from '../../../runtimes/codex/transport/index.js';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import type { CapabilityHandlerContext } from '../../../core/capabilities/registry.js';
import type {
  ConnectorRuntimePrincipalPort,
  OpenConnectorTurnInput,
  ConnectorTurnOwnership,
} from '../../../connectors/runtime-principal-port.js';
import type { AgentIdentitySnapshotPrincipalPort } from '../../../runtimes/connector-mcp/agent-identity-snapshots.js';
import type { createManagedBrowserRuntimeTools } from '../runtime-tools.js';
import type {
  OriginalInputAcceptanceObserver,
  installOriginalInputAcceptanceObserver,
} from '../../../../../../../packages/browser/src/input/acceptance-observer.js';
type OriginalObserverInstaller = typeof installOriginalInputAcceptanceObserver;

/** Resolve the private observer beside the genuine package runtime; source and dist have different banks. */
export async function resolveOriginalInputAcceptanceObserver(
  input: PublicNativeInput,
  current: () => void
): Promise<OriginalObserverInstaller> {
  const url = new URL('./input/acceptance-observer.js', import.meta.resolve('@dorkos/browser'));
  const path = fileURLToPath(url);
  const guardBytes = await boundedOriginalFile(input.emittedGuard, 1024 * 1024, current);
  if (sha256(guardBytes) !== input.emittedGuardSHA256)
    throw new Error('HANDOFF_ORIGINAL_EMITS_CHANGED');
  const guard = z
    .object({ files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)) })
    .strict()
    .parse(JSON.parse(guardBytes.toString('utf8')));
  const expected = guard.files[path];
  if (!expected || sha256(await boundedOriginalFile(path, 32 * 1024 * 1024, current)) !== expected)
    throw new Error('HANDOFF_ORIGINAL_OBSERVER_EMIT_REQUIRED');
  current();
  const original: typeof import('../../../../../../../packages/browser/src/input/acceptance-observer.js') =
    await import(url.href);
  current();
  return original.installOriginalInputAcceptanceObserver.bind(original);
}

function fact(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}
function cell<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const decode = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
type OwnerRequest = (
  path: string,
  document?: unknown,
  allowed?: number[]
) => Promise<{ response: { status: number }; bytes: Uint8Array }>;
type RuntimeTools = ReturnType<typeof createManagedBrowserRuntimeTools>;
const completion = new WeakSet<object>();
/** A private setup-terminal sentinel; it is never a success receipt or a provider response. */
export function isHandoffFixtureCompletion(value: unknown): boolean {
  return typeof value === 'object' && value !== null && completion.has(value);
}

/** Install this port ONLY in the isolated CodexRuntime before sendMessage. Codex's
 * real activeTurns slot and ownership closure already exist when openTurn runs.
 * The original snapshot/principal service authenticates the real turn unchanged.
 * This function never returns from openTurn, so Codex cannot reach its provider
 * call after principal setup. A separate real provider-entry observer must remain
 * zero and the runtime driver must join its actual turn generator to terminal. */
export function createNoModelHandoffTurnPort(
  original: AgentIdentitySnapshotPrincipalPort,
  expected: Pick<
    OpenConnectorTurnInput,
    'runtime' | 'canonicalSessionId' | 'agentPath' | 'canonicalCwd'
  >,
  run: (context: CapabilityHandlerContext) => Promise<void>,
  assertProviderNotEntered: () => void
) {
  const done = cell<
    Readonly<{
      status: 'passed' | 'failed';
      failure?: Readonly<{ value: unknown }>;
    }>
  >();
  const open = original.openTurn.bind(original),
    resolve = original.resolve.bind(original),
    revoke = original.revoke.bind(original),
    identityFor = original.identityFor.bind(original);
  let entered = false;
  let completed: Awaited<typeof done.promise> | undefined;
  let owned: ConnectorTurnOwnership | undefined;
  const port: ConnectorRuntimePrincipalPort = {
    renew: original.renew.bind(original),
    resolve,
    revoke,
    async openTurn(input: OpenConnectorTurnInput, ownership: ConnectorTurnOwnership) {
      fact(!entered, 'HANDOFF_FIXTURE_REENTRY');
      entered = true;
      owned = ownership;
      let first: Readonly<{ value: unknown }> | undefined;
      let binding: Awaited<ReturnType<typeof open>> | undefined;
      let principal: ServerPrincipalProof | undefined;
      try {
        fact(
          input.runtime === 'codex' &&
            input.runtime === expected.runtime &&
            input.canonicalSessionId === expected.canonicalSessionId &&
            input.agentPath === expected.agentPath &&
            input.canonicalCwd === expected.canonicalCwd,
          'HANDOFF_WRONG_ORIGINAL_TURN'
        );
        fact(ownership.isCurrent(), 'HANDOFF_ORIGINAL_ADAPTER_SLOT_ABSENT');
        assertProviderNotEntered();
        binding = await open(input, ownership);
        const actual = await resolve({
          bearer: binding.bearer,
          expectedRuntime: input.runtime,
          ...(input.canonicalCwd ? { expectedCanonicalCwd: input.canonicalCwd } : {}),
        });
        fact(actual.status === 'resolved', 'HANDOFF_GENUINE_PRINCIPAL_REFUSED');
        principal = actual.principal;
        const identity = await identityFor(principal);
        fact(identity && !identity.inactive, 'HANDOFF_FROZEN_IDENTITY_ABSENT');
        await run({
          identity,
          agentIdentityPresented: true,
          serverPrincipal: actual.principal,
          sessionId: input.canonicalSessionId,
          cwd: input.agentPath,
          signal: input.signal,
        });
        assertProviderNotEntered();
      } catch (value) {
        first = { value };
      } finally {
        if (binding) {
          try {
            await revoke(binding.bindingId, 'setup_failed');
            const refused = await resolve({
              bearer: binding.bearer,
              expectedRuntime: input.runtime,
              ...(input.canonicalCwd ? { expectedCanonicalCwd: input.canonicalCwd } : {}),
            });
            fact(refused.status === 'refused', 'HANDOFF_FIXTURE_BINDING_NOT_REVOKED');
            fact(
              principal && (await identityFor(principal)) === undefined,
              'HANDOFF_FIXTURE_IDENTITY_NOT_REVOKED'
            );
          } catch (value) {
            first ??= { value };
          }
        }
        try {
          assertProviderNotEntered();
        } catch (value) {
          first ??= { value };
        }
        completed = first ? { status: 'failed', failure: first } : { status: 'passed' };
        done.resolve(completed);
      }
      if (first) throw first.value;
      const sentinel = Object.freeze({
        kind: 'managed-browser-fixture-complete',
      });
      completion.add(sentinel);
      throw sentinel;
    },
  };
  return Object.freeze({
    port,
    done: done.promise,
    result: () => completed,
    assertTurnReleased() {
      fact(owned && !owned.isCurrent(), 'HANDOFF_ORIGINAL_ADAPTER_SLOT_STILL_ACTIVE');
    },
  });
}

/** Original native acknowledgements only; queued and held work are causally
 * admitted before each transition. The observer retains no text or credentials. */
export async function runRealHumanAgentHandoffs100(options: {
  context: CapabilityHandlerContext;
  installInputObserver: OriginalObserverInstaller;
  tools: RuntimeTools;
  grant: { grantId: string; revision: number };
  initial: BrowserBinding;
  ownerRequest: OwnerRequest;
  /** Actual fixture page DOM pointer event, received at the approved HTTP receiver. */
  receivePointer: (
    x: number,
    y: number,
    signal: AbortSignal
  ) => Promise<{
    trusted: boolean;
    buttons: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
  }>;
  retain: (report: unknown) => Promise<void>;
}) {
  let binding = BrowserBindingSchema.parse(options.initial);
  const subject = {
    browserId: binding.browserId,
    browserGeneration: binding.browserGeneration,
    tabId: binding.tabId,
  };
  const events: { kind: string; key?: string; button?: string; at: number }[] = [];
  let hold: ReturnType<typeof cell<void>> | undefined,
    held: ReturnType<typeof cell<void>> | undefined,
    queued: ReturnType<typeof cell<void>> | undefined,
    queuedId: string | undefined,
    fence: number | undefined;
  const readFence = () => fence;
  const observer: OriginalInputAcceptanceObserver = {
    matches: (b) =>
      b.browserId === subject.browserId &&
      b.browserGeneration === subject.browserGeneration &&
      b.tabId === subject.tabId,
    admitted: (id) => {
      if (id === queuedId) queued?.resolve();
    },
    resetPublished: () => {
      fence = performance.now();
    },
    async afterNativeAcknowledgement(step, _binding, signal) {
      events.push({
        kind: step.kind,
        ...('key' in step ? { key: step.key } : {}),
        ...('button' in step ? { button: step.button } : {}),
        at: performance.now(),
      });
      if (step.kind !== 'mouseMove' || step.x !== 20 || step.y !== 20 || !hold) return;
      const original = hold;
      const release = () => original.resolve();
      signal.addEventListener('abort', release, { once: true });
      if (signal.aborted) release();
      held?.resolve();
      try {
        await original.promise;
      } finally {
        signal.removeEventListener('abort', release);
      }
    },
    dispose: () => {
      hold?.resolve();
    },
  };
  const observed = options.installInputObserver(observer);
  const report = {
    status: 'FAIL',
    qualification:
      '100 real human-agent transitions with real CDP preedit reset; OS IME/candidate placement, resource/render/accessibility unqualified',
    requested: 100,
    completed: 0,
    samples: [] as {
      round: number;
      direction: string;
      responseMs: number;
      fenceMs: number;
      resetMs: number;
      oldQueuedRefused: boolean;
      oldTailAbsent: boolean;
      unmodifiedFirstEvent: boolean;
      staleControllerRefused: boolean;
    }[],
    p95ResponseMs: null as number | null,
  };
  let first: Readonly<{ value: unknown }> | undefined;
  const receiverLifetime = new AbortController();
  const jobs = new Set<Promise<unknown>>();
  const join = <T>(job: Promise<T>) => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  };
  const command = (steps: unknown[], scope = binding) => ({
    kind: 'input',
    requestId: randomUUID(),
    binding: scope,
    steps,
  });
  const ownerControl = async () => {
    const returned = await options.ownerRequest('/api/browser/control', binding);
    fact(returned.response.status === 200, 'HUMAN_CONTROL_HTTP_REFUSED');
    return BrowserControlSchema.parse(decode(returned.bytes));
  };
  const agentControl = () =>
    options.tools.control(options.context, { binding, grant: options.grant });
  const input = async (
    actor: 'agent' | 'human',
    control: BrowserControl,
    request: ReturnType<typeof command>
  ) => {
    if (actor === 'agent')
      return BrowserActionReceiptSchema.parse(
        await options.tools.input(options.context, {
          command: request,
          controllerId: control.controllerId,
          grant: options.grant,
        })
      );
    const returned = await options.ownerRequest(
      '/api/browser/input',
      { command: request, controllerId: control.controllerId },
      [200, 403, 404]
    );
    if (returned.response.status !== 200) return { outcome: 'http-refused' as const };
    return BrowserActionReceiptSchema.parse(decode(returned.bytes));
  };
  try {
    let actor: 'agent' | 'human' = 'agent';
    let control = BrowserControlSchema.parse(await agentControl());
    binding = control.binding;
    fact(control.status === 'ready' && control.controllerId, 'INITIAL_AGENT_CONTROL_NOT_READY');
    for (let round = 0; round < 100; round++) {
      const previous = binding;
      const setup = await input(
        actor,
        control,
        command([
          { kind: 'mouseMove', x: 20, y: 20 },
          { kind: 'keyDown', key: 'Shift' },
          { kind: 'mouseDown', button: 'left' },
          { kind: 'composition', text: '中', selectionStart: 1, selectionEnd: 1 },
        ])
      );
      fact(setup.outcome === 'completed', 'REAL_HELD_INPUT_NOT_ACKNOWLEDGED');
      hold = cell<void>();
      held = cell<void>();
      queued = cell<void>();
      fence = undefined;
      const offset = events.length;
      const active = join(
        input(
          actor,
          control,
          command([
            { kind: 'mouseMove', x: 20, y: 20 },
            { kind: 'text', text: 'OLD_COMPOSITE_TAIL' },
          ])
        )
      );
      await Promise.race([
        held.promise,
        active.then(() => {
          throw new Error('ACTIVE_FINISHED_BEFORE_REAL_HOLD');
        }),
      ]);
      const queuedCommand = command([{ kind: 'text', text: 'OLD_QUEUED_WORK' }]);
      queuedId = queuedCommand.requestId;
      const pending = join(input(actor, control, queuedCommand));
      await Promise.race([
        queued.promise,
        pending.then(() => {
          throw new Error('OLD_QUEUED_WORK_NOT_ADMITTED');
        }),
      ]);
      const next: 'human' | 'agent' = actor === 'agent' ? 'human' : 'agent';
      const started = performance.now();
      const acquired = BrowserControlSchema.parse(
        await (next === 'human' ? ownerControl() : agentControl())
      );
      const ended = performance.now();
      const observedFence = readFence();
      const sample = {
        round,
        direction: `${actor}->${next}`,
        responseMs: ended - started,
        fenceMs: observedFence === undefined ? Number.NaN : observedFence - started,
        resetMs: observedFence === undefined ? Number.NaN : ended - observedFence,
        oldQueuedRefused: false,
        oldTailAbsent: false,
        unmodifiedFirstEvent: false,
        staleControllerRefused: false,
      };
      report.samples.push(sample);
      fact(acquired.status === 'ready' && acquired.controllerId, 'HANDOFF_NOT_READY');
      binding = acquired.binding;
      fact(
        binding.epoch === previous.epoch + 1 &&
          binding.inputGeneration === previous.inputGeneration + 1,
        'HANDOFF_EPOCH_NOT_ADVANCED'
      );
      fact(
        JSON.stringify({
          ...binding,
          epoch: previous.epoch,
          inputGeneration: previous.inputGeneration,
        }) === JSON.stringify(previous),
        'HANDOFF_CANONICAL_TAB_CHANGED'
      );
      fact(
        observedFence !== undefined && observedFence >= started && observedFence <= ended,
        'ORIGINAL_RESET_FENCE_UNOBSERVED'
      );
      const results = await Promise.all([active, pending]);
      const oldQueuedRefused =
        (results[1].outcome === 'rejected' && results[1].reason.reason === 'staleBinding') ||
        results[1].outcome === 'http-refused';
      const oldTailAbsent = !events.slice(offset).some((event) => event.kind === 'text');
      fact(
        oldQueuedRefused && results[0].outcome !== 'completed' && oldTailAbsent,
        'OLD_WORK_CROSSED_HANDOFF'
      );
      fact(
        events.slice(offset).some((e) => e.kind === 'keyUp' && e.key === 'Shift') &&
          events.slice(offset).some((e) => e.kind === 'mouseUp' && e.button === 'left') &&
          events.slice(offset).some((e) => e.kind === 'cancelComposition') &&
          events.slice(offset).some((e) => e.kind === 'cancelDrag'),
        'ORIGINAL_RELEASE_ACKNOWLEDGEMENTS_MISSING'
      );
      // A newly submitted old-controller request is distinct from the already-admitted queue.
      // It must be refused without any real native acknowledgement or replay.
      const staleOffset = events.length;
      let staleControllerRefused = false;
      try {
        const stale = await input(
          actor,
          control,
          command([{ kind: 'text', text: 'STALE_AFTER_REAL_HANDOFF' }], previous)
        );
        staleControllerRefused =
          (stale.outcome === 'rejected' && stale.reason.reason === 'staleBinding') ||
          stale.outcome === 'http-refused';
      } catch (value) {
        // Consume only the actual server API refusal class; never fabricate an input receipt.
        if (!(value instanceof BrowserApiRefusal) || value.reason !== 'inaccessible') throw value;
        staleControllerRefused = true;
      }
      fact(
        staleControllerRefused && events.length === staleOffset,
        'STALE_CONTROLLER_REQUEST_REPLAYED'
      );
      sample.staleControllerRefused = staleControllerRefused;
      hold = undefined;
      held = undefined;
      queued = undefined;
      queuedId = undefined;
      const x = next === 'human' ? 48 : 60,
        y = 100 + round;
      const pointer = join(options.receivePointer(x, y, receiverLifetime.signal));
      const firstInput = await input(next, acquired, command([{ kind: 'mouseMove', x, y }]));
      fact(firstInput.outcome === 'completed', 'FIRST_NEW_ACTOR_INPUT_NOT_COMPLETED');
      const actual = await pointer;
      const unmodifiedFirstEvent =
        actual.trusted &&
        actual.buttons === 0 &&
        !actual.shiftKey &&
        !actual.ctrlKey &&
        !actual.altKey &&
        !actual.metaKey;
      fact(unmodifiedFirstEvent, 'FIRST_NEW_ACTOR_EVENT_STILL_MODIFIED');
      observed.assertHealthy();
      Object.assign(sample, {
        oldQueuedRefused,
        oldTailAbsent,
        unmodifiedFirstEvent,
      });
      report.completed++;
      fact(sample.fenceMs < 100 && sample.resetMs <= 2000, 'HANDOFF_SPEC_BOUND_EXCEEDED');
      actor = next;
      control = acquired;
    }
    const times = report.samples.map((s) => s.responseMs).sort((a, b) => a - b);
    report.p95ResponseMs = times[Math.ceil(times.length * 0.95) - 1]!;
    fact(report.p95ResponseMs < 100, 'HANDOFF_RESPONSE_P95_EXCEEDED');
    report.status = 'PASS_TRANSITIONS';
  } catch (value) {
    first = { value };
  } finally {
    receiverLifetime.abort();
    try {
      observed.close();
    } catch (value) {
      first ??= { value };
    }
    const settled = await Promise.allSettled([...jobs]);
    for (const result of settled)
      if (result.status === 'rejected') first ??= { value: result.reason };
    try {
      await options.retain(report);
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
  return binding;
}

/** Capture the real selected transport, refusing before any provider call if the
 * no-model seam unexpectedly returns. Other methods retain their original
 * receiver (including class-private fields); nothing yields a fake model event. */
export function guardOriginalCodexTransport(original: CodexTransport) {
  let attempted = 0;
  const methods = new Map<PropertyKey, unknown>();
  const transport = new Proxy(original, {
    get(target, key) {
      if (key === 'runTurn')
        return () => {
          attempted++;
          throw new Error('HANDOFF_PROVIDER_ENTRY_FORBIDDEN');
        };
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(key)) methods.set(key, value.bind(target));
      return methods.get(key);
    },
  });
  return Object.freeze({
    transport,
    assertNotEntered() {
      fact(attempted === 0, 'HANDOFF_PROVIDER_WAS_REACHED');
    },
  });
}

/** Execute through the actual adapter, joining its generator/finally. The caller
 * supplies the fresh boot's original runtime and connector tools, with the
 * canonical session already registered through the real runtime registry. */
export async function driveOriginalCodexHandoffTurn(options: {
  runtime: CodexRuntime;
  connectorTools: Parameters<CodexRuntime['setConnectorRuntimeTools']>[0];
  principals: AgentIdentitySnapshotPrincipalPort;
  expected: Pick<
    OpenConnectorTurnInput,
    'runtime' | 'canonicalSessionId' | 'agentPath' | 'canonicalCwd'
  >;
  messageOptions: Parameters<CodexRuntime['sendMessage']>[2];
  run: (context: CapabilityHandlerContext) => Promise<void>;
  assertProviderNotEntered: () => void;
}) {
  const fixture = createNoModelHandoffTurnPort(
    options.principals,
    options.expected,
    options.run,
    options.assertProviderNotEntered
  );
  options.runtime.setConnectorRuntimeTools({
    ...options.connectorTools,
    principals: fixture.port,
  });
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    try {
      for await (const _event of options.runtime.sendMessage(
        options.expected.canonicalSessionId,
        'Managed browser no-model acceptance fixture',
        options.messageOptions
      )) {
        /* drain original runtime events; never forge a provider result */
      }
      throw new Error('HANDOFF_TURN_RETURNED_WITHOUT_COMPLETION_SENTINEL');
    } catch (value) {
      if (!isHandoffFixtureCompletion(value)) first = { value };
    }
    const result = fixture.result();
    fact(result, 'HANDOFF_ORIGINAL_PRINCIPAL_SEAM_NOT_ENTERED');
    if (result.failure) first ??= result.failure;
    fixture.assertTurnReleased();
    options.assertProviderNotEntered();
  } catch (value) {
    first ??= { value };
  } finally {
    options.runtime.setConnectorRuntimeTools(options.connectorTools);
  }
  if (first) throw first.value;
}

/** Compose the real runtime birth/tools/close with the ordinary signed owner
 * routes. Keep this callback inside the genuine turn wrapper above: native
 * close completes before the wrapper revokes that turn's real binding. */
export async function runOriginalBornBrowserHandoff(options: {
  mode: ReturnType<(typeof import('../startup-mode.js'))['createProductionBrowserStartupMode']>;
  principals: import('../../../connectors/principal/runtime-principal-service.js').ConnectorRuntimePrincipalService;
  authors: import('../../../rooms/author-registry.js').AuthorRegistry;
  context: CapabilityHandlerContext;
  ownerRequest: OwnerRequest;
  installInputObserver: OriginalObserverInstaller;
  receiver: Awaited<
    ReturnType<(typeof import('./handoff-page-receiver.fixture.js'))['createHandoffPageReceiver']>
  >;
  retain: (report: unknown) => Promise<void>;
}) {
  // Capture exact original receivers once, before fallible acquisition.
  const open = options.mode.openForRuntime.bind(options.mode),
    close = options.mode.closeForRuntime.bind(options.mode),
    resolve = options.mode.resolveRuntimeTools.bind(options.mode);
  let born: Awaited<ReturnType<typeof open>> | undefined;
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    born = await open(options.principals, options.authors, options.context, {
      requestId: randomUUID(),
      mode: 'ephemeral',
    });
    const tools = resolve(born.binding, options.principals, options.authors);
    const control = BrowserControlSchema.parse(
      await tools.control(options.context, {
        binding: born.binding,
        grant: born.grant,
      })
    );
    const approval = await options.ownerRequest('/api/browser/runtime/local-destination', {
      requestId: randomUUID(),
      binding: control.binding,
      endpoint: options.receiver.url,
      ttlMilliseconds: 180000,
    });
    fact(approval.response.status === 200, 'ORIGINAL_LOCAL_DESTINATION_APPROVAL_REFUSED');
    const navigation = BrowserActionReceiptSchema.parse(
      await tools.navigate(options.context, {
        command: {
          kind: 'navigate',
          requestId: randomUUID(),
          binding: control.binding,
          url: options.receiver.url,
        },
        controllerId: control.controllerId,
        grant: born.grant,
      })
    );
    fact(navigation.outcome === 'completed', 'ORIGINAL_RECEIVER_NAVIGATION_NOT_COMPLETED');
    const tabs = await tools.tabs(options.context, {
      binding: navigation.binding,
      grant: born.grant,
    });
    fact(tabs.length === 1, 'ORIGINAL_RUNTIME_TAB_NOT_UNIQUE');
    await runRealHumanAgentHandoffs100({
      context: options.context,
      installInputObserver: options.installInputObserver,
      tools,
      grant: born.grant,
      initial: tabs[0]!,
      ownerRequest: options.ownerRequest,
      receivePointer: options.receiver.receivePointer,
      retain: options.retain,
    });
  } catch (value) {
    first = { value };
  } finally {
    if (born)
      try {
        const closed = await close(
          options.principals,
          options.authors,
          options.context,
          born.binding
        );
        fact(closed.status === 'stopped', 'ORIGINAL_RUNTIME_BROWSER_CLOSE_NOT_SETTLED');
      } catch (value) {
        first ??= { value };
      }
  }
  try {
    await options.receiver.close();
  } catch (value) {
    first ??= { value };
  }
  if (first) throw first.value;
}
