/**
 * DOR-3882, through the real SDK `query()` with a stand-in process: the arguments
 * a launch starts with are what `ps -ww` shows, so no server value may be in them.
 * The values arrive over stdin instead, before the first message, and a server
 * kept from this agent is in neither.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSdkMcpServer,
  type Options,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import { GlobalMcpStore } from '../../../../mesh/global-mcp/global-mcp-store.js';
import { toSdkMcpServers } from '../../mcp-server-config.js';
import { createHeldUserPrompt } from '../sdk-utils.js';
import { launchQuery } from '../launch-query.js';

/** A process that answers every control request and records what it was given. */
function standInProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const seen = { args: [] as string[], env: {} as SpawnOptions['env'], lines: [] as string[] };
  let buffered = '';
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let at: number;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      seen.lines.push(line);
      const parsed = JSON.parse(line) as { type: string; request_id?: string };
      if (parsed.type === 'control_request') {
        stdout.write(
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: parsed.request_id,
              response: { added: [], removed: [], errors: {} },
            },
          })}\n`
        );
      }
    }
  });
  const emitter = new EventEmitter();
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    seen.args = options.args;
    seen.env = options.env;
    return Object.assign(emitter, {
      stdin,
      stdout,
      killed: false,
      exitCode: null,
      kill: () => {
        emitter.emit('exit', 0, null);
        return true;
      },
    }) as unknown as SpawnedProcess;
  };
  return { spawn, seen };
}

const typeOf = (line: string): { type: string; subtype?: string } => {
  const parsed = JSON.parse(line) as { type: string; request?: { subtype?: string } };
  return {
    type: parsed.type,
    ...(parsed.request?.subtype ? { subtype: parsed.request.subtype } : {}),
  };
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'launch-query-sdk-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Launch for one agent, with the person's servers as the store gives them. */
async function launchFor(agentId: string) {
  const held = new Map<string, string>();
  const store = new GlobalMcpStore(home, {
    put: async (name, secret) => (held.set(name, secret), `file:${name}`),
    get: async (name) => held.get(name) ?? null,
    delete: async (name) => void held.delete(name),
  });
  await store.add({
    name: 'stdio-server',
    enabled: true,
    secretNames: [],
    excludedAgents: ['kept-agent'],
    connection: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'made-up-server@1.0.0'],
      env: { MADE_UP_TOKEN: 'CANARY-env' },
    },
  });
  await store.add({
    name: 'remote-server',
    enabled: true,
    secretNames: [],
    excludedAgents: ['kept-agent'],
    connection: {
      transport: 'http',
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer CANARY-oauth', 'X-Api-Key': 'CANARY-header' },
    },
  });
  const process = standInProcess();
  const prompt = createHeldUserPrompt('hello');
  const options: Options = {
    mcpServers: toSdkMcpServers(store.injectableFor(agentId)),
    pathToClaudeCodeExecutable: '/made-up/claude',
    spawnClaudeCodeProcess: process.spawn,
  };
  const live = launchQuery({
    prompt: prompt.prompt,
    options,
    session: { eventQueue: [] },
  });
  await vi.waitFor(() => {
    expect(process.seen.lines.some((line) => typeOf(line).type === 'user')).toBe(true);
  });
  prompt.close();
  live.close();
  return process.seen;
}

describe('a real query()', () => {
  it('starts with no server value in its arguments or environment, and hands them over first', async () => {
    const seen = await launchFor('allowed-agent');
    expect(seen.args.join(' ')).not.toContain('CANARY');
    expect(seen.args).not.toContain('--mcp-config');
    expect(JSON.stringify(seen.env)).not.toContain('CANARY');

    const kinds = seen.lines.map(typeOf);
    const handover = kinds.findIndex((k) => k.subtype === 'mcp_set_servers');
    const firstMessage = kinds.findIndex((k) => k.type === 'user');
    expect(handover).toBeGreaterThanOrEqual(0);
    expect(handover).toBeLessThan(firstMessage);
    for (const canary of ['CANARY-env', 'CANARY-oauth', 'CANARY-header']) {
      expect(seen.lines[handover]).toContain(canary);
    }
  });

  it('gives an agent kept from the servers no value anywhere', async () => {
    const seen = await launchFor('kept-agent');
    expect(JSON.stringify([seen.args, seen.env, seen.lines])).not.toContain('CANARY');
  });
});

describe('with an in-process server', () => {
  it('does not send the swap until that server has connected (Security M2)', async () => {
    // The CLI stops reading connect answers while it handles a swap. This stand-in
    // keeps that order visible: it asks `dorkos` to connect a moment after launch,
    // and reports it connected only once the answer came back.
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const order: string[] = [];
    let connected = false;
    let buffered = '';
    const reply = (id: string | undefined, response: unknown): void => {
      stdout.write(
        `${JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: id, response },
        })}\n`
      );
    };
    stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let at: number;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        const parsed = JSON.parse(line) as {
          type: string;
          request_id?: string;
          response?: { request_id?: string };
          request?: { subtype?: string };
        };
        if (parsed.type === 'control_response' && parsed.response?.request_id === 'connect-1') {
          connected = true;
          order.push('connected');
        }
        if (parsed.type !== 'control_request') continue;
        const subtype = parsed.request?.subtype;
        if (subtype === 'mcp_status') {
          reply(parsed.request_id, {
            mcpServers: [{ name: 'dorkos', status: connected ? 'connected' : 'pending' }],
          });
        } else {
          if (subtype === 'mcp_set_servers') order.push('swap');
          reply(parsed.request_id, { added: [], removed: [], errors: {} });
        }
      }
    });
    setTimeout(() => {
      stdout.write(
        `${JSON.stringify({
          type: 'control_request',
          request_id: 'connect-1',
          request: {
            subtype: 'mcp_message',
            server_name: 'dorkos',
            message: {
              jsonrpc: '2.0',
              id: 1,
              method: 'initialize',
              params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: { name: 'stand-in', version: '1' },
              },
            },
          },
        })}\n`
      );
    }, 100);
    const emitter = new EventEmitter();
    const prompt = createHeldUserPrompt('hello');
    const live = launchQuery({
      prompt: prompt.prompt,
      session: { eventQueue: [] },
      options: {
        pathToClaudeCodeExecutable: '/made-up/claude',
        spawnClaudeCodeProcess: () =>
          Object.assign(emitter, {
            stdin,
            stdout,
            killed: false,
            exitCode: null,
            kill: () => true,
          }) as unknown as SpawnedProcess,
        mcpServers: {
          dorkos: createSdkMcpServer({ name: 'dorkos', tools: [] }),
          stdio: { type: 'stdio', command: 'node' },
        },
      },
    });
    await vi.waitFor(() => expect(order).toContain('swap'), { timeout: 2500 });
    expect(order).toEqual(['connected', 'swap']);
    prompt.close();
    live.close();
  });
});
