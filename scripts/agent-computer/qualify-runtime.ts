/** Attended SDK qualification. The caller owns VM lifecycle and the physical-job lock. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  createComputerRuntime,
  type ComputerRuntimeEndpoint,
} from '../../apps/server/src/services/runtimes/opencode/computer/index.js';
import { isRecord } from '../../apps/server/src/services/runtimes/opencode/computer/wire.js';
import { ComputerSessionMap } from '../../apps/server/src/services/runtimes/opencode/computer/session-map.js';
import {
  privateDirectory,
  writePrivate,
} from '../../apps/server/src/services/computers/backend/private-storage.js';

export interface RuntimeQualificationOptions {
  /** Exact host-only canonical identity directory, never mounted into the guest. */
  anchor: string;
  /** Existing qualification-owned private directory; retained across the caller's VM restart. */
  evidenceDirectory: string;
  /** Backend ownership validation and readiness must occur inside this callback. */
  ensureEndpoint(): Promise<ComputerRuntimeEndpoint>;
  /** Seed before VM restart; resume after the caller restarts the retained disk. */
  phase: 'seed' | 'resume';
  /** Fixed phase labels only: never guest URLs, ids, credentials or environment. */
  onProgress?(step: string): Promise<void> | void;
}

/** Prove real guest SDK shell/history, isolated map restart, and old-generation refusal. */
export async function qualifyComputerRuntime(options: RuntimeQualificationOptions): Promise<void> {
  await privateDirectory(options.evidenceDirectory);
  await privateDirectory(options.anchor);
  const mapPath = join(options.evidenceDirectory, 'runtime-sessions.json');
  const receiptPath = join(options.evidenceDirectory, 'runtime-seed.json');
  let generationOffset = 0;
  let requests = 0;
  let qualificationOcId: string | undefined;
  const progress = async (step: string) => {
    await options.onProgress?.(step);
  };
  const endpoint = async () => {
    const current = await options.ensureEndpoint();
    return { ...current, generation: current.generation + generationOffset };
  };
  // No model request can escape this proof, even if upstream changes the shell route.
  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const read =
      request.method === 'GET' && (path.startsWith('/session') || path === '/global/event');
    const create = request.method === 'POST' && path === '/session';
    const shell = request.method === 'POST' && /^\/session\/[^/]+\/shell$/.test(path);
    assert(read || create || shell, 'QUALIFICATION_INFERENCE_ROUTE_REFUSED');
    if (shell) {
      const body = (await request.clone().json()) as {
        model?: { providerID?: string; modelID?: string };
      };
      assert.deepEqual(body.model, { providerID: 'qualification', modelID: 'no-inference' });
    }
    requests += 1;
    const operation = create ? 'session-create' : shell ? 'session-shell' : 'session-read';
    await progress(`${operation}-request`);
    const response = await fetch(request);
    await progress(`${operation}-response`);
    if (qualificationOcId && path === `/session/${qualificationOcId}/message` && response.ok) {
      const raw = await response.clone().text();
      assert(Buffer.byteLength(raw) <= 1_048_576, 'QUALIFICATION_DIAGNOSTIC_TOO_LARGE');
      await writePrivate(join(options.evidenceDirectory, 'runtime-history-raw.json'), raw);
      await progress('history-diagnostic-saved');
    }
    return response;
  };
  const construct = () =>
    createComputerRuntime({
      runtimeId: 'computer-local',
      anchor: options.anchor,
      guestDirectory: '/home/agent/project',
      sessionMapPath: mapPath,
      ensureEndpoint: endpoint,
      currentEnabled: () => true,
      fetch: guardedFetch,
    });
  let bridge = construct();
  try {
    let record: { sessionId: string; marker: string; generation: number };
    if (options.phase === 'seed') {
      record = {
        sessionId: randomUUID(),
        marker: `runtime-proof-${randomUUID()}`,
        generation: (await endpoint()).generation,
      };
      await progress('binding-start');
      bridge.runtime.ensureSession(record.sessionId, {
        cwd: options.anchor,
        permissionMode: 'default',
      });
      let binding: { sessionId: string; ocSessionId: string } | undefined;
      const deadline = Date.now() + 30_000;
      while (
        !(binding = new ComputerSessionMap(mapPath)
          .listAll()
          .find((row) => row.sessionId === record.sessionId))
      ) {
        assert(Date.now() < deadline, 'QUALIFICATION_SESSION_BIND_TIMEOUT');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      qualificationOcId = binding.ocSessionId;
      await progress('binding-acquired');
      const client = await bridge.provider.getClient(options.anchor);
      // Pinned OpenCode1.19 shellImpl directly spawns this command and persists cost/tokens0.
      // Explicit model metadata avoids even looking up a person's default model.
      await progress('shell-start');
      const result = await client.session.shell({
        path: { id: binding.ocSessionId },
        query: { directory: options.anchor },
        body: {
          agent: 'build',
          model: { providerID: 'qualification', modelID: 'no-inference' },
          command: `printf '%s\\n' '${record.marker}'; pwd; uname -s`,
        },
      });
      await progress('shell-complete');
      assert(!result.error && result.data, 'QUALIFICATION_SHELL_FAILED');
      const shellInfo: unknown =
        isRecord(result.data) && isRecord(result.data.info) ? result.data.info : result.data;
      assert(
        isRecord(shellInfo) && isRecord(shellInfo.tokens),
        'QUALIFICATION_SHELL_METADATA_MISSING'
      );
      assert.equal(shellInfo.cost, 0);
      assert.equal(shellInfo.tokens.input, 0);
      assert.equal(shellInfo.tokens.output, 0);
      await writePrivate(receiptPath, JSON.stringify(record));
    } else {
      record = JSON.parse(await readFile(receiptPath, 'utf8')) as typeof record;
      assert(
        typeof record.sessionId === 'string' &&
          typeof record.marker === 'string' &&
          Number.isSafeInteger(record.generation),
        'QUALIFICATION_RECEIPT_REFUSED'
      );
      assert(
        (await endpoint()).generation > record.generation,
        'QUALIFICATION_GUEST_RESTART_UNPROVEN'
      );
    }
    const verifyHistory = async () => {
      qualificationOcId = new ComputerSessionMap(mapPath)
        .listAll()
        .find((row) => row.sessionId === record.sessionId)?.ocSessionId;
      assert(qualificationOcId, 'QUALIFICATION_SESSION_BINDING_MISSING');
      await progress('session-metadata-start');
      const session = await bridge.runtime.getSession(options.anchor, record.sessionId);
      await progress('session-metadata-complete');
      assert(session, 'QUALIFICATION_SESSION_MISSING');
      assert.equal(session.cwd, options.anchor);
      assert.equal(session.runtime, 'computer-local');
      await progress('history-start');
      const history = await bridge.runtime.getMessageHistory(options.anchor, record.sessionId);
      await progress('history-complete');
      const transcript = JSON.stringify(history);
      assert(transcript.includes(record.marker), 'QUALIFICATION_MARKER_MISSING');
      assert(
        transcript.includes('/home/agent/project') && transcript.includes('Linux'),
        'QUALIFICATION_GUEST_OUTPUT_MISSING'
      );
      return history.length;
    };
    const historyCount = await verifyHistory();
    await progress('generation-fence-start');
    const oldClient = await bridge.provider.getClient(options.anchor);
    const binding = new ComputerSessionMap(mapPath)
      .listAll()
      .find((row) => row.sessionId === record.sessionId);
    assert(binding);
    generationOffset += 1;
    await bridge.provider.getClient(options.anchor);
    const before = requests;
    await assert.rejects(() =>
      oldClient.session.get({
        path: { id: binding.ocSessionId },
        query: { directory: options.anchor },
        throwOnError: true,
      })
    );
    assert.equal(requests, before, 'QUALIFICATION_OLD_GENERATION_FORWARDED');
    await progress('generation-fence-complete');
    await bridge.revoke();
    await progress('factory-restart-start');
    bridge = construct();
    assert.equal(await verifyHistory(), historyCount, 'QUALIFICATION_HOST_RESTART_HISTORY_CHANGED');
    await progress('factory-restart-complete');
    await writePrivate(
      join(options.evidenceDirectory, `runtime-${options.phase}-receipt.json`),
      JSON.stringify(
        {
          phase: options.phase,
          sessionId: record.sessionId,
          historyCount,
          factoryRestart: true,
          generationFence: true,
          inferenceRequests: 0,
          sdkShell: true,
          guestDiskRestart: options.phase === 'resume',
          verifiedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } finally {
    await bridge.revoke();
  }
}
