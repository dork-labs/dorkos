#!/usr/bin/env node
/**
 * Snapshot the agent browser's tool list, for the census test that keeps every argument naming a
 * file on the refused list (`apps/server/src/services/browser/__tests__/agent-browser-tool-census.test.ts`).
 *
 * Starts the pinned `@playwright/mcp` over stdio with every tool set DorkOS lets it run (all but
 * `storage`, which `unguardableBrowserReason` refuses), asks for `tools/list` and writes each tool's
 * name and input schema. No browser starts: `tools/list` launches nothing. Run it after every
 * change to `AGENT_BROWSER_MCP_VERSION`:
 *
 *   node scripts/snapshot-agent-browser-tools.mjs 0.0.82
 *
 * @module scripts/snapshot-agent-browser-tools
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Pass the exact @playwright/mcp version, like 0.0.82.');
  process.exit(1);
}

/** Every opt-in tool set but `storage`, so the census sees every tool an agent can be offered. */
const CAPS = ['config', 'devtools', 'network', 'pdf', 'testing', 'vision'];
const OUT = path.join(
  import.meta.dirname,
  '..',
  'apps/server/src/services/browser/__tests__/fixtures/playwright-mcp-tools.json'
);

const child = spawn(
  'npx',
  ['-y', `@playwright/mcp@${version}`, '--isolated', '--headless', `--caps=${CAPS.join(',')}`],
  { stdio: ['pipe', 'pipe', 'inherit'] }
);
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const timer = setTimeout(() => {
  console.error('No tools/list answer within 60 seconds.');
  child.kill();
  process.exit(1);
}, 60_000);

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/list', params: {} });
    } else if (message.id === 2) {
      const tools = message.result.tools
        .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
        .sort((a, b) => a.name.localeCompare(b.name));
      fs.writeFileSync(
        OUT,
        `${JSON.stringify({ package: `@playwright/mcp@${version}`, caps: CAPS, tools }, null, 2)}\n`
      );
      console.log(`Wrote ${tools.length} tools to ${path.relative(process.cwd(), OUT)}`);
      clearTimeout(timer);
      child.kill();
    }
  }
});

send({
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dorkos-tool-census', version: '1' },
  },
});
