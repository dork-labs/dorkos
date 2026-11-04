/**
 * DOR-3882: a process's MCP servers go over stdin, never on its command line,
 * and the first message waits for them. Past the bound it fails closed: no
 * server goes back on the command line, and the chat says so.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));

import { PLUGIN_RELOAD_ACK_TIMEOUT_MS } from '../../sessions/bounded-control.js';
import {
  commandLineServers,
  launchQuery,
  SERVERS_STARTING_STATUS,
  type NoticeSession,
} from '../launch-query.js';

const STDIO: McpServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: { TOKEN: 'CANARY-env' },
};
const REMOTE: McpServerConfig = {
  type: 'http',
  url: 'https://mcp.example.test',
  headers: { Authorization: 'Bearer CANARY-oauth', 'X-Api-Key': 'CANARY-header' },
};
const IN_PROCESS = { type: 'sdk', name: 'dorkos', instance: {} } as unknown as McpServerConfig;
const ALL = { dorkos: IN_PROCESS, stdio: STDIO, remote: REMOTE };

const message = { type: 'user' } as unknown as SDKUserMessage;

/** A held stream that records when it was first read. */
function heldPrompt() {
  const seen = { read: false };
  async function* read(): AsyncGenerator<SDKUserMessage> {
    seen.read = true;
    yield message;
  }
  return { prompt: read(), seen };
}

/** A fake live query whose `setMcpServers` settles when told. */
function fakeLive(answer: () => Promise<unknown>) {
  const live = { setMcpServers: vi.fn(answer) };
  queryMock.mockImplementation(() => live);
  return live;
}

function launchedOptions(): Options {
  return (queryMock.mock.calls[0]![0] as { options: Options }).options;
}

function launchedPrompt(): AsyncIterable<SDKUserMessage> {
  return (queryMock.mock.calls[0]![0] as { prompt: AsyncIterable<SDKUserMessage> }).prompt;
}

const session = (): NoticeSession & { notified: number } => {
  const out = {
    eventQueue: [] as NoticeSession['eventQueue'],
    notified: 0,
    eventQueueNotify: () => {
      out.notified += 1;
    },
  };
  return out;
};

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('launchQuery', () => {
  it('launches with in-process servers only and hands every server over stdin', async () => {
    const live = fakeLive(async () => ({}));
    launchQuery({ prompt: heldPrompt().prompt, options: { mcpServers: ALL }, session: session() });
    expect(launchedOptions().mcpServers).toEqual({ dorkos: IN_PROCESS });
    expect(JSON.stringify(launchedOptions())).not.toContain('CANARY');
    expect(live.setMcpServers).toHaveBeenCalledWith(ALL);
  });

  it('leaves the option off altogether with no in-process server', () => {
    fakeLive(async () => ({}));
    launchQuery({
      prompt: heldPrompt().prompt,
      options: { mcpServers: { stdio: STDIO } },
      session: session(),
    });
    expect('mcpServers' in launchedOptions()).toBe(false);
  });

  it('holds the first message until the servers answered', async () => {
    let answer = (): void => undefined;
    fakeLive(() => new Promise<void>((resolve) => (answer = resolve)));
    const held = heldPrompt();
    const after = vi.fn();
    launchQuery({
      prompt: held.prompt,
      options: { mcpServers: ALL },
      session: session(),
      afterServers: after,
    });
    const first = launchedPrompt()[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held.seen.read).toBe(false);
    expect(after).not.toHaveBeenCalled();
    answer();
    await expect(first).resolves.toMatchObject({ value: message });
    expect(held.seen.read).toBe(true);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('changes nothing for a launch with no external server', () => {
    const live = fakeLive(async () => ({}));
    const held = heldPrompt();
    const after = vi.fn();
    const options = { mcpServers: { dorkos: IN_PROCESS } };
    launchQuery({ prompt: held.prompt, options, session: session(), afterServers: after });
    expect(queryMock.mock.calls[0]![0]).toEqual({ prompt: held.prompt, options });
    expect(live.setMcpServers).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['slower than the bound', () => new Promise(() => undefined)],
    ['refused', () => Promise.reject(new Error('no'))],
  ])('when the servers are %s', (_name, answer) => {
    it('fails closed: the turn opens, the chat says so, and nothing goes on the command line', async () => {
      vi.useFakeTimers();
      fakeLive(answer);
      const held = heldPrompt();
      const chat = session();
      const notHeld = vi.fn();
      launchQuery({
        prompt: held.prompt,
        options: { mcpServers: ALL },
        session: chat,
        onServersNotHeld: notHeld,
      });
      const first = launchedPrompt()[Symbol.asyncIterator]().next();
      await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_ACK_TIMEOUT_MS);
      await expect(first).resolves.toMatchObject({ value: message });
      expect(chat.eventQueue).toEqual([
        { type: 'system_status', data: { message: SERVERS_STARTING_STATUS } },
      ]);
      expect(chat.notified).toBe(1);
      expect(notHeld).toHaveBeenCalledTimes(1);
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(launchedOptions())).not.toContain('CANARY');
    });
  });
});

describe('commandLineServers', () => {
  it('keeps only in-process servers', () => {
    expect(commandLineServers(ALL)).toEqual({ dorkos: IN_PROCESS });
    expect(commandLineServers({ stdio: STDIO })).toBeUndefined();
    expect(commandLineServers(undefined)).toBeUndefined();
  });
});

describe('every launch goes through launchQuery', () => {
  it('no other session launch imports the SDK query', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const text = readFileSync(full, 'utf8');
          // Any value import naming `query`, on one line or several.
          const imports =
            text.match(/import \{[^}]*\} from '@anthropic-ai\/claude-agent-sdk'/g) ?? [];
          if (imports.some((line) => /[{\s,]query[\s,}]/.test(line))) {
            importers.push(path.relative(root, full));
          }
        }
      }
    };
    walk(root);
    // The other three pass no servers: they ask what a binary supports, or a sign-in.
    expect(importers.sort()).toEqual([
      'accounts/account-probe.ts',
      'claude-code-runtime.ts',
      'messaging/runtime-cache.ts',
      'sdk/launch-query.ts',
    ]);
    for (const file of importers.filter((f) => !f.includes('launch-query'))) {
      expect(readFileSync(path.join(root, file), 'utf8')).not.toMatch(/^\s*mcpServers:/m);
    }
  });
});
