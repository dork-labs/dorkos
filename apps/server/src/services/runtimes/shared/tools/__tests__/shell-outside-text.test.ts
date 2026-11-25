/**
 * Which shell commands mark a turn as carrying outside words (DOR-5236): commands that fetch from
 * the network, and commands that name a file in a folder of outside files. That a mark then holds a
 * send is pinned end to end in `connectors/execution/__tests__/read-marks-turn.test.ts`.
 *
 * @vitest-environment node
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText, shellCommandOf } from '../shell-outside-text.js';
import { outsideFileTests } from '../outside-file-places.js';
import { toolReadsOutsideText } from '../outside-text-tools.js';

const AGENT = '/agents/wren';
const PLACE = { cwd: AGENT, agentHome: AGENT };
const TEMP = os.tmpdir();
const DORK_HOME = '/made-up/dork-home';

beforeEach(() => {
  vi.stubEnv('DORK_HOME', DORK_HOME);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('commands that fetch from the network mark', () => {
  it.each([
    'curl https://example.com',
    'curl -sSL -o page.html https://example.com/page',
    'wget -q -O- https://example.com',
    'gh issue view 12',
    'gh api repos/made-up/repo/issues',
    'git fetch origin',
    'git pull --rebase',
    'git clone https://example.com/repo.git',
    'git ls-remote origin',
    'git -C /agents/wren/repo pull',
    'git -c http.extraHeader=x fetch',
    'ssh made-up-host cat notes.txt',
    'scp made-up-host:notes.txt .',
    'sftp made-up-host',
    'rsync -av made-up-host:notes/ notes/',
    'rsync rsync://example.com/module/ out/',
    'nc example.com 80',
    'npm view left-pad',
    'pnpm view left-pad versions',
    'yarn info left-pad',
    'pnpm -C web info left-pad',
    'bun pm view left-pad',
    'pip download left-pad',
    'pip3 download left-pad',
    'python3 -m pip download left-pad',
    'python -c "import urllib.request; urllib.request.urlopen(\'https://example.com\')"',
    'python3 -c "print(open(0).read())" https://example.com',
    'node -e "fetch(\'https://example.com\').then(r => r.text()).then(console.log)"',
    'node -e "require(\'https\').get(process.argv[1])"',
    'python3 <<EOF\nimport requests\nprint(requests.get(url).text)\nEOF',
  ])('%s', (command) => {
    expect(commandReadsOutsideText(command, PLACE)).toBe(true);
  });

  it.each([
    ['quoted in bash -c', "bash -c 'curl https://example.com'"],
    ['quoted in sh -c, double', 'sh -c "wget https://example.com"'],
    ['after a pipe', 'echo start | curl -d @- https://example.com'],
    ['before a pipe', 'curl https://example.com | head -5'],
    ['after &&', 'git status && git pull'],
    ['after ;', 'ls; gh pr view 3'],
    ['after ||', 'false || curl https://example.com'],
    ['behind an env prefix', 'HTTPS_PROXY=x curl https://example.com'],
    ['behind env', 'env -i curl https://example.com'],
    ['behind sudo', 'sudo -u root curl https://example.com'],
    ['behind timeout', 'timeout 5 curl https://example.com'],
    ['behind nice', 'nice -n 5 wget https://example.com'],
    ['through xargs', 'cat urls.txt | xargs curl'],
    ['through find -exec', 'find . -name "*.url" -exec curl {} \\;'],
    ['through watch', 'watch -n 5 curl https://example.com'],
    ['by absolute path', '/usr/bin/curl https://example.com'],
    ['by a Homebrew path', '/opt/homebrew/bin/gh issue list'],
    ['inside $(…)', 'echo "$(curl https://example.com)"'],
    ['inside backticks', 'echo `wget -qO- https://example.com`'],
    ['through eval', "eval 'curl https://example.com'"],
    ['on a new line', 'ls\ncurl https://example.com'],
  ])('%s', (_name, command) => {
    expect(commandReadsOutsideText(command, PLACE)).toBe(true);
  });
});

describe('commands that stay on this computer do not mark', () => {
  it.each([
    'git status',
    'git diff HEAD~1',
    'git log --oneline -5',
    'git commit -m "fix the curl example"',
    'git push origin feature',
    'pnpm test',
    'pnpm vitest run src/a.test.ts',
    'npm install',
    'ls',
    'ls -la src',
    'cat README.md',
    `cat ${AGENT}/notes.md`,
    'grep -rn TODO src',
    'rsync -av src/ backup/',
    'python3 scripts/build.py',
    'node -e "console.log(1 + 1)"',
    'command -v curl',
    'echo done',
    '',
  ])('%s', (command) => {
    expect(commandReadsOutsideText(command, PLACE)).toBe(false);
  });
});

describe('commands that name a file in a folder of outside files mark', () => {
  it.each([
    ['cat of a temp file', `cat ${path.join(TEMP, 'page.html')}`],
    ['cat of /tmp', 'cat /tmp/page.html'],
    ['macOS spelling of /tmp', 'head /private/tmp/page.html'],
    ['an input redirect', 'wc -l < /tmp/page.html'],
    ['a flag value', 'python3 tool.py --input=/tmp/page.html'],
    ['$TMPDIR', 'cat $TMPDIR/page.html'],
    ['${TMPDIR:-/tmp}', 'cat "${TMPDIR:-/tmp}/page.html"'],
    ['Downloads by ~', 'cat ~/Downloads/invoice.txt'],
    ['Downloads by $HOME', 'less "$HOME/Downloads/invoice.txt"'],
    ['room attachments in the data folder', `cat ${DORK_HOME}/rooms/r1/attachments/a1.txt`],
    [
      'room attachments copied into the agent',
      `cat ${AGENT}/.dork/.temp/room-attachments/e1/a1.txt`,
    ],
    ['room attachments by a relative path', 'cat .dork/.temp/room-attachments/e1/a1.txt'],
    ['a relative path that leaves the working folder', 'cat ../../tmp/page.html'],
  ])('%s', (_name, command) => {
    expect(commandReadsOutsideText(command, PLACE)).toBe(true);
  });

  it('a file inside a working folder that is itself in the temp folder does not', () => {
    const cwd = path.join(TEMP, 'made-up-project');
    const place = { cwd, agentHome: cwd };
    expect(commandReadsOutsideText(`cat ${path.join(cwd, 'notes.md')}`, place)).toBe(false);
    expect(commandReadsOutsideText('cat notes.md', place)).toBe(false);
    expect(commandReadsOutsideText(`cat ${path.join(TEMP, 'other.txt')}`, place)).toBe(true);
  });

  it('a Downloads file marks even when the working folder holds Downloads', () => {
    const { holds } = outsideFileTests({ cwd: os.homedir() });
    expect(holds('~/Downloads/invoice.txt')).toBe(true);
  });
});

describe('what a shell tool hands in', () => {
  it('reads Claude Code and OpenCode command objects, Codex command and folder, and text', () => {
    expect(shellCommandOf({ command: 'ls' })).toEqual({ command: 'ls' });
    expect(shellCommandOf({ command: 'ls', cwd: '/agents/wren' })).toEqual({
      command: 'ls',
      cwd: '/agents/wren',
    });
    expect(shellCommandOf({ command: ['bash', '-lc', "cat '/tmp/a b'"] })).toEqual({
      command: `'bash' '-lc' 'cat '\\''/tmp/a b'\\'''`,
    });
    expect(
      commandReadsOutsideText(shellCommandOf({ command: ['bash', '-lc', 'gh pr list'] })!.command)
    ).toBe(true);
    expect(shellCommandOf('curl x')).toEqual({ command: 'curl x' });
    expect(shellCommandOf({})).toBeUndefined();
    expect(shellCommandOf(null)).toBeUndefined();
  });

  it('marks a command too long to read', () => {
    expect(commandReadsOutsideText(`echo ${'a'.repeat(100_001)}`, PLACE)).toBe(true);
  });
});

describe('each runtime marks its shell and file tools by their input', () => {
  const fetch = { command: 'curl https://example.com' };
  const local = { command: 'git status' };
  it.each([
    ['claude-code', 'Bash'],
    ['codex', 'Shell'],
    ['opencode', 'bash'],
  ])('%s %s', (runtime, name) => {
    expect(toolReadsOutsideText(runtime, name, fetch, PLACE)).toBe(true);
    expect(toolReadsOutsideText(runtime, name, JSON.stringify(fetch), PLACE)).toBe(true);
    expect(toolReadsOutsideText(runtime, name, local, PLACE)).toBe(false);
    expect(toolReadsOutsideText(runtime, name, undefined, PLACE)).toBe(false);
  });

  it("reads Codex's own folder for the command", () => {
    const cwd = path.join(TEMP, 'made-up-checkout');
    const input = { command: 'cat notes.md', cwd };
    expect(toolReadsOutsideText('codex', 'Shell', input, { agentHome: AGENT })).toBe(true);
    expect(toolReadsOutsideText('codex', 'Shell', input, { cwd, agentHome: cwd })).toBe(false);
  });

  it.each([
    ['claude-code', 'Read', 'file_path'],
    ['claude-code', 'Grep', 'path'],
    ['opencode', 'read', 'filePath'],
    ['opencode', 'grep', 'path'],
    ['doe', 'read', 'path'],
    ['doe', 'search', 'path'],
  ])('%s %s by its %s', (runtime, name, field) => {
    const outside = { [field]: path.join(TEMP, 'download.txt') };
    const own = { [field]: `${AGENT}/notes.md` };
    expect(toolReadsOutsideText(runtime, name, outside, PLACE)).toBe(true);
    expect(toolReadsOutsideText(runtime, name, own, PLACE)).toBe(false);
    expect(toolReadsOutsideText(runtime, name, { [field]: 'notes.md' }, PLACE)).toBe(false);
  });

  it('leaves tools that only write alone, wherever they write', () => {
    const input = { file_path: '/tmp/out.txt', filePath: '/tmp/out.txt', path: '/tmp/out.txt' };
    expect(toolReadsOutsideText('claude-code', 'Write', input, PLACE)).toBe(false);
    expect(toolReadsOutsideText('opencode', 'write', input, PLACE)).toBe(false);
    expect(toolReadsOutsideText('doe', 'write', input, PLACE)).toBe(false);
  });
});
