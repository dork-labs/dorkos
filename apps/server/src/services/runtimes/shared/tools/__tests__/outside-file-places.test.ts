/**
 * Files and searches that hand the turn outside words (DOR-5236): a path as the filesystem resolves
 * it, a search rooted at or above a folder of outside files, Claude Code's own temp folder, and
 * inputs that cannot be read.
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { outsideFileTests } from '../outside-file-places.js';
import { toolReadsOutsideText } from '../outside-text-tools.js';
import { commandReadsOutsideText } from '../shell-outside-text.js';

const AGENT = '/agents/wren';
const PLACE = { cwd: AGENT, agentHome: AGENT };
const HOME = os.homedir();

beforeEach(() => {
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a path is also read as the filesystem resolves it', () => {
  let root: string;
  let project: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'outside-places-'));
    project = path.join(root, 'project');
    mkdirSync(project);
    writeFileSync(path.join(root, 'page.html'), 'made up');
    symlinkSync(path.join(root, 'page.html'), path.join(project, 'linked.html'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a link in the working folder that leads into a folder of outside files marks', () => {
    const place = { cwd: project, agentHome: project };
    expect(outsideFileTests(place).holds(path.join(project, 'linked.html'))).toBe(true);
    expect(outsideFileTests(place).holds('./linked.html')).toBe(true);
    expect(commandReadsOutsideText('cat ./linked.html', place)).toBe(true);
  });

  const upper = (target: string) => target.toUpperCase();
  it.runIf(existsSync(upper(os.tmpdir())))('a temp file named in other letter case marks', () => {
    const file = path.join(root, 'page.html');
    expect(outsideFileTests(PLACE).holds(upper(file))).toBe(true);
    expect(toolReadsOutsideText('claude-code', 'Read', { file_path: upper(file) }, PLACE)).toBe(
      true
    );
  });
});

describe('the own-folder exemption', () => {
  it('a working folder that is the temp folder itself exempts nothing in it', () => {
    expect(outsideFileTests({ cwd: '/tmp', agentHome: '/tmp' }).holds('/tmp/page.html')).toBe(true);
  });

  it('room attachments copied into a tree mark even with no working folder known', () => {
    expect(outsideFileTests({}).holds('.dork/.temp/room-attachments/e1/a1.txt')).toBe(true);
  });
});

describe('a search rooted at or above a folder of outside files marks', () => {
  it.each([
    ['claude-code', 'Grep', { pattern: 'x', path: '~' }, PLACE],
    ['claude-code', 'Grep', { pattern: 'x' }, { cwd: HOME, agentHome: AGENT }],
    ['claude-code', 'Grep', { pattern: 'x', path: '/' }, PLACE],
    ['opencode', 'grep', { pattern: 'x' }, { cwd: HOME }],
    ['doe', 'search', { path: HOME, query: 'x' }, PLACE],
  ])('%s %s %o', (runtime, name, input, place) => {
    expect(toolReadsOutsideText(runtime, name, input, place)).toBe(true);
  });

  it.each([
    ['claude-code', 'Grep', { pattern: 'x' }, PLACE],
    ['claude-code', 'Grep', { pattern: 'x', path: 'src' }, PLACE],
    ['opencode', 'grep', { pattern: 'x', path: AGENT }, PLACE],
  ])('%s %s %o in the agent folder does not', (runtime, name, input, place) => {
    expect(toolReadsOutsideText(runtime, name, input, place)).toBe(false);
  });

  it.each([
    ['grep -r made-up ~', PLACE],
    ['grep -rn made-up', { cwd: HOME }],
    ['rg made-up', { cwd: HOME }],
    ['rg made-up /', PLACE],
    ['find / -name made-up', PLACE],
    ['find . -name made-up', { cwd: HOME }],
    ['fd made-up ~', PLACE],
  ])('%s', (command, place) => {
    expect(commandReadsOutsideText(command, place)).toBe(true);
  });

  it.each(['grep -rn TODO src', 'rg TODO', 'find . -name "*.md"', 'grep made-up ~/notes.md'])(
    '%s in the agent folder does not',
    (command) => {
      expect(commandReadsOutsideText(command, PLACE)).toBe(false);
    }
  );

  it('a folder of outside files reached only through a hidden folder does not', () => {
    vi.stubEnv('DORK_HOME', '/made-up/project/.dork');
    expect(commandReadsOutsideText('rg made-up', { cwd: '/made-up/project' })).toBe(false);
    vi.stubEnv('DORK_HOME', '/made-up/project/dork-home');
    expect(commandReadsOutsideText('rg made-up', { cwd: '/made-up/project' })).toBe(true);
  });
});

describe.skipIf(process.getuid === undefined)("Claude Code's own temp folder", () => {
  const uid = process.getuid?.() ?? 0;
  const own = `/tmp/claude-${uid}/-agents-wren/made-up-session`;

  it("a read of the CLI's task output or scratch file for this project does not mark", () => {
    for (const file of [`${own}/tasks/b1.output`, `${own}/scratchpad/notes.md`]) {
      expect(toolReadsOutsideText('claude-code', 'Read', { file_path: file }, PLACE)).toBe(false);
      expect(toolReadsOutsideText('claude-code', 'Bash', { command: `cat ${file}` }, PLACE)).toBe(
        false
      );
    }
  });

  it("another project's folder, another runtime, or the folder above still marks", () => {
    const other = `/tmp/claude-${uid}/-agents-other/made-up-session/tasks/b1.output`;
    expect(toolReadsOutsideText('claude-code', 'Read', { file_path: other }, PLACE)).toBe(true);
    const file = `${own}/tasks/b1.output`;
    expect(toolReadsOutsideText('codex', 'Shell', { command: `cat ${file}` }, PLACE)).toBe(true);
    expect(toolReadsOutsideText('claude-code', 'Read', { file_path: '/tmp/x' }, PLACE)).toBe(true);
  });

  it("follows the CLI's own temp folder setting", () => {
    const cliTemp = path.join(os.tmpdir(), 'made-up-cli-temp');
    const moved = path.join(cliTemp, `claude-${uid}`, '-agents-wren', 's', 'tasks', 'b1.output');
    const read = () => toolReadsOutsideText('claude-code', 'Read', { file_path: moved }, PLACE);
    expect(read()).toBe(true);
    vi.stubEnv('CLAUDE_CODE_TMPDIR', cliTemp);
    expect(read()).toBe(false);
  });
});

describe('an input that cannot be read marks', () => {
  it.each([
    ['claude-code', 'Bash', '{"command":"curl x"'],
    ['claude-code', 'Bash', '{"command": 5}'],
    ['claude-code', 'Bash', { description: 'no command' }],
    ['codex', 'Shell', '[1, 2'],
    ['claude-code', 'Read', '{"file_path":'],
    ['opencode', 'grep', '{"pattern":'],
  ])('%s %s %o', (runtime, name, input) => {
    expect(toolReadsOutsideText(runtime, name, input, PLACE)).toBe(true);
  });

  it('plain text a shell tool is handed is read as the command', () => {
    expect(toolReadsOutsideText('claude-code', 'Bash', 'git status', PLACE)).toBe(false);
    expect(toolReadsOutsideText('claude-code', 'Bash', 'curl x', PLACE)).toBe(true);
  });
});
