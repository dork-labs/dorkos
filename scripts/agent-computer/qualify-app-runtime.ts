/** Exercise admitted app chat/history without a model turn or VM lifecycle action. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ComputerSessionSchema } from '../../packages/shared/src/computer-schemas.js';
import {
  createComputerRuntime,
  type ComputerRuntimeEndpoint,
} from '../../apps/server/src/services/runtimes/opencode/computer/index.js';
import { ComputerSessionMap } from '../../apps/server/src/services/runtimes/opencode/computer/session-map.js';
import { isRecord } from '../../apps/server/src/services/runtimes/opencode/computer/wire.js';
import {
  privateDirectory,
  writePrivate,
} from '../../apps/server/src/services/computers/backend/private-storage.js';

export interface AppRuntimeQualificationOptions {
  anchor: string;
  sessionMapPath: string;
  evidenceDirectory: string;
  phase: 'seed' | 'resume';
  /** Exact owner-validated running backend endpoint, supplied by the physical-job owner. */
  ensureEndpoint(): Promise<ComputerRuntimeEndpoint>;
  /** Admitted API request, including explicit current owner cookie and X-Client-Id if needed. */
  requestApi(path: string, init?: RequestInit): Promise<Response>;
  onProgress?(step: string): Promise<void> | void;
}

/** Create/read a normal computer agent session; resume only after caller-owned app/VM restart. */
export async function qualifyAdmittedComputerChat(
  options: AppRuntimeQualificationOptions
): Promise<void> {
  await privateDirectory(options.evidenceDirectory);
  const receiptPath = join(options.evidenceDirectory, 'app-runtime-seed.json');
  const progress = async (step: string) => {
    await options.onProgress?.(step);
  };
  const api = async (path: string, init?: RequestInit): Promise<unknown> => {
    assert(
      (init?.method ?? 'GET') === 'GET' ||
        (path === '/api/computers/sessions' && init?.method === 'POST'),
      'QUALIFICATION_APP_INFERENCE_ROUTE_REFUSED'
    );
    const response = await options.requestApi(path, init);
    assert(response.ok, `QUALIFICATION_APP_HTTP_${response.status}`);
    return response.json();
  };
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const shell = request.method === 'POST' && /^\/session\/[^/]+\/shell$/.test(path);
    assert(
      (request.method === 'GET' && path.startsWith('/session')) || shell,
      'QUALIFICATION_SDK_INFERENCE_ROUTE_REFUSED'
    );
    if (shell) {
      const body: unknown = await request.clone().json();
      assert(isRecord(body));
      assert.deepEqual(body.model, { providerID: 'qualification', modelID: 'no-inference' });
    }
    await progress(shell ? 'sdk-shell-request' : 'sdk-session-read');
    return fetch(request);
  };
  let record: { sessionId: string; marker: string; generation: number };
  if (options.phase === 'seed') {
    await progress('normal-session-admission');
    const session = ComputerSessionSchema.parse(
      await api('/api/computers/sessions', { method: 'POST' })
    );
    assert.equal(session.runtime, 'computer-local');
    assert.equal(session.cwd, options.anchor);
    record = {
      sessionId: session.id,
      marker: `app-runtime-proof-${randomUUID()}`,
      generation: (await options.ensureEndpoint()).generation,
    };
    const deadline = Date.now() + 30_000;
    while (
      !new ComputerSessionMap(options.sessionMapPath)
        .listAll()
        .some((row) => row.sessionId === record.sessionId)
    ) {
      assert(Date.now() < deadline, 'QUALIFICATION_APP_BIND_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else {
    record = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof record;
    assert(
      typeof record.sessionId === 'string' &&
        typeof record.marker === 'string' &&
        Number.isSafeInteger(record.generation),
      'QUALIFICATION_APP_RECORD_REFUSED'
    );
    assert(
      (await options.ensureEndpoint()).generation > record.generation,
      'QUALIFICATION_APP_RESTART_UNPROVEN'
    );
  }
  const construct = () =>
    createComputerRuntime({
      runtimeId: 'computer-local',
      anchor: options.anchor,
      guestDirectory: '/home/agent/project',
      sessionMapPath: options.sessionMapPath,
      ensureEndpoint: options.ensureEndpoint,
      currentEnabled: () => true,
      fetch: guardedFetch,
    });
  let bridge = construct();
  try {
    if (options.phase === 'seed') {
      const binding = new ComputerSessionMap(options.sessionMapPath)
        .listAll()
        .find((row) => row.sessionId === record.sessionId);
      assert(binding);
      const client = await bridge.provider.getClient(options.anchor);
      const result = await client.session.shell({
        path: { id: binding.ocSessionId },
        query: { directory: options.anchor },
        body: {
          agent: 'build',
          model: { providerID: 'qualification', modelID: 'no-inference' },
          command: `printf '%s\\n' '${record.marker}'; pwd; uname -s`,
        },
      });
      assert(!result.error && result.data, 'QUALIFICATION_APP_SHELL_FAILED');
      const info: unknown =
        isRecord(result.data) && isRecord(result.data.info) ? result.data.info : result.data;
      assert(isRecord(info) && isRecord(info.tokens));
      assert.equal(info.cost, 0);
      assert.equal(info.tokens.input, 0);
      assert.equal(info.tokens.output, 0);
      await writePrivate(receiptPath, JSON.stringify(record));
    }
    await progress('normal-runtime-binding');
    const binding = await api(`/api/sessions/${record.sessionId}/runtime-type`);
    assert(isRecord(binding));
    assert.equal(binding.runtime, 'computer-local');
    const session = await api(`/api/sessions/${record.sessionId}`);
    assert(isRecord(session));
    assert.equal(session.cwd, options.anchor);
    assert.equal(session.runtime, 'computer-local');
    await progress('normal-http-history');
    const history = await api(`/api/sessions/${record.sessionId}/messages`);
    assert(isRecord(history) && Array.isArray(history.messages));
    const transcript = JSON.stringify(history.messages);
    assert(transcript.includes(record.marker));
    assert(transcript.includes('/home/agent/project') && transcript.includes('Linux'));
    await progress('normal-team-placement');
    const roster = await api('/api/team');
    assert(isRecord(roster) && Array.isArray(roster.members));
    const member = roster.members.find(
      (row) => isRecord(row) && isRecord(row.agent) && row.agent.projectPath === options.anchor
    );
    assert(isRecord(member) && isRecord(member.agent), 'QUALIFICATION_COMPUTER_AGENT_MISSING');
    assert.equal(member.agent.runtime, 'opencode');
    assert.equal(member.agent.effectiveRuntimeId, 'computer-local');
    const factoryHistory = await bridge.runtime.getMessageHistory(options.anchor, record.sessionId);
    assert(JSON.stringify(factoryHistory).includes(record.marker));
    await bridge.revoke();
    bridge = construct();
    assert.deepEqual(
      await bridge.runtime.getMessageHistory(options.anchor, record.sessionId),
      factoryHistory
    );
    await writePrivate(
      join(options.evidenceDirectory, `app-runtime-${options.phase}-receipt.json`),
      JSON.stringify(
        {
          phase: options.phase,
          sessionId: record.sessionId,
          normalAdmission: true,
          httpHistory: true,
          computerAgent: true,
          harness: 'opencode',
          effectiveRuntime: 'computer-local',
          sdkShell: true,
          factoryRestart: true,
          guestDiskRestart: options.phase === 'resume',
          inferenceRequests: 0,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    await progress('normal-chat-proof-complete');
  } finally {
    await bridge.revoke();
  }
}
