import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import childProcess from 'node:child_process';
const credentialNames = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_API_KEY',
]);
const originalEnv = process.env;
process.env = new Proxy(originalEnv, {
  get(target, key) {
    if (credentialNames.has(key)) throw Error(`Ambient credential read: ${key}`);
    return Reflect.get(target, key);
  },
});
const rejectNetwork = () => {
  throw Error('Import or construction opened network');
};
globalThis.fetch = rejectNetwork;
http.request = rejectNetwork;
https.request = rejectNetwork;
http.get = rejectNetwork;
https.get = rejectNetwork;
net.connect = rejectNetwork;
net.createConnection = rejectNetwork;
for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
  childProcess[api] = () => {
    throw Error('Import or construction started a subprocess');
  };
const assertPath = (value) => {
  if (
    typeof value === 'string' &&
    /\/(?:\.claude|\.pi|\.config\/opencode)\/|\/\.codex\/(?!worktrees\/)/.test(value)
  )
    throw Error(`Vendor file read: ${value}`);
};
for (const api of ['readFileSync', 'openSync']) {
  const original = fs[api];
  fs[api] = function (path, ...args) {
    assertPath(path);
    return original.call(this, path, ...args);
  };
}
for (const api of ['readFile', 'open']) {
  const original = fsp[api];
  fsp[api] = function (path, ...args) {
    assertPath(path);
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
const mod = await import('@dorkos/doe');
const registry = new mod.DeferredToolRegistry();
const model = {
  protocol: 'openai-completions',
  endpoint: 'http://127.0.0.1:1/v1',
  id: 'local',
  contextWindow: 4096,
  maxOutputTokens: 128,
  payer: 'local',
  historyFamily: 'openai-completions',
  requiresCredentials: false,
  credentials: async () => undefined,
};
const store = new mod.SqliteModelStore(':memory:');
const resources = new mod.LocalResources(
  { ancestorDirectories: [], skillRoots: [] },
  { readRoots: [], writeRoots: [] },
  process.cwd()
);
new mod.Doe({
  sessionId: 'cold',
  workingDirectory: process.cwd(),
  model,
  store,
  resources,
  registry,
  pathPolicy: { readRoots: [], writeRoots: [] },
});
new mod.McpConnection('inert', {
  kind: 'stdio',
  command: 'should-not-run',
  args: [],
  environment: {},
});
registry.search('nothing');
assert.equal(await resources.load(), '');
assert.deepEqual(await resources.skills(), []);
store.close();
process.env = originalEnv;
console.log('cold import/construction/discovery: no network or ambient vendor authentication');
