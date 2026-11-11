/**
 * @vitest-environment node
 *
 * The agent browser's real tool list, read from the pinned `@playwright/mcp` by
 * `scripts/snapshot-agent-browser-tools.mjs` with every tool set DorkOS lets it run: every
 * argument that could name a file on this computer is on the refused list, so a Playwright bump
 * that adds one (`path`, `outputFile`, `dir`) fails here instead of opening a way past the page.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_BROWSER_FILE_ARGUMENTS,
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

/** A name that reads like a file, a path, a folder or an output target. */
const NAMES_A_FILE = /file|path|dir|output/i;

/** Each argument of an offered tool that names a file and isn't on the refused list. */
function unrefusedFileArguments(refused: readonly string[]): string[] {
  return snapshot.tools
    .filter((tool) => !isWithheldBrowserTool(tool.name))
    .flatMap((tool) =>
      argumentNames(tool.inputSchema)
        .filter((name) => NAMES_A_FILE.test(name.split('.').pop()!))
        .filter((name) => !refused.includes(name))
        .map((name) => `${tool.name} > ${name}`)
    );
}

describe('the agent browser’s tool list', () => {
  it('is the snapshot of the version agents run', () => {
    // A bump without a new snapshot fails here: run scripts/snapshot-agent-browser-tools.mjs.
    expect(snapshot.package).toBe(AGENT_BROWSER_MCP_PACKAGE);
    expect(snapshot.caps).not.toContain('storage');
    expect(snapshot.tools.length).toBeGreaterThan(40);
  });

  it('refuses every argument of an offered tool that names a file', () => {
    expect(unrefusedFileArguments(AGENT_BROWSER_FILE_ARGUMENTS)).toEqual([]);
  });

  it('would fail if one were missing from the refused list', () => {
    const withoutPaths = AGENT_BROWSER_FILE_ARGUMENTS.filter((name) => name !== 'paths');
    expect(unrefusedFileArguments(withoutPaths)).toEqual([
      'browser_drop > paths',
      'browser_file_upload > paths',
    ]);
  });

  it('still holds the withheld tools, so withholding them is not a dead rule', () => {
    const names = snapshot.tools.map((tool) => tool.name);
    for (const tool of AGENT_BROWSER_WITHHELD_TOOLS) expect(names).toContain(tool);
  });

  it('offers no tool that saves or sets browser state, in any tool set DorkOS allows', () => {
    const names = snapshot.tools.map((tool) => tool.name);
    expect(
      names.filter((name) => /storage|cookie|localstorage|sessionstorage/i.test(name))
    ).toEqual([]);
  });
});
