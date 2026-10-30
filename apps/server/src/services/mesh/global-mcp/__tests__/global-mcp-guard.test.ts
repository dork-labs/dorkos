/**
 * What a server for every agent may run (DOR-3213, Security's T7 and T8): no
 * relative path, nothing from where agents write, no loader-injection env.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';
import {
  flaggedEnvNames,
  refuseGlobalServer,
  type GlobalMcpGuardContext,
} from '../global-mcp-guard.js';

let base: string;
let ctx: GlobalMcpGuardContext;

function stdio(command: string, args: string[] = [], env: Record<string, string> = {}) {
  return { transport: 'stdio', command, args, env } as McpServerTransport;
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'global-mcp-guard-'));
  mkdirSync(path.join(base, 'dork', 'agents', 'helper'), { recursive: true });
  mkdirSync(path.join(base, 'repos', 'app', 'bin'), { recursive: true });
  mkdirSync(path.join(base, 'tools'), { recursive: true });
  ctx = { dorkHome: path.join(base, 'dork'), agentRoots: [path.join(base, 'repos', 'app')] };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('refuseGlobalServer: paths (T7)', () => {
  it('allows a bare program name, a package spec and a path outside agent folders', () => {
    expect(
      refuseGlobalServer(stdio('npx', ['-y', '@modelcontextprotocol/server-github']), ctx)
    ).toBeUndefined();
    expect(refuseGlobalServer(stdio('uvx', ['mcp-server-fetch']), ctx)).toBeUndefined();
    expect(
      refuseGlobalServer(stdio(path.join(base, 'tools', 'server'), ['--port', '3000']), ctx)
    ).toBeUndefined();
  });

  it.each([['./server.js'], ['bin/server'], ['../server'], ['~/bin/server']])(
    'refuses the relative command %s',
    (command) => {
      expect(refuseGlobalServer(stdio(command), ctx)).toMatchObject({ code: 'unsafe_command' });
    }
  );

  it.each([['./index.js'], ['dist/index.js'], ['server.py'], ['--entry=./main.mjs']])(
    'refuses the relative file argument %s',
    (arg) => {
      expect(refuseGlobalServer(stdio('node', [arg]), ctx)).toMatchObject({
        code: 'unsafe_command',
      });
    }
  );

  it('refuses a command inside the DorkOS data directory', () => {
    const command = path.join(base, 'dork', 'agents', 'helper', 'run.sh');
    expect(refuseGlobalServer(stdio(command), ctx)).toMatchObject({ code: 'unsafe_command' });
  });

  it("refuses a command inside an agent's folder", () => {
    const command = path.join(base, 'repos', 'app', 'bin', 'server');
    expect(refuseGlobalServer(stdio(command), ctx)).toMatchObject({ code: 'unsafe_command' });
  });

  it("refuses a script argument inside an agent's folder", () => {
    const script = path.join(base, 'repos', 'app', 'server.js');
    expect(refuseGlobalServer(stdio('/usr/bin/node', [script]), ctx)).toMatchObject({
      code: 'unsafe_command',
    });
  });

  it("refuses a link outside that points into an agent's folder", () => {
    const target = path.join(base, 'repos', 'app', 'bin', 'server');
    writeFileSync(target, '#!/bin/sh\n');
    const link = path.join(base, 'tools', 'server');
    symlinkSync(target, link);
    expect(refuseGlobalServer(stdio(link), ctx)).toMatchObject({ code: 'unsafe_command' });
  });

  it('passes a remote server, which runs nothing here', () => {
    expect(
      refuseGlobalServer({ transport: 'http', url: 'https://mcp.example.dev', headers: {} }, ctx)
    ).toBeUndefined();
  });
});

describe('refuseGlobalServer: env (T8)', () => {
  it.each([
    ['DYLD_INSERT_LIBRARIES'],
    ['DYLD_LIBRARY_PATH'],
    ['LD_PRELOAD'],
    ['LD_AUDIT'],
    ['LD_LIBRARY_PATH'],
    ['ld_preload'],
  ])('refuses %s', (name) => {
    expect(refuseGlobalServer(stdio('npx', [], { [name]: '/tmp/x.dylib' }), ctx)).toMatchObject({
      code: 'unsafe_env',
    });
  });

  it.each([
    ['NODE_OPTIONS'],
    ['PYTHONPATH'],
    ['PYTHONSTARTUP'],
    ['PATH'],
    ['BASH_ENV'],
    ['npm_config_registry'],
  ])('allows %s and flags it', (name) => {
    const connection = stdio('npx', [], { [name]: 'x', LOG_LEVEL: 'info' });
    expect(refuseGlobalServer(connection, ctx)).toBeUndefined();
    expect(flaggedEnvNames(connection).map((w) => w.name)).toEqual([name]);
  });

  it('flags nothing on an ordinary server', () => {
    expect(flaggedEnvNames(stdio('npx', [], { GITHUB_TOKEN: 'x', LOG_LEVEL: 'info' }))).toEqual([]);
  });
});
