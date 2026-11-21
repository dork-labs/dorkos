/**
 * @vitest-environment node
 *
 * The sidecar's real read-permission channel, using made-up secret data.
 * DorkOS configures reads to ask the host, so a CLI with nobody to answer
 * must refuse the read instead of returning a secret to the fake model.
 * The runtime-level tests separately prove DorkOS's host refuses protected
 * paths and auto-answers ordinary reads, including at Full.
 *
 * Nothing here can spend or reach the internet: a fake model on 127.0.0.1
 * scripts one `read` call, every other address goes to a proxy that does not
 * answer, the secret is a made-up stand-in, HOME and every
 * XDG folder are throwaway, and the model catalog fetch and self-update are
 * off. It runs the pinned, hash-checked binary (`pinned-opencode.ts`).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { LaneReader } from '@dorkos/test-utils/run-custody';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildSidecarSpawnEnv } from '../server-manager.js';
import { OPENCODE_OWN_PLAN } from '../credits-sidecar.js';
import { connectPosixWorker } from './custody/posix-endpoint.js';
import { acquireWorkerCustody } from './custody/worker.js';
import {
  guardPinnedOpenCodePort,
  isPinnedFixtureCleanupUncertain,
  runOwnedPinnedOpenCode,
} from './pinned-opencode-owned.js';
import { matchesNativeReadDenial } from './native-read-denial.js';
import { OFFLINE_PROXY_ENV, pinnedOpenCode } from './pinned-opencode.js';

const BINARY = pinnedOpenCode();
const CANARY = 'CANARY-dor3292-opencode';
const CALL_ID = 'call_1';
// Record the specific rejection documented by the runtime and the conventional
// explicit denial wording. A standalone permission word does not qualify.
const REJECTION = /\brejected permission to use this specific tool call\b/i;
const DENIAL =
  /\b(?:permission(?: to read)? (?:was )?denied|access (?:was )?denied|read access (?:was )?denied)\b/i;

const MAX_CAPTURE_BYTES = 256 * 1024;

interface ReadEvidence {
  target?: string;
  overflow: boolean;
  issued: number;
  sawToolResult: boolean;
  disclosed: boolean;
  denied: boolean;
  nativeRuleDenied: boolean;
}

function toolText(content: unknown, evidence: ReadEvidence): string | undefined {
  if (typeof content === 'string') {
    if (Buffer.byteLength(content) <= MAX_CAPTURE_BYTES) return content;
    evidence.overflow = true;
    return;
  }
  if (!Array.isArray(content)) return;
  let text = '';
  let bytes = 0;
  const parts: readonly unknown[] = content;
  for (const part of parts) {
    if (
      !part ||
      typeof part !== 'object' ||
      !('type' in part) ||
      part.type !== 'text' ||
      !('text' in part) ||
      typeof part.text !== 'string'
    )
      return;
    bytes += Buffer.byteLength(part.text);
    if (bytes > MAX_CAPTURE_BYTES) {
      evidence.overflow = true;
      return;
    }
    text += part.text;
  }
  return text;
}

async function captureLane(reader: LaneReader | undefined, isStopping: () => boolean) {
  if (!reader) throw new Error('Canary fixture output lane was unavailable');
  const decoder = new StringDecoder('utf8');
  let text = '';
  let bytes = 0;
  for (;;) {
    const item = await reader.read().catch(() => undefined);
    if (!item) throw new Error('Canary fixture output lane read failed');
    if (item.kind === 'bytes') {
      bytes += item.frame.byteLength;
      // Keep returning credit after the capture limit. A truncated negative
      // observation can never become evidence of absence.
      if (bytes <= MAX_CAPTURE_BYTES) text += decoder.write(Buffer.from(item.frame));
      continue;
    }
    if (
      item.kind === 'error' &&
      !(
        isStopping() &&
        item.error instanceof Error &&
        item.error.message === 'Custody stream ended before delivery'
      )
    )
      throw new Error('Canary fixture output lane ended with an error');
    if (bytes > MAX_CAPTURE_BYTES)
      throw new Error('Canary fixture output exceeded its evidence limit');
    return { text: text + decoder.end(), complete: item.kind === 'eof' };
  }
}

/** One streamed chat-completions chunk. */
function chunk(delta: object, finish: string | null = null): string {
  const body = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'x' };
  return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/**
 * A fake model: a request that offers tools and has no tool result yet gets
 * one `read` call for the secret file; the request carrying the result is kept
 * and answered with text. Anything else (a title) gets text.
 */
function fakeModel(evidence: ReadEvidence): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as {
          tools?: unknown[];
          messages?: { role: string; tool_call_id?: string; content?: unknown }[];
        };
        const hasResult = body.messages?.some((message) => message.role === 'tool') ?? false;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (body.tools?.length && !hasResult && evidence.target) {
          evidence.issued++;
          const call = {
            index: 0,
            id: CALL_ID,
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: evidence.target }) },
          };
          res.write(chunk({ role: 'assistant', tool_calls: [call] }));
          res.write(chunk({}, 'tool_calls'));
        } else {
          evidence.sawToolResult ||= hasResult;
          for (const message of body.messages ?? []) {
            if (
              evidence.issued === 0 ||
              message.role !== 'tool' ||
              message.tool_call_id !== CALL_ID
            )
              continue;
            evidence.nativeRuleDenied ||= matchesNativeReadDenial(
              message,
              evidence.issued,
              CALL_ID
            );
            const text = toolText(message.content, evidence);
            if (!text) continue;
            evidence.disclosed ||= text.includes(CANARY);
            evidence.denied ||= REJECTION.test(text) || DENIAL.test(text);
          }
          res.write(chunk({ role: 'assistant', content: 'done' }));
          res.write(chunk({}, 'stop'));
        }
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe.skipIf(BINARY === null)('OpenCode and a secret file in its folder (DOR-3292)', () => {
  let root: string;
  let folder: string;
  let evidence: ReadEvidence;
  let model: Awaited<ReturnType<typeof fakeModel>>;
  type FixtureCleanup = { state: 'idle' | 'pending' | 'uncertain' };
  let fixtureCleanup: FixtureCleanup = { state: 'idle' };

  beforeEach(async () => {
    fixtureCleanup = { state: 'idle' };
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-canary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(path.join(folder, 'keys'), { recursive: true });
    evidence = {
      issued: 0,
      sawToolResult: false,
      disclosed: false,
      denied: false,
      nativeRuleDenied: false,
      overflow: false,
    };
    model = await fakeModel(evidence);
    // The fake model lives in the throwaway global config: the sidecar reads
    // no project's own config (DOR-4394).
    fs.mkdirSync(path.join(root, 'config', 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'config', 'opencode', 'opencode.json'),
      JSON.stringify({
        enabled_providers: ['fake'],
        model: 'fake/x',
        small_model: 'fake/x',
        provider: {
          fake: {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: `${model.url}/v1`, apiKey: 'fake-key-never-real' },
            models: { x: { name: 'x', tool_call: true } },
          },
        },
      })
    );
    for (const dir of ['home', 'config', 'data', 'cache', 'state']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    vi.stubEnv('HOME', path.join(root, 'home'));
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
    vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
    vi.stubEnv('XDG_CACHE_HOME', path.join(root, 'cache'));
    vi.stubEnv('XDG_STATE_HOME', path.join(root, 'state'));
    vi.stubEnv('OPENCODE_DISABLE_MODELS_FETCH', '1');
    vi.stubEnv('OPENCODE_DISABLE_AUTOUPDATE', '1');
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await model.close();
    if (fixtureCleanup.state === 'idle')
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.for(['keys/host.key', '.env.ci', 'prod.env', 'readable.txt'])(
    'enforces native read rules for %s',
    { timeout: 90_000 },
    async (file, { signal }) => {
      const caseFolder = folder;
      const caseEvidence = evidence;
      const ownership = fixtureCleanup;
      const target = path.join(caseFolder, file);
      caseEvidence.target = target;
      fs.writeFileSync(target, `${CANARY}\n`);
      // DorkOS's own sidecar config: native reads ask too.
      const env: Record<string, string> = {
        ...buildSidecarSpawnEnv(OPENCODE_OWN_PLAN, 'pw', {}),
        // Anything not on this machine goes to a port nobody answers.
        ...OFFLINE_PROXY_ENV,
      };
      if (file !== 'keys/host.key') {
        // Simulate the host allowing an ordinary read, without overriding native denies.
        // The readable control must succeed; the env cases must still be refused.
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as {
          permission: { read: Record<string, string> };
        };
        config.permission.read['*'] = 'allow';
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
      if (!BINARY) throw new Error('No pinned OpenCode binary for this fixture');
      let closeWorker: (() => Promise<void>) | undefined;
      const runFixture = async () => {
        const worker = await acquireWorkerCustody({
          admitted: true,
          provided: inject('openCodeCustody'),
          signal,
          deadline: null,
          connect: connectPosixWorker,
        });
        closeWorker = worker.close;
        signal.throwIfAborted();
        const child = await guardPinnedOpenCodePort(worker.channel.port).start(
          {
            executable: BINARY,
            argv: ['run', '-m', 'fake/x', 'find the canary'],
            cwd: caseFolder,
            env,
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          },
          signal
        );
        let stopping = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let watcher: ReturnType<typeof setInterval> | undefined;
        const lanes = Promise.allSettled([
          captureLane(child.stdout, () => stopping),
          captureLane(child.stderr, () => stopping),
        ]);
        const run = runOwnedPinnedOpenCode(child, async (owned) => {
          try {
            await Promise.race([
              owned.close,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 60_000);
                watcher = setInterval(() => {
                  if (caseEvidence.sawToolResult) resolve();
                }, 100);
              }),
            ]);
            signal.throwIfAborted();
          } finally {
            stopping = true;
            clearTimeout(timer);
            clearInterval(watcher);
          }
        });
        const [[job], output] = await Promise.all([Promise.allSettled([run] as const), lanes]);
        const errors = output.flatMap((lane) => (lane.status === 'rejected' ? [lane.reason] : []));
        if (job.status === 'rejected') errors.unshift(job.reason);
        if (errors.length > 1)
          throw new AggregateError(errors, 'Canary fixture run or output failed');
        if (errors.length === 1) throw errors[0];
        if (caseEvidence.overflow)
          throw new Error('Canary tool result exceeded its evidence limit');
        const captured = output.flatMap((lane) =>
          lane.status === 'fulfilled' ? [lane.value] : []
        );
        expect(caseEvidence.issued, 'the fixture never requested a native read').toBeGreaterThan(0);
        const disclosed =
          caseEvidence.disclosed || captured.some(({ text }) => text.includes(CANARY));
        if (file === 'readable.txt') {
          expect(disclosed, 'the readable control must return the canary').toBe(true);
          return;
        }
        expect(disclosed, 'a protected read disclosed the canary').toBe(false);
        const completeOutput = captured.length === 2 && captured.every(({ complete }) => complete);
        if (file === '.env.ci' || file === 'prod.env') {
          expect(
            caseEvidence.nativeRuleDenied && completeOutput,
            'the fixture did not observe a correlated native read-rule denial'
          ).toBe(true);
          return;
        }
        // With no correlated denial, require a complete CLI observation. The
        // documented specific rejection is sufficient after this fixture issues
        // its sole read. Other denial lines must identify the actual target.
        const cliDenied =
          completeOutput &&
          captured.some(({ text }) =>
            text
              .split('\n')
              .some((line) => REJECTION.test(line) || (line.includes(target) && DENIAL.test(line)))
          );
        expect(
          caseEvidence.denied || cliDenied,
          'the fixture did not observe a denial attributable to its native read'
        ).toBe(true);
      };

      ownership.state = 'pending';
      const [operation] = await Promise.allSettled([runFixture()] as const);
      const [cleanup] = await Promise.allSettled([closeWorker?.()] as const);
      const uncertain =
        cleanup.status === 'rejected' ||
        (operation.status === 'rejected' && isPinnedFixtureCleanupUncertain(operation.reason));
      ownership.state = uncertain ? 'uncertain' : 'idle';
      if (operation.status === 'rejected') {
        if (cleanup.status === 'rejected')
          throw new AggregateError(
            [operation.reason, cleanup.reason],
            'Canary fixture custody cleanup was uncertain'
          );
        throw operation.reason;
      }
      if (cleanup.status === 'rejected') throw cleanup.reason;
    }
  );
});
