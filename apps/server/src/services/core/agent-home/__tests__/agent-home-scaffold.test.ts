/**
 * The `.agents/` and `.mcp.json` scaffold for agent homes DorkOS owns
 * (DOR-3914), against Security's four tests: a fresh home, an existing file
 * left byte-identical, a link at the path left untouched, and a repair run
 * twice that changes nothing the second time. Real files in a temp tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const warn = vi.fn();
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { EMPTY_MCP_JSON, repairAgentHomes, scaffoldAgentHome } from '../agent-home-scaffold.js';

let root: string;
let agents: string;
let realDorkHome: string | undefined;

/** A registered-looking agent home under the agents folder. */
function agentHome(name: string): string {
  const home = path.join(agents, name);
  fs.mkdirSync(path.join(home, '.dork'), { recursive: true });
  fs.writeFileSync(path.join(home, '.dork', 'agent.json'), '{}');
  return home;
}

/** Every path under `dir` with its kind and bytes, links unfollowed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) {
        out[rel] = `dir:${fs.statSync(full).mtimeMs}`;
        walk(full);
      } else out[rel] = `file:${fs.readFileSync(full, 'hex')}:${fs.statSync(full).mtimeMs}`;
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  warn.mockClear();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-home-scaffold-')));
  realDorkHome = process.env.DORK_HOME;
  process.env.DORK_HOME = path.join(root, 'dork');
  agents = path.join(root, 'dork', 'agents');
  fs.mkdirSync(agents, { recursive: true });
});

afterEach(() => {
  if (realDorkHome === undefined) delete process.env.DORK_HOME;
  else process.env.DORK_HOME = realDorkHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scaffoldAgentHome', () => {
  it('adds an empty .agents folder and the fixed .mcp.json to a fresh home', () => {
    const home = agentHome('fresh');

    expect(scaffoldAgentHome(home)).toEqual({
      scaffolded: true,
      agents: 'created',
      mcpJson: 'created',
    });
    expect(fs.readdirSync(path.join(home, '.agents'))).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')).toBe(EMPTY_MCP_JSON);
    expect(EMPTY_MCP_JSON).toBe('{"mcpServers":{}}');
  });

  it('leaves an existing .mcp.json and .agents byte-identical', () => {
    const home = agentHome('kept');
    const servers = '{ "mcpServers": { "x": { "command": "made-up" } } }\n';
    fs.writeFileSync(path.join(home, '.mcp.json'), servers);
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'note.md'), 'mine');
    const before = snapshot(home);

    expect(scaffoldAgentHome(home)).toEqual({ scaffolded: true, agents: 'kept', mcpJson: 'kept' });
    expect(snapshot(home)).toEqual(before);
    expect(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')).toBe(servers);
  });

  it('leaves a link at either path untouched, never writing through it, and logs it', () => {
    const home = agentHome('linked-targets');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(path.join(outside, 'target.json'), path.join(home, '.mcp.json'));
    fs.symlinkSync(path.join(outside, 'agents-dir'), path.join(home, '.agents'));
    const before = snapshot(home);

    expect(scaffoldAgentHome(home)).toEqual({
      scaffolded: true,
      agents: 'refused-link',
      mcpJson: 'refused-link',
    });
    expect(snapshot(home)).toEqual(before);
    // Dangling links stay dangling: nothing was created at their targets.
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[agents] Left a link in an agent home alone',
      expect.objectContaining({ path: path.join(home, '.mcp.json') })
    );
  });

  it('skips a home that is itself a link to somewhere else', () => {
    const elsewhere = path.join(root, 'their-project');
    fs.mkdirSync(path.join(elsewhere, '.dork'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, '.dork', 'agent.json'), '{}');
    fs.symlinkSync(elsewhere, path.join(agents, 'linked-home'));

    expect(scaffoldAgentHome(path.join(agents, 'linked-home'))).toEqual({
      scaffolded: false,
      reason: 'linked',
    });
    expect(fs.readdirSync(elsewhere)).toEqual(['.dork']);
  });

  it('never writes into a folder outside the agents folder, or a repo inside it', () => {
    const project = path.join(root, 'person-project');
    fs.mkdirSync(path.join(project, '.dork'), { recursive: true });
    expect(scaffoldAgentHome(project)).toEqual({ scaffolded: false, reason: 'not-owned' });
    // Nested deeper than one level is not an agent home DorkOS made either.
    const nested = path.join(agents, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(scaffoldAgentHome(nested)).toEqual({ scaffolded: false, reason: 'not-owned' });

    const repo = agentHome('a-repo');
    fs.mkdirSync(path.join(repo, '.git'));
    expect(scaffoldAgentHome(repo)).toEqual({ scaffolded: false, reason: 'repo' });

    expect(fs.readdirSync(project)).toEqual(['.dork']);
    expect(fs.readdirSync(nested)).toEqual([]);
    expect(fs.readdirSync(repo).sort()).toEqual(['.dork', '.git']);
  });
});

describe('repairAgentHomes', () => {
  it('scaffolds the agent homes that lack them, and a second run changes nothing', () => {
    const bare = agentHome('bare');
    const half = agentHome('half');
    fs.mkdirSync(path.join(half, '.agents'));
    const own = agentHome('own-mcp');
    fs.writeFileSync(
      path.join(own, '.mcp.json'),
      '{"mcpServers":{"y":{"url":"https://example.invalid"}}}'
    );
    // Not agents: a plain folder, a stray file, and a link to an outside agent.
    fs.mkdirSync(path.join(agents, 'not-an-agent'));
    fs.writeFileSync(path.join(agents, 'stray.txt'), 'x');
    const outside = path.join(root, 'outside-agent');
    fs.mkdirSync(path.join(outside, '.dork'), { recursive: true });
    fs.writeFileSync(path.join(outside, '.dork', 'agent.json'), '{}');
    fs.symlinkSync(outside, path.join(agents, 'outside-link'));

    expect(repairAgentHomes()).toBe(4);
    for (const home of [bare, half, own]) {
      expect(fs.lstatSync(path.join(home, '.agents')).isDirectory()).toBe(true);
    }
    expect(fs.readFileSync(path.join(bare, '.mcp.json'), 'utf8')).toBe(EMPTY_MCP_JSON);
    expect(fs.readFileSync(path.join(half, '.mcp.json'), 'utf8')).toBe(EMPTY_MCP_JSON);
    expect(fs.readFileSync(path.join(own, '.mcp.json'), 'utf8')).toContain('example.invalid');
    expect(fs.readdirSync(path.join(agents, 'not-an-agent'))).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual(['.dork']);

    const before = snapshot(root);
    expect(repairAgentHomes()).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  it('does nothing when the agents folder does not exist', () => {
    fs.rmSync(agents, { recursive: true });
    expect(repairAgentHomes()).toBe(0);
    expect(fs.existsSync(agents)).toBe(false);
  });
});
