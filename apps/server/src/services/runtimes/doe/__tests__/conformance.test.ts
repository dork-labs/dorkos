/** Offline engines enter the actual Doe facade and production durable stream harness. */
import { randomUUID } from 'node:crypto';
import { expect, vi, onTestFinished } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { controlUi } from '../../../session/browser-seat/ui-control.js';
import { runtimeConformance, type HandedGrants } from '@dorkos/test-utils';
import type { StreamEvent, Session } from '@dorkos/shared/types';
import { CreditsUnavailableError } from '../../../core/cloud/credits-protocols.js';
import {
  driveDurableTurn,
  driveReloadedHistory,
  drivePresenceTurn,
  driveTerminalOnce,
  driveQueueDurability,
  driveDispositionTurn,
  driveApprovalTurn,
  driveRoomCanvasTurn,
} from '../../../session/__tests__/durable-turn-harness.js';
import {
  makeRuntime,
  controls,
  engine,
  collect,
  projectDir,
  requests,
  model,
  inference,
} from './runtime-fixture.js';
import { DoeRuntime } from '../doe-runtime.js';
import { assembleDoeHost } from '../tools.js';

const vendorText = '401 Unauthorized: invalid API key';
const failed = (message: string) =>
  makeRuntime({
    engineFactory: () =>
      engine(async () => {
        throw new Error(message);
      }),
  });
const success = engine().run;
runtimeConformance(() => makeRuntime(), {
  name: 'DoeRuntime — AgentRuntime conformance',
  hangingInterrupt: async (runtime, id) => {
    let entered = false;
    let release!: () => void;
    controls.get(runtime as DoeRuntime)!.run = async (request) => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { messages: [], scope: request.context.scope, stopReason: 'aborted' };
    };
    const running = collect(runtime.sendMessage(id, 'Keep working', { cwd: projectDir }));
    await vi.waitFor(() => expect(entered).toBe(true));
    onTestFinished(async () => {
      release();
      await running;
    });
    return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'doe' };
  },
  roomCanvasTurn: () => {
    const agentPath = path.join(projectDir, 'ana');
    const otherAgentPath = path.join(projectDir, 'ben');
    mkdirSync(agentPath, { recursive: true });
    mkdirSync(otherAgentPath, { recursive: true });
    return driveRoomCanvasTurn(makeRuntime(), {
      agentPath,
      otherAgentPath,
      produce: async (sessionId) => {
        await controlUi(
          { action: 'open_canvas', content: { type: 'json', data: {}, title: 'The plan' } },
          { sessionId }
        );
      },
    });
  },
  projectDir,
  expectHistory: false,
  makeFailingRuntime: () => failed('The model request failed.'),
  makeCompactingRuntime: () => {
    const runtime = makeRuntime({ resolveModel: async () => ({ ...model, contextWindow: 8192 }) });
    const ensure = runtime.ensureSession.bind(runtime);
    runtime.ensureSession = (id, opts) => {
      ensure(id, opts);
      for (let n = 0; n < 4; n++) {
        runtime.sessions.models.appendMessage(id, {
          role: 'user',
          content: 'Past work '.repeat(8000),
        });
        runtime.sessions.models.appendMessage(id, {
          role: 'assistant',
          content: 'Completed past work.',
        });
      }
    };
    return runtime;
  },
  authFailure: {
    makeRuntime: () => failed(vendorText),
    vendorText,
    hydratedHistory: (runtime, id, content) =>
      driveReloadedHistory(runtime, id, content, projectDir),
  },
  durableHistory: (runtime, id, content) => driveDurableTurn(runtime, id, content, projectDir),
  presenceTurn: (runtime, id, content, probes) =>
    drivePresenceTurn(runtime, id, content, projectDir, probes),
  terminalOnce: () => driveTerminalOnce(projectDir),
  queueDurability: () => driveQueueDurability(),
  contextReadingTurn: async () => {
    const runtime = makeRuntime();
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
    return collect(runtime.sendMessage(id, 'Read usage', { cwd: projectDir }));
  },
  compactIntentTurn: async (observe) => {
    const runtime = makeRuntime();
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
    for (let n = 0; n < 4; n++) await collect(runtime.sendMessage(id, `Turn ${n}`));
    const events: StreamEvent[] = [];
    for await (const event of runtime.executeCommandIntent(id, 'compact')) {
      observe?.(runtime, id);
      events.push(event);
    }
    return events;
  },
  approvalTurn: async (runtime, id, content, probes) => {
    controls.get(runtime as DoeRuntime)!.run = async (request) => {
      const write = request.tools.find((tool) => tool.name === 'write')!;
      request.onEvent({
        type: 'tool-start',
        scope: 'main',
        name: 'write',
        callId: 'approval-write',
      });
      const allowed = await request.approve!(
        write,
        { path: 'file.txt', content: 'change' },
        { ...request.context, callId: 'approval-write' }
      );
      request.onEvent({
        type: 'tool-end',
        scope: 'main',
        name: 'write',
        callId: 'approval-write',
        result: { content: [], ...(allowed === 'deny' ? { isError: true } : {}) },
      });
      return success(request);
    };
    return driveApprovalTurn(runtime, id, content, projectDir, probes);
  },
  dispositionTurn: async (runtime, id, content, probes) => {
    let entered = false;
    let release!: () => void;
    controls.get(runtime as DoeRuntime)!.run = async (request) => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return success(request);
    };
    await driveDispositionTurn(runtime, id, content, projectDir, probes, {
      awaitOpen: () => vi.waitFor(() => expect(entered).toBe(true)),
      endTurn: async () => release(),
    });
  },
  userLastMessageAtSession: async (runtime) => {
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
    await collect(runtime.sendMessage(id, 'A person wrote'));
    const doe = runtime as DoeRuntime;
    const record = doe.sessions.get(id)!;
    record.session.updatedAt = new Date(Date.parse(record.session.updatedAt) + 1000).toISOString();
    doe.sessions.save(record);
    return (await runtime.listSessions(projectDir)).find((session) => session.id === id) as Session;
  },
  systemPromptAppendTurns: async (runtime, id, appends) => {
    const handed: string[] = [];
    for (const append of appends) {
      const count = requests.length;
      await collect(runtime.sendMessage(id, 'Business work', { systemPromptAppend: append }));
      handed.push(requests[count]!.prompt);
    }
    return [handed[0]!, handed[1]!];
  },
  directoryGrantTurns: async (_runtime, _id, grants) => {
    const handed: HandedGrants[] = [];
    const runtime = makeRuntime({
      assembleHost: async (options) => {
        const assembly = await assembleDoeHost(options);
        handed.push({
          writable: [...assembly.pathPolicy.writeRoots],
          readOnly: assembly.pathPolicy.readRoots.filter(
            (root) => !assembly.pathPolicy.writeRoots.includes(root)
          ),
          readOpen: [],
        });
        return assembly;
      },
    });
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
    for (const grant of grants)
      await collect(runtime.sendMessage(id, 'Work', { additionalDirectories: grant }));
    return [handed[0]!, handed[1]!];
  },
  creditsTurn: async (_runtime, scenario) => {
    let launched = false;
    const handed: unknown[] = [];
    const runtime = makeRuntime({
      inference: () => ({
        ...inference,
        source: scenario.runsOn === 'credits' ? 'dorkos-credits' : 'local',
      }),
      resolveModel: async (config) => {
        if (config.source === 'dorkos-credits' && !scenario.heldToken)
          throw new CreditsUnavailableError('not-linked', 'DorkOS');
        return {
          ...model,
          payer: config.source,
          credentials: async () =>
            config.source === 'dorkos-credits' ? scenario.heldToken! : undefined,
        };
      },
      engineFactory: () =>
        engine(async (request) => {
          launched = true;
          handed.push({
            endpoint: request.model.endpoint,
            credential: await request.model.credentials(request.signal),
          });
          return success(request);
        }),
    });
    const id = randomUUID();
    runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
    const events = await collect(runtime.sendMessage(id, 'Work'));
    return { launched, handed, events };
  },
});
