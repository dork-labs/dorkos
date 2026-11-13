/**
 * The server sheet reads back who may use a global server without asking
 * (DOR-4118): the rules already in each agent's folder, nothing new stored.
 *
 * Real agent folders in a temp tree, made-up agents and servers.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readStandingAllows,
  standingAllowBreadth,
  type StandingAllowAgent,
} from '../global-mcp-standing-allows.js';

let root: string;
let atlas: StandingAllowAgent;
let quill: StandingAllowAgent;

/** Write one settings file's allow list into an agent's `.claude/`. */
function allow(agent: StandingAllowAgent, file: string, rules: unknown[]): void {
  fs.mkdirSync(path.join(agent.home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(agent.home, '.claude', file),
    JSON.stringify({ permissions: { allow: rules } })
  );
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4118-allows-')));
  atlas = { id: 'agent-atlas', name: 'Atlas', home: path.join(root, 'atlas') };
  quill = { id: 'agent-quill', name: 'Quill', home: path.join(root, 'quill') };
  fs.mkdirSync(atlas.home);
  fs.mkdirSync(quill.home);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('standing yeses for a global server (DOR-4118)', () => {
  it('lists a one-tool rule and a whole-server rule, with who holds each', async () => {
    allow(atlas, 'settings.local.json', ['mcp__tracker__create_issue', 'Bash(npm test)']);
    allow(quill, 'settings.local.json', ['mcp__tracker']);

    expect(await readStandingAllows('tracker', [atlas, quill])).toEqual([
      {
        agentId: 'agent-atlas',
        agentName: 'Atlas',
        rule: 'mcp__tracker__create_issue',
        breadth: 'tool',
        tool: 'create_issue',
        file: 'settings.local.json',
      },
      {
        agentId: 'agent-quill',
        agentName: 'Quill',
        rule: 'mcp__tracker',
        breadth: 'server',
        file: 'settings.local.json',
      },
    ]);
  });

  it('says which file holds a rule, and lists one held twice only once', async () => {
    allow(atlas, 'settings.json', ['mcp__tracker']);
    allow(atlas, 'settings.local.json', ['mcp__tracker', 'mcp__tracker__export_all']);

    const found = await readStandingAllows('tracker', [atlas]);
    expect(found.map((a) => [a.rule, a.file])).toEqual([
      ['mcp__tracker', 'settings.json'],
      ['mcp__tracker__export_all', 'settings.local.json'],
    ]);
  });

  it("leaves out another server's rules, even one whose name starts the same", async () => {
    allow(atlas, 'settings.local.json', [
      'mcp__trackerx',
      'mcp__trackerx__list',
      'mcp__weather__forecast',
      'mcp__tracker__a__b',
    ]);

    expect(await readStandingAllows('tracker', [atlas])).toEqual([]);
  });

  it('reads only what a launch would pass: no wildcard, nothing malformed', async () => {
    allow(atlas, 'settings.local.json', ['mcp__tracker*', 42, '', 'mcp__tracker‮']);

    expect(await readStandingAllows('tracker', [atlas])).toEqual([]);
  });

  it('skips an agent with no settings, or settings that do not parse', async () => {
    fs.mkdirSync(path.join(quill.home, '.claude'));
    fs.writeFileSync(path.join(quill.home, '.claude', 'settings.local.json'), '{ not json');

    expect(await readStandingAllows('tracker', [atlas, quill])).toEqual([]);
  });
});

describe('server rules in other shapes (DOR-4240)', () => {
  it('lists mcp__{server}__* as every tool, not one tool named *', async () => {
    allow(atlas, 'settings.local.json', ['mcp__tracker__*']);

    expect(await readStandingAllows('tracker', [atlas])).toEqual([
      {
        agentId: 'agent-atlas',
        agentName: 'Atlas',
        rule: 'mcp__tracker__*',
        breadth: 'server',
        file: 'settings.local.json',
      },
    ]);
  });

  it("keeps a server whose name holds __ off another server's sheet", async () => {
    allow(atlas, 'settings.local.json', ['mcp__tracker__eu', 'mcp__tracker__eu__export']);
    const servers = ['tracker', 'tracker__eu'];

    expect(await readStandingAllows('tracker', [atlas], servers)).toEqual([]);
    const own = await readStandingAllows('tracker__eu', [atlas], servers);
    expect(own.map((a) => [a.rule, a.breadth, a.tool])).toEqual([
      ['mcp__tracker__eu', 'server', undefined],
      ['mcp__tracker__eu__export', 'tool', 'export'],
    ]);
  });
});

describe('standingAllowBreadth', () => {
  it.each([
    ['mcp__docs-search', { breadth: 'server' }],
    ['mcp__docs-search__*', { breadth: 'server' }],
    ['mcp__docs-search__find', { breadth: 'tool', tool: 'find' }],
    ['mcp__docs-search__', null],
    ['mcp__docs-search*', null],
    ['mcp__docs', null],
    ['Read(./docs/**)', null],
  ])('%s', (rule, expected) => {
    expect(standingAllowBreadth(rule, 'docs-search')).toEqual(expected);
  });

  it("leaves a rule for a longer server's name to that server", () => {
    const servers = ['docs', 'docs__eu'];
    expect(standingAllowBreadth('mcp__docs__eu', 'docs', servers)).toBeNull();
    expect(standingAllowBreadth('mcp__docs__eu__*', 'docs', servers)).toBeNull();
    expect(standingAllowBreadth('mcp__docs__find', 'docs', servers)).toEqual({
      breadth: 'tool',
      tool: 'find',
    });
    expect(standingAllowBreadth('mcp__docs__eu', 'docs__eu', servers)).toEqual({
      breadth: 'server',
    });
  });
});
