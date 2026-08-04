/**
 * The `.mcp.json` reader: the `{ name, type }` summary the discovered roster
 * shows and the full-connection resolver `mcp.import` relies on. Uses a real
 * temp workspace so the file read + JSON parse are exercised end to end.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readMcpJsonServers,
  summarizeMcpJsonServers,
  resolveMcpJsonConnection,
} from '../mcp-json.js';

const tempDirs: string[] = [];

async function workspace(servers?: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-json-'));
  tempDirs.push(dir);
  if (servers) {
    await fs.writeFile(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: servers }),
      'utf-8'
    );
  }
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('readMcpJsonServers', () => {
  it('returns {} when there is no .mcp.json', async () => {
    expect(await readMcpJsonServers(await workspace())).toEqual({});
  });

  it('returns {} for malformed JSON', async () => {
    const dir = await workspace();
    await fs.writeFile(path.join(dir, '.mcp.json'), '{ not json', 'utf-8');
    expect(await readMcpJsonServers(dir)).toEqual({});
  });

  it('returns the mcpServers map when present', async () => {
    const dir = await workspace({ a: { command: 'node' } });
    expect(await readMcpJsonServers(dir)).toEqual({ a: { command: 'node' } });
  });
});

describe('summarizeMcpJsonServers', () => {
  it('reports each server with its type, defaulting a bare command to stdio', () => {
    const summary = summarizeMcpJsonServers({
      cmd: { command: 'node' },
      remote: { type: 'http', url: 'https://x' },
      stream: { type: 'sse', url: 'https://y' },
    });
    expect(summary).toEqual([
      { name: 'cmd', type: 'stdio' },
      { name: 'remote', type: 'http' },
      { name: 'stream', type: 'sse' },
    ]);
  });
});

describe('resolveMcpJsonConnection', () => {
  it('maps a stdio entry with schema defaults for args/env', () => {
    expect(resolveMcpJsonConnection({ a: { command: 'npx' } }, 'a')).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: [],
      env: {},
    });
  });

  it('maps an http entry and defaults headers', () => {
    expect(resolveMcpJsonConnection({ r: { type: 'http', url: 'https://x/mcp' } }, 'r')).toEqual({
      transport: 'http',
      url: 'https://x/mcp',
      headers: {},
    });
  });

  it('returns null for an unknown name', () => {
    expect(resolveMcpJsonConnection({ a: { command: 'node' } }, 'missing')).toBeNull();
  });

  it('returns null for a stdio entry missing its command', () => {
    expect(resolveMcpJsonConnection({ a: { args: ['x'] } }, 'a')).toBeNull();
  });

  it('returns null for a remote entry with an invalid url', () => {
    expect(resolveMcpJsonConnection({ r: { type: 'http', url: 'not-a-url' } }, 'r')).toBeNull();
  });
});
