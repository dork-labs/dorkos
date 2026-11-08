/**
 * The scaffold of Codex's protected targets in agent homes DorkOS owns
 * (DOR-3914), against Security's tests: a fresh home, an existing file left
 * byte-identical (even empty), a link at the path or above it left untouched,
 * and a repair run twice that changes nothing the second time. Real files in a
 * temp tree.
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

import {
  EMPTY_MCP_JSON,
  EMPTY_SETTINGS_JSON,
  SCAFFOLD_TARGETS,
  repairAgentHomes,
  scaffoldAgentHome,
} from '../agent-home-scaffold.js';

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

/** Every target with the same outcome. */
function all(outcome: string): Record<string, string> {
  return Object.fromEntries(SCAFFOLD_TARGETS.map(({ rel }) => [rel, outcome]));
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
  it('adds the empty folders and the fixed files to a fresh home', () => {
    const home = agentHome('fresh');

    expect(scaffoldAgentHome(home)).toEqual({ scaffolded: true, outcomes: all('created') });
    for (const dir of ['.agents', '.claude/agents', '.claude/commands'])
      expect(fs.readdirSync(path.join(home, dir))).toEqual([]);
    expect(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{}}');
    for (const file of ['.claude/settings.json', '.claude/settings.local.json'])
      expect(fs.readFileSync(path.join(home, file), 'utf8')).toBe('{}');
    expect([EMPTY_MCP_JSON, EMPTY_SETTINGS_JSON]).toEqual(['{"mcpServers":{}}', '{}']);
  });

  it('leaves every existing target byte-identical, an empty or malformed file included', () => {
    const home = agentHome('kept');
    const servers = '{ "mcpServers": { "x": { "command": "made-up" } } }\n';
    fs.writeFileSync(path.join(home, '.mcp.json'), servers);
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agents', 'skills', 'note.md'), 'mine');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'commands'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ not json');
    // A 0-byte file is somebody's file too: it stays 0 bytes.
    fs.writeFileSync(path.join(home, '.claude', 'settings.local.json'), '');
    const before = snapshot(home);

    expect(scaffoldAgentHome(home)).toEqual({ scaffolded: true, outcomes: all('kept') });
    expect(snapshot(home)).toEqual(before);
    expect(fs.statSync(path.join(home, '.claude', 'settings.local.json')).size).toBe(0);
  });

  it('leaves a link at any target untouched, never writing through it, and logs it', () => {
    const home = agentHome('linked-targets');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(home, '.claude'));
    for (const { rel } of SCAFFOLD_TARGETS.filter(({ rel }) => rel !== '.claude'))
      fs.symlinkSync(path.join(outside, rel.replace('/', '-')), path.join(home, rel));
    const before = snapshot(home);

    const result = scaffoldAgentHome(home);
    expect(result).toEqual({
      scaffolded: true,
      outcomes: { ...all('refused-link'), '.claude': 'kept' },
    });
    expect(snapshot(home)).toEqual(before);
    // Dangling links stay dangling: nothing was created at their targets.
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[agents] Left a link in an agent home alone',
      expect.objectContaining({ path: path.join(home, '.claude', 'settings.json') })
    );
  });

  it('never writes through a linked .claude, even to a folder that exists', () => {
    const home = agentHome('linked-claude');
    const outside = path.join(root, 'their-claude');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, '.claude'));

    const result = scaffoldAgentHome(home);
    expect(result).toMatchObject({
      scaffolded: true,
      outcomes: {
        '.agents': 'created',
        '.mcp.json': 'created',
        '.claude': 'refused-link',
        '.claude/agents': 'refused-link',
        '.claude/commands': 'refused-link',
        '.claude/settings.json': 'refused-link',
        '.claude/settings.local.json': 'refused-link',
      },
    });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readlinkSync(path.join(home, '.claude'))).toBe(outside);
    expect(warn).toHaveBeenCalledWith(
      '[agents] Left a link in an agent home alone',
      expect.objectContaining({ path: path.join(home, '.claude') })
    );
  });

  it('writes nothing under a .claude that is a file', () => {
    const home = agentHome('file-claude');
    fs.writeFileSync(path.join(home, '.claude'), 'not a folder');

    expect(scaffoldAgentHome(home)).toMatchObject({
      scaffolded: true,
      outcomes: { '.claude': 'kept', '.claude/settings.json': 'blocked' },
    });
    expect(fs.readFileSync(path.join(home, '.claude'), 'utf8')).toBe('not a folder');
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
  it('scaffolds the agent homes that lack targets, and a second run changes nothing', () => {
    const bare = agentHome('bare');
    const half = agentHome('half');
    fs.mkdirSync(path.join(half, '.agents'));
    fs.mkdirSync(path.join(half, '.claude', 'commands'), { recursive: true });
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

    // bare: all 7; half: 7 minus .agents, .claude, .claude/commands; own: 7 minus .mcp.json.
    expect(repairAgentHomes()).toBe(7 + 4 + 6);
    for (const home of [bare, half, own])
      expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}');
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
