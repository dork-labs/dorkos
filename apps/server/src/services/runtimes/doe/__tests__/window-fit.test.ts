/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolDescriptor } from '@dorkos/doe';
import { defaultNopeTemplate } from '@dorkos/shared/convention-files';
import { assembleDoeHost } from '../tools.js';
import { assertDoeTurnFits, fitHostTools } from '../window-fit.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import { registerTestHomes } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';

// DOR-2839 (FB-55): an agent on a 32k model stopped at once, because DorkOS's
// own prompt filled the window. All data here is synthetic.
let root: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'doe-window-')));
  home = path.join(root, 'agent');
  await mkdir(path.join(home, '.dork'), { recursive: true });
  registerTestHomes([home]);
  resetMemoryProvider();
  await writeFile(
    path.join(home, '.dork', 'agent.json'),
    JSON.stringify({
      id: '01JSYNTHETIC0000000000000',
      name: 'helper',
      description: 'A synthetic agent.',
      runtime: 'doe',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-01-01T00:00:00.000Z',
      registeredBy: 'test',
    })
  );
  await writeFile(path.join(home, '.dork', 'NOPE.md'), defaultNopeTemplate());
  await writeFile(path.join(home, '.dork', 'MEMORY.md'), '- A synthetic note.\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function contextFor(window?: { contextWindow: number; maxOutputTokens: number }) {
  const host = await assembleDoeHost({
    sessionId: 'session',
    cwd: home,
    agentPath: home as never,
    signal: new AbortController().signal,
    ...(window ? { window } : {}),
  });
  try {
    return await host.resources.load();
  } finally {
    await host.dispose();
  }
}

describe('Doe on a small context window', () => {
  it('sends everything when the window is large or unknown', async () => {
    for (const context of [
      await contextFor(),
      await contextFor({ contextWindow: 200_000, maxOutputTokens: 8_192 }),
    ]) {
      expect(context).toContain('<gen_ui>');
      expect(context).toContain('<dorkos_areas>');
      expect(context).not.toContain('<small_window>');
    }
  });

  it('leaves out the least useful blocks first, and says so', async () => {
    const context = await contextFor({ contextWindow: 12_288, maxOutputTokens: 4_096 });
    expect(context).not.toContain('<gen_ui>');
    expect(context).not.toContain('<dorkos_areas>');
    expect(context).toContain('<small_window>');
    // Next in line, still there: only as much is left out as the window needs.
    expect(context).toContain('<dorkos_context>');
    expect(context).toContain('<agent_memory>');
  });

  it('never leaves out identity, safety boundaries or working rules', async () => {
    const context = await contextFor({ contextWindow: 2_048, maxOutputTokens: 1_024 });
    expect(context).toContain('<agent_identity>');
    expect(context).toContain('<agent_safety_boundaries>');
    expect(context).toContain('Never delete production data or databases');
    expect(context).toContain('<working_rules>');
    expect(context).not.toContain('<agent_memory>');
    expect(context).not.toContain('<agent_persona>');
  });

  // DOR-3515: the orientation block may go, but its guard lines never do.
  it('keeps the DorkOS tool-naming and PATH guard lines at the tightest fit', async () => {
    const context = await contextFor({ contextWindow: 2_048, maxOutputTokens: 1_024 });
    expect(context).toContain('the DorkOS orientation');
    expect(context).not.toContain('DorkOS is a workspace for people and agents');
    expect(context).toContain('Never run a bare `dorkos` command or resolve it through PATH');
    expect(context).toContain('The capability catalog tool name ENDS in');
  });
});

describe('fitHostTools', () => {
  const tool = (name: string): ToolDescriptor => ({
    name,
    description: `${name} does a thing.`,
    schema: { type: 'object' },
    initialLoad: true,
    execute: async () => ({ content: [] }),
  });
  const tools = [tool('post_to_room'), tool('memory_write'), tool('read')];
  const host = new Set(['post_to_room', 'memory_write']);
  const loaded = (list: readonly ToolDescriptor[]) =>
    list.filter((t) => t.initialLoad).map((t) => t.name);

  it('keeps every tool loaded unless their descriptions were left out', () => {
    expect(loaded(fitHostTools(tools, host, ['gen_ui'], false))).toEqual([
      'post_to_room',
      'memory_write',
      'read',
    ]);
  });

  it('loads DorkOS tools on demand, but keeps a room turn able to answer', () => {
    expect(loaded(fitHostTools(tools, host, ['dorkos_tool_schemas'], false))).toEqual(['read']);
    expect(loaded(fitHostTools(tools, host, ['dorkos_tool_schemas'], true))).toEqual([
      'post_to_room',
      'read',
    ]);
  });
});

describe('assertDoeTurnFits', () => {
  const input = { resources: 'r'.repeat(40_000), tools: [], content: 'hello' };

  it('lets a turn through when the first request fits', () => {
    expect(() =>
      assertDoeTurnFits({ ...input, window: { contextWindow: 32_768, maxOutputTokens: 4_096 } })
    ).not.toThrow();
  });

  it('says plainly what is wrong and what to do when it cannot fit', () => {
    expect(() =>
      assertDoeTurnFits({ ...input, window: { contextWindow: 8_192, maxOutputTokens: 2_048 } })
    ).toThrow(
      /context window is too small for this agent: it needs about [\d,]+ tokens before replying, and the model can take 6,144\. Choose a model with a larger context window, or shorten the AGENTS\.md files in this folder\./
    );
  });
});
