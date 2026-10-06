/**
 * The app-server leg of Codex's conformance run (spec
 * `codex-app-server-transport` §17): a `CodexRuntime` on the app-server
 * transport, over the fake app-server, plus the drivers its capabilities
 * require (`warmSession`, `hangingInterrupt`, `creditsTurn`, `mediaTurn`).
 *
 * Credits are proven end to end rather than asserted: a credits thread's fake
 * Codex sends one request to the provider its thread config names — the REAL
 * loopback credits relay — with the key it was handed, and the relay forwards
 * it upstream to a capturing `fetch`. So "the token reached the credits
 * endpoint, and only through the relay" is observed, not assumed.
 */
import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ApprovalEvent, InterruptReceipt, StreamEvent } from '@dorkos/shared/types';
import type { DirectoryGrant } from '@dorkos/shared/agent-runtime';
import type { CreditsTurnObservation, CreditsTurnScenario, HandedGrants } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { startCreditsRelay, type CreditsRelay } from '../../../core/cloud/credits-relay.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { CodexAppServerPool } from '../app-server/process-pool.js';
import { AppServerCodexTransport } from '../transport/app-server-transport.js';
import { expect, vi } from 'vitest';
import {
  driveApprovalTurn,
  driveDispositionTurn,
} from '../../../session/__tests__/durable-turn-harness.js';
import {
  approvalTurn,
  FakeAppServerHost,
  hangingTurn,
  heldSteerableTurn,
  pongTurn,
  type FakeTurnScript,
} from './fake-app-server.js';

/** The Codex homes the fake leg runs on. */
const PERSON_HOME = '/fake/conformance/person';
const CREDITS_HOME = '/fake/conformance/credits';

/** One request the relay sent upstream. */
export interface UpstreamRequest {
  url: string;
  authorization: string | null;
}

/** Everything one app-server runtime was wired with, for a driver to read. */
interface Wiring {
  host: FakeAppServerHost;
  pool: CodexAppServerPool;
}

const wirings = new WeakMap<AgentRuntime, Wiring>();
const pools: CodexAppServerPool[] = [];
let relay: CreditsRelay | undefined;
/** Every request the shared relay forwarded upstream. */
export const upstreamRequests: UpstreamRequest[] = [];

/**
 * The fake's default turn: on a credits thread, first send one request to the
 * provider the thread was configured with (what Codex does), then answer.
 */
const creditsAwareTurn: FakeTurnScript = async (ctx) => {
  const loaded = ctx.server.loaded.get(ctx.turn.threadId);
  const config = (loaded?.loadParams.config ?? {}) as {
    model_provider?: string;
    model_providers?: Record<string, { base_url: string; experimental_bearer_token: string }>;
  };
  const provider = config.model_provider
    ? config.model_providers?.[config.model_provider]
    : undefined;
  if (provider) {
    const res = await fetch(`${provider.base_url.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.experimental_bearer_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'conformance', input: 'ping' }),
    });
    await res.text();
  }
  pongTurn(ctx);
};

/** Start the shared loopback relay (real server, capturing upstream fetch). */
export async function startConformanceRelay(): Promise<void> {
  relay = await startCreditsRelay({
    fetchImpl: (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      upstreamRequests.push({ url: String(url), authorization: headers.get('authorization') });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}

/** Stop everything the app-server leg started. */
export async function stopAppServerConformance(): Promise<void> {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
  await relay?.close();
  relay = undefined;
}

/**
 * A fresh `CodexRuntime` on the app-server transport over a fresh fake host.
 *
 * @param options - Where images go, and a stop-ack bound.
 */
export function makeAppServerRuntime(
  options: { attachments?: SessionAttachmentStore; stopAckMs?: number } = {}
): CodexRuntime {
  const host = new FakeAppServerHost();
  host.home(PERSON_HOME).defaultScript = creditsAwareTurn;
  host.home(CREDITS_HOME).defaultScript = creditsAwareTurn;
  const pool = new CodexAppServerPool({ spawn: host.spawn, timing: { shutdownStepMs: 10 } });
  pools.push(pool);
  const transport = new AppServerCodexTransport({
    pool,
    connectorTools: () => undefined,
    creditsRelay: () => relay,
    environment: {
      person: () => ({ PATH: '/usr/bin', CODEX_HOME: PERSON_HOME }),
      credits: () => ({ PATH: '/usr/bin', CODEX_HOME: CREDITS_HOME }),
    },
    stopAckMs: options.stopAckMs ?? 3_000,
  });
  const runtime = new CodexRuntime({
    threadMap: new CodexThreadMap(createTestDb()),
    resolveBinary: async () => '/opt/codex',
    transport,
    ...(options.attachments ? { attachments: options.attachments } : {}),
  });
  wirings.set(runtime, { host, pool });
  return runtime;
}

function wiringOf(runtime: AgentRuntime): Wiring {
  const wiring = wirings.get(runtime);
  if (!wiring) throw new Error('not an app-server conformance runtime');
  return wiring;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/**
 * `compactIntentTurn` (DOR-2732): a conversation of one turn, then the
 * summary a person's `/compact` or the agent's request runs —
 * `thread/compact/start` on that thread. Runs unchanged against the real
 * binary in the live arm.
 *
 * @param runtime - An app-server runtime.
 * @param projectDir - Its working directory.
 */
export async function appServerCompactIntentTurn(
  runtime: AgentRuntime,
  projectDir: string
): Promise<StreamEvent[]> {
  const sessionId = randomUUID();
  runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
  await drain(
    runtime.sendMessage(sessionId, 'Reply with the single word: hi', { cwd: projectDir })
  );
  return drain(runtime.executeCommandIntent(sessionId, 'compact', { cwd: projectDir }));
}

/**
 * `makeCompactingRuntime` (DOR-110): a runtime whose next turn has Codex
 * summarize on its own partway through (a `contextCompaction` item inside an
 * ordinary turn), then answer.
 */
export function makeAutoCompactingAppServerRuntime(): CodexRuntime {
  const runtime = makeAppServerRuntime();
  wiringOf(runtime)
    .host.home(PERSON_HOME)
    .nextTurn((ctx) => {
      const item = { type: 'contextCompaction', id: 'compact-auto' };
      ctx.emit('item/started', { item });
      ctx.tokenUsage(4_000, 200_000);
      ctx.emit('item/completed', { item });
      pongTurn(ctx);
    });
  return runtime;
}

/**
 * `warmSession`: one completed turn, the thread left loaded in a live process.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param projectDir - Its working directory.
 */
export async function warmAppServerSession(
  runtime: AgentRuntime,
  sessionId: string,
  projectDir: string
): Promise<void> {
  await drain(runtime.sendMessage(sessionId, 'warm up', { cwd: projectDir }));
}

/**
 * `hangingInterrupt`: a turn that is genuinely open on a Codex that never
 * acknowledges a stop. There is no session-scoped escalation (killing the
 * process would end every other chat in that home), so the receipt is
 * `unconfirmed`.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param projectDir - Its working directory.
 */
export async function hangAppServerInterrupt(
  runtime: AgentRuntime,
  sessionId: string,
  projectDir: string
): Promise<InterruptReceipt> {
  wiringOf(runtime).host.home(PERSON_HOME).nextTurn(hangingTurn);
  const turn = runtime.sendMessage(sessionId, 'keep going', { cwd: projectDir });
  for (;;) {
    const next = await turn.next();
    if (next.done || next.value.type === 'text_delta') break;
  }
  return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'codex' };
}

/**
 * `mediaTurn`: an MCP tool answers with a picture.
 *
 * @param runtime - The runtime (wired with an attachment store).
 * @param projectDir - Its working directory.
 */
export async function appServerMediaTurn(
  runtime: CodexRuntime,
  projectDir: string
): Promise<StreamEvent[]> {
  const image = {
    type: 'mcpToolCall',
    id: 'shot',
    server: 'browser',
    tool: 'screenshot',
    status: 'completed',
    arguments: {},
    result: { content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] },
    error: null,
  };
  wiringOf(runtime)
    .host.home(PERSON_HOME)
    .nextTurn((ctx) => {
      ctx.emit('item/started', { item: { ...image, status: 'inProgress', result: null } });
      // Published twice on purpose: one picture must still be one announcement.
      ctx.emit('item/completed', { item: image });
      ctx.emit('item/completed', { item: image });
      ctx.agentMessage('done');
      ctx.complete('completed');
    });
  const sessionId = randomUUID();
  runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
  return drain(runtime.sendMessage(sessionId, 'take a screenshot', { cwd: projectDir }));
}

/**
 * `creditsTurn`: run one turn and report everything Codex was handed — every
 * spawn's argv and environment, every request it received — plus every
 * request the credits relay forwarded upstream for it.
 *
 * @param runtime - The runtime.
 * @param scenario - What the session runs on.
 * @param projectDir - Its working directory.
 * @param arrange - Installs the scenario on the host (token, default) and
 *   returns its undo.
 */
export async function appServerCreditsTurn(
  runtime: AgentRuntime,
  scenario: CreditsTurnScenario,
  projectDir: string,
  arrange: (scenario: CreditsTurnScenario) => () => void
): Promise<CreditsTurnObservation> {
  const { host } = wiringOf(runtime);
  const undo = arrange(scenario);
  try {
    const spawnsBefore = host.spawns.length;
    const turnsBefore = host.processes.flatMap((p) => p.requestsOf('turn/start')).length;
    const upstreamBefore = upstreamRequests.length;
    const sessionId = randomUUID();
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
    const events = await drain(
      runtime.sendMessage(sessionId, 'conformance ping', { cwd: projectDir })
    );
    const turns = host.processes.flatMap((p) => p.requestsOf('turn/start'));
    return {
      launched: host.spawns.length > spawnsBefore || turns.length > turnsBefore,
      handed: {
        spawns: host.spawns,
        received: host.processes.map((p) => p.received),
        upstream: upstreamRequests.slice(upstreamBefore),
      },
      events,
    };
  } finally {
    undo();
  }
}

/**
 * `directoryGrantTurns`: two turns on one session, each with its own grants,
 * read back from the `sandboxPolicy` each `turn/start` carried.
 *
 * The session runs in `acceptEdits` (workspace-write) because that is the only
 * Codex sandbox with writable roots to add a grant to: read-only has none and
 * full access needs none. Every Codex sandbox reads the whole disk, so a read
 * grant is read-open whenever a policy was sent.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param grants - Each turn's grants.
 * @param projectDir - Its working directory.
 */
export async function appServerDirectoryGrantTurns(
  runtime: AgentRuntime,
  sessionId: string,
  grants: readonly [readonly DirectoryGrant[], readonly DirectoryGrant[]],
  projectDir: string
): Promise<readonly [HandedGrants, HandedGrants]> {
  const { host } = wiringOf(runtime);
  await runtime.updateSession(sessionId, { permissionMode: 'acceptEdits' });
  const before = host.processes.flatMap((p) => p.requestsOf('turn/start')).length;
  for (const additionalDirectories of grants) {
    await drain(
      runtime.sendMessage(sessionId, 'conformance ping', {
        cwd: projectDir,
        additionalDirectories: [...additionalDirectories],
      })
    );
  }
  const starts = host.processes.flatMap((p) => p.requestsOf('turn/start')).slice(before);
  const handedFor = (turn: 0 | 1): HandedGrants => {
    const policy = starts[turn]?.sandboxPolicy as
      { type?: string; writableRoots?: string[] } | undefined;
    return {
      writable: [...(policy?.writableRoots ?? [])],
      readOnly: [],
      readOpen: policy
        ? grants[turn].filter((grant) => grant.access === 'read').map((g) => g.path)
        : [],
    };
  };
  return [handedFor(0), handedFor(1)] as const;
}

/**
 * `systemPromptAppendTurns`: two turns on ONE loaded thread, each with its own
 * append, read back from the prompt each `turn/start` carried. The second turn
 * must reuse the thread the first loaded — a second `thread/start` would make
 * two unrelated conversations satisfy every assertion.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param appends - Each turn's `systemPromptAppend`.
 * @param projectDir - Its working directory.
 */
export async function appServerSystemPromptAppendTurns(
  runtime: AgentRuntime,
  sessionId: string,
  appends: readonly [string, string],
  projectDir: string
): Promise<readonly [string, string]> {
  const { host } = wiringOf(runtime);
  const startsBefore = host.processes.flatMap((p) => p.requestsOf('thread/start')).length;
  const turnsBefore = host.processes.flatMap((p) => p.requestsOf('turn/start')).length;
  for (const systemPromptAppend of appends) {
    await drain(
      runtime.sendMessage(sessionId, 'conformance ping', { cwd: projectDir, systemPromptAppend })
    );
  }
  const starts = host.processes.flatMap((p) => p.requestsOf('thread/start')).slice(startsBefore);
  const turns = host.processes.flatMap((p) => p.requestsOf('turn/start')).slice(turnsBefore);
  if (starts.length !== 1 || turns.length !== 2 || turns[0]!.threadId !== turns[1]!.threadId) {
    throw new Error('the second turn was supposed to run on the thread the first one loaded');
  }
  const promptOf = (params: Record<string, unknown>) =>
    ((params.input as Array<{ text?: string }> | undefined) ?? [])
      .map((input) => input.text ?? '')
      .join('');
  return [promptOf(turns[0]!), promptOf(turns[1]!)] as const;
}

/**
 * A runtime whose next turn fails the way the real binary reports a failed
 * turn: an `error` notification Codex will not retry, then `turn/completed`
 * with `status: 'failed'` repeating it.
 *
 * @param message - The vendor's own words.
 * @param codexErrorInfo - Codex's machine reason (`unauthorized` for a dead sign-in).
 */
export function makeFailingAppServerRuntime(
  message: string,
  codexErrorInfo: unknown = 'other'
): CodexRuntime {
  const runtime = makeAppServerRuntime();
  wiringOf(runtime)
    .host.home(PERSON_HOME)
    .nextTurn((ctx) => {
      ctx.emit('error', { error: { message, codexErrorInfo }, willRetry: false });
      ctx.complete('failed', { message, codexErrorInfo, additionalDetails: null });
    });
  return runtime;
}

/**
 * `dispositionTurn` (C1): a turn held open on the fake until it is stopped,
 * a steer delivered into it mid-flight, then a stop. The fake refuses a steer
 * whose `expectedTurnId` is not the running turn's and starts no turn for one
 * (the binary's behaviour, verified on 0.154), so "delivered, same turn" is
 * observed rather than assumed.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param content - The message that opens the turn.
 * @param projectDir - Its working directory.
 * @param probes - The suite's mid-turn probe.
 */
export function appServerDispositionTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  projectDir: string,
  probes: { midTurn: () => Promise<void> }
): Promise<void> {
  const { host } = wiringOf(runtime);
  host.home(PERSON_HOME).nextTurn(heldSteerableTurn);
  return driveDispositionTurn(runtime, sessionId, content, projectDir, probes, {
    awaitOpen: () =>
      vi.waitFor(async () => {
        const snapshot = await runtime.getSessionSnapshot(
          { cwd: projectDir, permissionMode: 'default' },
          sessionId
        );
        expect(snapshot.status.lifecycle).toBe('streaming');
        expect(host.processes.some((p) => p.requestsOf('turn/start').length > 0)).toBe(true);
      }),
    endTurn: async () => {
      await runtime.interruptQuery(sessionId);
    },
  });
}

/**
 * `approvalTurn`: Codex asks before running a command, the way 0.154 does
 * (`item/started`, then the approval request); approved it runs, declined it
 * is reported declined, cancelled the turn waits for its stop.
 *
 * @param runtime - The runtime.
 * @param sessionId - The session.
 * @param content - The message that leads Codex to ask.
 * @param projectDir - Its working directory.
 * @param probes - The suite's probes.
 */
export function appServerApprovalTurn(
  runtime: AgentRuntime,
  sessionId: string,
  content: string,
  projectDir: string,
  probes: {
    atApproval: (approval: ApprovalEvent) => Promise<void>;
    afterTurn: () => Promise<void>;
  }
): Promise<StreamEvent[]> {
  wiringOf(runtime).host.home(PERSON_HOME).nextTurn(approvalTurn);
  return driveApprovalTurn(runtime, sessionId, content, projectDir, probes);
}
