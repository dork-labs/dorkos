/**
 * Opening a global server's sheet lists what it can do and marks what is new
 * (DOR-4118). A server that is off is never started.
 *
 * A real ledger file in a temp data directory, the real probe over a fake
 * Streamable HTTP fetch, and made-up servers and tools.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { runProbe, type ProbeOutcome } from '../../agent-mcp-probe.js';
import {
  checkServerTools,
  GlobalMcpToolLedger,
  MAX_TOOL_DESCRIPTION_LENGTH,
  NEW_TOOL_WINDOW_MS,
  toolLedgerPath,
} from '../global-mcp-tools.js';

const TRACKER: McpServerTransport = {
  transport: 'http',
  url: 'https://tracker.example.test/mcp',
  headers: {},
};

let home: string;
let clock: Date;
let ledger: GlobalMcpToolLedger;

/** A probe answer listing these tools. */
const listing = (...names: string[]): ProbeOutcome => ({
  kind: 'ok',
  toolCount: names.length,
  tools: names.map((name) => ({ name, description: `Does ${name}.` })),
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dor4118-tools-'));
  clock = new Date('2026-11-12T10:00:00Z');
  ledger = new GlobalMcpToolLedger(home, () => clock);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('checking a global server’s tools (DOR-4118)', () => {
  it('never starts a server that is off or refused', async () => {
    const probe = vi.fn();
    expect(await checkServerTools(null, 'tracker', ledger, probe)).toEqual({
      status: 'not-checked',
    });
    expect(probe).not.toHaveBeenCalled();
    expect(fs.existsSync(toolLedgerPath(home))).toBe(false);
  });

  it('marks nothing new on the first check', async () => {
    const check = await checkServerTools(TRACKER, 'tracker', ledger, async () =>
      listing('create_issue', 'list_issues')
    );
    expect(check).toEqual({
      status: 'ok',
      tools: [
        { name: 'create_issue', description: 'Does create_issue.', isNew: false },
        { name: 'list_issues', description: 'Does list_issues.', isNew: false },
      ],
      added: [],
      omitted: 0,
    });
  });

  it('caps what the server controls before anything is kept', async () => {
    const check = await checkServerTools(TRACKER, 'tracker', ledger, async () => ({
      kind: 'ok',
      toolCount: 3,
      tools: [
        { name: 'create_issue', description: 'y'.repeat(5000) },
        { name: 'z'.repeat(129), description: 'Too long a name.' },
        { name: '', description: 'No name.' },
      ],
    }));
    expect(check).toMatchObject({ status: 'ok', omitted: 2 });
    const tools = check.status === 'ok' ? check.tools : [];
    expect(tools.map((tool) => tool.name)).toEqual(['create_issue']);
    expect(tools[0]!.description).toHaveLength(MAX_TOOL_DESCRIPTION_LENGTH);
    const kept = fs.readFileSync(toolLedgerPath(home), 'utf8');
    expect(kept).not.toContain('z'.repeat(129));
  });

  it('marks a tool the server added since, for a day, and names it once', async () => {
    await checkServerTools(TRACKER, 'tracker', ledger, async () => listing('create_issue'));
    clock = new Date(clock.getTime() + 60_000);
    const later = await checkServerTools(TRACKER, 'tracker', ledger, async () =>
      listing('create_issue', 'export_all')
    );
    expect(later).toMatchObject({
      tools: [
        { name: 'create_issue', isNew: false },
        { name: 'export_all', isNew: true },
      ],
      added: ['export_all'],
    });

    // Seen again: still new today, but not added again.
    const again = await checkServerTools(TRACKER, 'tracker', ledger, async () =>
      listing('create_issue', 'export_all')
    );
    expect(again).toMatchObject({ tools: [{}, { isNew: true }], added: [] });

    clock = new Date(clock.getTime() + NEW_TOOL_WINDOW_MS);
    const tomorrow = await checkServerTools(TRACKER, 'tracker', ledger, async () =>
      listing('create_issue', 'export_all')
    );
    expect(tomorrow).toMatchObject({ tools: [{ isNew: false }, { isNew: false }] });
  });

  it('keeps each server apart, in a file only this user can read', async () => {
    await checkServerTools(TRACKER, 'tracker', ledger, async () => listing('a'));
    await checkServerTools(TRACKER, 'weather', ledger, async () => listing('forecast'));
    const later = await checkServerTools(TRACKER, 'weather', ledger, async () =>
      listing('forecast', 'a')
    );
    expect(later).toMatchObject({ added: ['a'] });
    expect(fs.statSync(toolLedgerPath(home)).mode & 0o777).toBe(0o600);
  });

  it('starts over from an unreadable ledger rather than failing the sheet', async () => {
    fs.mkdirSync(path.dirname(toolLedgerPath(home)), { recursive: true });
    fs.writeFileSync(toolLedgerPath(home), '{ broken');
    const check = await checkServerTools(TRACKER, 'tracker', ledger, async () => listing('x'));
    expect(check).toMatchObject({ status: 'ok', added: [] });
  });

  it.each([
    [{ kind: 'unauthorized', error: '401' } as const, { status: 'needs-sign-in' }],
    [
      { kind: 'failed', error: 'connect ECONNREFUSED' } as const,
      { status: 'unreachable', error: 'connect ECONNREFUSED' },
    ],
  ])('answers a failed probe plainly', async (outcome, expected) => {
    expect(await checkServerTools(TRACKER, 'tracker', ledger, async () => outcome)).toEqual(
      expected
    );
  });
});

describe('the probe keeps what a server says about its tools', () => {
  it('returns each tool’s name and description, an empty one when it gave none', async () => {
    const fakeServer = (async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method?: string };
      if (request.id === undefined) return new Response(null, { status: 202 });
      const result =
        request.method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'tracker', version: '1.0.0' },
            }
          : {
              tools: [
                {
                  name: 'create_issue',
                  description: 'Make an issue.',
                  inputSchema: { type: 'object' },
                },
                { name: 'ping', inputSchema: { type: 'object' } },
              ],
            };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'mcp-session-id': 's' },
      });
    }) as typeof fetch;

    expect(await runProbe(TRACKER, fakeServer)).toEqual({
      kind: 'ok',
      toolCount: 2,
      tools: [
        { name: 'create_issue', description: 'Make an issue.' },
        { name: 'ping', description: '' },
      ],
    });
  });
});
