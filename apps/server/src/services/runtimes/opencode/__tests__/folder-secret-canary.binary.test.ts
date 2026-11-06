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
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSidecarSpawnEnv } from '../server-manager.js';
import { OPENCODE_OWN_PLAN } from '../credits-sidecar.js';
import { OFFLINE_PROXY_ENV, pinnedOpenCode } from './pinned-opencode.js';

const BINARY = pinnedOpenCode();
const CANARY = 'CANARY-dor3292-opencode';

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
function fakeModel(
  results: string[],
  secret: () => string,
  calls: string[]
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => (raw += part));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as {
          tools?: unknown[];
          messages?: { role: string }[];
        };
        const hasResult = body.messages?.some((message) => message.role === 'tool') ?? false;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (body.tools?.length && !hasResult) {
          calls.push(raw);
          const call = {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: secret() }) },
          };
          res.write(chunk({ role: 'assistant', tool_calls: [call] }));
          res.write(chunk({}, 'tool_calls'));
        } else {
          if (hasResult) results.push(raw);
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
  let results: string[];
  let calls: string[];
  let target: string;
  let model: Awaited<ReturnType<typeof fakeModel>>;

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-canary-')));
    folder = path.join(root, 'agent');
    fs.mkdirSync(path.join(folder, 'keys'), { recursive: true });
    results = [];
    calls = [];
    model = await fakeModel(results, () => target, calls);
    fs.writeFileSync(
      path.join(folder, 'opencode.json'),
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
    // The stopped CLI may still be finishing a write into its folder.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it.each(['keys/host.key', '.env.ci', 'prod.env', 'readable.txt'])(
    'enforces native read rules for %s',
    async (file) => {
      target = path.join(folder, file);
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
      const child = spawn(BINARY!, ['run', '-m', 'fake/x', 'find the canary'], {
        cwd: folder,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (data) => {
        output += String(data);
      });
      child.stderr.on('data', (data) => {
        output += String(data);
      });
      child.once('error', (err) => results.push(`spawn failed: ${err.message}`));
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 60_000);
        const watcher = setInterval(() => {
          if (results.length > 0) {
            clearTimeout(deadline);
            clearInterval(watcher);
            resolve();
          }
        }, 100);
        child.once('exit', () => {
          clearTimeout(deadline);
          clearInterval(watcher);
          resolve();
        });
      });
      child.kill('SIGKILL');
      expect(calls.length, output).toBeGreaterThan(0);
      const evidence = output + results.join('\n');
      if (file === 'readable.txt') {
        expect(evidence).toContain(CANARY);
        return;
      }
      expect(evidence).not.toContain(CANARY);
      expect(evidence).toMatch(/permission|reject|denied/i);
    },
    90_000
  );
});
