/**
 * @vitest-environment node
 *
 * The agent browser's real tool list, read from the pinned `@playwright/mcp` by
 * `scripts/snapshot-agent-browser-tools.mjs` with every tool set DorkOS lets it run: every
 * argument that could name a file on this computer sits at the top of its tool's arguments and is
 * one the refusal matches, so a Playwright bump that adds one (`path`, `outputFile`, `dir`) the
 * refusal misses, or nests one, fails here instead of opening a way past the page.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_BROWSER_FILE_ARGUMENT,
  AGENT_BROWSER_MCP_PACKAGE,
  AGENT_BROWSER_WITHHELD_TOOLS,
  isWithheldBrowserTool,
} from '@dorkos/shared/agent-browser';
import rawSnapshot from './fixtures/playwright-mcp-tools.json' with { type: 'json' };

/** An input schema, as far as the census reads one. */
interface Schema {
  properties?: Record<string, Schema>;
  items?: Schema;
}

/** What `scripts/snapshot-agent-browser-tools.mjs` writes. */
interface ToolSnapshot {
  package: string;
  caps: string[];
  tools: { name: string; inputSchema: Schema }[];
}

const snapshot = rawSnapshot as unknown as ToolSnapshot;

/** Every argument name in a schema, nested ones too, as `tool > a.b`. */
function argumentNames(schema: Schema | undefined, prefix = ''): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const own = Object.entries(schema.properties ?? {}).flatMap(([name, child]) => [
    `${prefix}${name}`,
    ...argumentNames(child, `${prefix}${name}.`),
  ]);
  return [...own, ...argumentNames(schema.items, `${prefix}[].`)];
}

/**
 * A name that reads like a file, a path, a folder or an output target. Spelled here on its own,
 * not taken from the refusal, so narrowing the refusal fails this census.
 */
const NAMES_A_FILE = /file|path|dir|output/i;

/** Every argument of an offered tool that names a file, as `tool > name`, nested ones too. */
function fileArguments(): { tool: string; name: string }[] {
  return snapshot.tools
    .filter((tool) => !isWithheldBrowserTool(tool.name))
    .flatMap((tool) =>
      argumentNames(tool.inputSchema)
        .filter((name) => NAMES_A_FILE.test(name.split('.').pop()!))
        .map((name) => ({ tool: tool.name, name }))
    );
}

/** Each file argument `refusal` would let through, as `tool > name`. */
function unrefused(refusal: RegExp): string[] {
  return fileArguments()
    .filter(({ name }) => !refusal.test(name))
    .map(({ tool, name }) => `${tool} > ${name}`);
}

describe('the agent browser’s tool list', () => {
  it('is the snapshot of the version agents run', () => {
    // A bump without a new snapshot fails here: run scripts/snapshot-agent-browser-tools.mjs.
    expect(snapshot.package).toBe(AGENT_BROWSER_MCP_PACKAGE);
    expect(snapshot.caps).not.toContain('storage');
    expect(snapshot.tools.length).toBeGreaterThan(40);
  });

  it('finds the file arguments it should, so an empty census is not a pass', () => {
    expect(fileArguments().map(({ name }) => name)).toEqual(
      expect.arrayContaining(['filename', 'paths'])
    );
  });

  it('keeps every file argument at the top of its tool’s arguments', () => {
    // A nested one is refused too, but the census must never go green by listing one: a nested
    // file argument is a shape the refusal was not built for, so it fails here first.
    expect(
      fileArguments()
        .filter(({ name }) => name.includes('.'))
        .map(({ tool, name }) => `${tool} > ${name}`)
    ).toEqual([]);
  });

  it('refuses every argument of an offered tool that names a file', () => {
    expect(unrefused(AGENT_BROWSER_FILE_ARGUMENT)).toEqual([]);
  });

  it('would fail if the refusal were narrower', () => {
    expect(unrefused(/file/i)).toEqual(['browser_drop > paths', 'browser_file_upload > paths']);
  });

  it('still holds the withheld tools, so withholding them is not a dead rule', () => {
    const names = snapshot.tools.map((tool) => tool.name);
    for (const tool of AGENT_BROWSER_WITHHELD_TOOLS) expect(names).toContain(tool);
  });

  // A trace records every request with full headers into the chat's own folder, with no file
  // argument to refuse, so the tools that make one are withheld outright.
  it('withholds the tools that write a trace of every request', () => {
    const names = snapshot.tools.map((tool) => tool.name);
    for (const tool of ['browser_start_tracing', 'browser_stop_tracing']) {
      expect(names).toContain(tool);
      expect(isWithheldBrowserTool(tool)).toBe(true);
    }
  });

  it('offers no tool that saves or sets browser state, in any tool set DorkOS allows', () => {
    const names = snapshot.tools.map((tool) => tool.name);
    expect(
      names.filter((name) => /storage|cookie|localstorage|sessionstorage/i.test(name))
    ).toEqual([]);
  });
});
