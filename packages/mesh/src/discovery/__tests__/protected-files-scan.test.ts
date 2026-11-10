/**
 * Discovery never hands back DorkOS's own protected files (DOR-4060), from any
 * root: the data folder, the home folder, or a folder above it. The scanner and
 * the ten real strategies run over a fixture home with a dummy value planted in
 * the sign-in key, the settings, an extension secret and the databases, and the
 * data folder itself made to look like an agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { unifiedScan } from '../unified-scanner.js';
import type { ScanEvent } from '../types.js';
import { ClaudeCodeStrategy } from '../../strategies/claude-code-strategy.js';
import { CursorStrategy } from '../../strategies/cursor-strategy.js';
import { CodexStrategy } from '../../strategies/codex-strategy.js';
import { WindsurfStrategy } from '../../strategies/windsurf-strategy.js';
import { GeminiStrategy } from '../../strategies/gemini-strategy.js';
import { ClineStrategy } from '../../strategies/cline-strategy.js';
import { RooCodeStrategy } from '../../strategies/roo-code-strategy.js';
import { CopilotStrategy } from '../../strategies/copilot-strategy.js';
import { AmazonQStrategy } from '../../strategies/amazon-q-strategy.js';
import { ContinueStrategy } from '../../strategies/continue-strategy.js';

const CANARY = 'dor-4060-dummy-canary';

const STRATEGIES = [
  new ClaudeCodeStrategy(),
  new CursorStrategy(),
  new CodexStrategy(),
  new WindsurfStrategy(),
  new GeminiStrategy(),
  new ClineStrategy(),
  new RooCodeStrategy(),
  new CopilotStrategy(),
  new AmazonQStrategy(),
  new ContinueStrategy(),
];

let above: string;
let home: string;
let dork: string;

beforeEach(async () => {
  above = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor4060-scan-')));
  home = path.join(above, 'home');
  dork = path.join(home, '.dork');
  await fs.mkdir(path.join(dork, 'extension-secrets'), { recursive: true });
  await fs.writeFile(path.join(dork, 'host.key'), `TOKEN=${CANARY}`);
  await fs.writeFile(path.join(dork, 'config.json'), JSON.stringify({ token: CANARY }));
  await fs.writeFile(path.join(dork, 'extension-secrets', 'ext.json'), `{"k":"${CANARY}"}`);
  await fs.writeFile(path.join(dork, 'dork.db'), `SQLite ${CANARY}`);
  await fs.writeFile(path.join(dork, 'better-auth-secret'), CANARY);
  // The data folder itself looks like an agent, the worst case for a scan.
  await fs.writeFile(path.join(dork, 'AGENTS.md'), '# Data\n\nA folder that looks like an agent.');
  await fs.writeFile(path.join(home, 'AGENTS.md'), '# Home\n\nThe home folder looks like one too.');
});

afterEach(async () => {
  await fs.rm(above, { recursive: true, force: true });
});

async function scan(root: string): Promise<ScanEvent[]> {
  const events: ScanEvent[] = [];
  for await (const event of unifiedScan(
    { root, maxDepth: 4, timeout: 10_000 },
    STRATEGIES,
    { isRegistered: () => false },
    { isDenied: () => false }
  )) {
    events.push(event);
  }
  return events;
}

describe('a discovery scan (DOR-4060)', () => {
  it.each([
    ['the data folder', () => dork],
    ['the home folder', () => home],
    ['a folder above the home folder', () => above],
  ])('from %s returns no protected file’s contents', async (_name, root) => {
    const events = await scan(root());
    expect(events.some((event) => event.type === 'candidate')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });
});
