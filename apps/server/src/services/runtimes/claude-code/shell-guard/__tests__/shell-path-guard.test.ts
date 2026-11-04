/**
 * The shell guard's reading of a command (DOR-3300). What the real CLI does with its answers is
 * `shell-path-guard.binary.test.ts`.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  commandReachesProtectedRead,
  commandWritesAgentSetup,
  createShellPathGuardHook,
  namesSetup,
  SHELL_READ_ASK_REASON,
  SHELL_UNREADABLE_DENY_REASON,
  SHELL_WRITE_DENY_REASON,
  shellWriteVerdict,
  type ShellGuardRoots,
} from '../shell-path-guard.js';
import { AGENT_HOME_SELF_GRANT_PATHS } from '../../../shared/policy/protected-paths.js';
import { parseShell } from '../shell-words.js';

let root: string;
let roots: ShellGuardRoots;
let agent: string;
let other: string;

/** `lists` `for` loops of `values` values each, the shape of Security's M1. */
function nestedFor(lists: number, values: number): string {
  const list = Array.from({ length: values }, (_, i) => `x${i}`).join(' ');
  return Array.from({ length: lists }, (_, i) => `for v${i} in ${list}; do :; done`).join('; ');
}

/** The word that uses every list {@link nestedFor} made. */
const LOOP_WORD = (lists: number): string =>
  Array.from({ length: lists }, (_, i) => `$v${i}`).join('');

/** Make an empty file, and the folders above it. */
function touch(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '');
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'shell-guard-')));
  const home = path.join(root, 'home');
  const dorkHome = path.join(root, 'data');
  const cwd = path.join(root, 'work');
  agent = path.join(dorkHome, 'agents', 'scout');
  other = path.join(root, 'elsewhere', 'other-agent');
  touch(path.join(home, '.ssh', 'id_ed25519'));
  touch(path.join(dorkHome, 'secrets', 'moved.txt'));
  touch(path.join(dorkHome, 'dork.db'));
  touch(path.join(root, 'account', '.credentials.json'));
  touch(path.join(cwd, 'notes.md'));
  touch(path.join(cwd, 'src', 'a.ts'));
  touch(path.join(root, 'with-env', 'sub', '.env'));
  touch(path.join(root, 'with-pem', 'server.pem'));
  touch(path.join(root, 'modules', 'node_modules', 'pkg', '.env'));
  touch(path.join(agent, '.claude', 'settings.json'));
  touch(path.join(other, '.claude', 'settings.json'));
  symlinkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(cwd, 'key-link'));
  symlinkSync(path.join(home, '.ssh'), path.join(cwd, 'dir-link'));
  mkdirSync(path.join(root, 'many'));
  for (let i = 0; i < 510; i++) writeFileSync(path.join(root, 'many', `f${i}.txt`), '');
  touch(path.join(root, 'evil', '.mcp.json'));
  touch(path.join(root, 'evil', '.claude', 'settings.json'));
  touch(path.join(other, '.mcp.json'));
  touch(path.join(dorkHome, 'relay', 'adapters.json'));
  touch(path.join(home, '.config', 'gh', 'hosts.yml'));
  mkdirSync(path.join(root, 'linked'));
  symlinkSync(path.join(root, 'with-env'), path.join(root, 'linked', 'to-env'));
  roots = {
    cwd,
    dorkHome,
    home,
    accounts: [path.join(root, 'account')],
    env: { HOME: home, DORK_HOME: dorkHome },
    agentHomes: () => [agent, other],
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseShell', () => {
  it('splits chains and pipes, and removes quotes', () => {
    expect(parseShell(`ls -a && cat 'a b' | grep "c"; head d`).map((s) => s.words)).toEqual([
      ['ls', '-a'],
      ['cat', 'a b'],
      ['grep', 'c'],
      ['head', 'd'],
    ]);
  });

  it('keeps a redirect target apart, and reads a `$(…)` as its own command', () => {
    const [first, second] = parseShell('echo x > out.txt; echo $(cat y)');
    expect(first).toEqual({ words: ['echo', 'x'], redirects: ['out.txt'], scripts: [] });
    expect(second?.words).toEqual(['echo']);
    expect(parseShell('echo $(cat y)')[1]?.words).toEqual(['cat', 'y']);
  });

  it('keeps a heredoc body with its command', () => {
    const [only, ...rest] = parseShell(`python3 - <<'EOF'\nprint(1)\nprint(2)\nEOF`);
    expect(only?.words).toEqual(['python3', '-']);
    expect(only?.scripts).toEqual(['print(1)\nprint(2)']);
    expect(rest).toEqual([]);
  });

  it('survives an unclosed quote', () => {
    expect(parseShell(`cat "a b`)[0]?.words).toEqual(['cat', 'a b']);
  });
});

describe('commandReachesProtectedRead', () => {
  it.each([
    ['~', 'cat ~/.ssh/id_ed25519'],
    ['$HOME', 'cat $HOME/.ssh/id_ed25519'],
    ['${HOME}', 'cat "${HOME}/.ssh/id_ed25519"'],
    ['another variable', 'head $DORK_HOME/secrets/moved.txt'],
    ['a folder', 'ls ~/.ssh'],
    ['an escape', 'cat ~/.s\\sh/id_ed25519'],
    ['split quotes', `cat ~/'.ss'"h"/id_ed25519`],
    ['braces', 'cat ~/.{ssh,aws}/id_ed25519'],
    ['a glob', 'cat ~/.s*/id_*'],
    ['a redirect in', 'wc -l < ~/.ssh/id_ed25519'],
    ['glued to a redirect', 'cat<~/.ssh/id_ed25519'],
    ['an option value', 'foo --file=~/.ssh/id_ed25519'],
    ['chained', 'ls && cat ~/.ssh/id_ed25519'],
    ['after a semicolon', 'ls; tail ~/.ssh/id_ed25519'],
    ['in a pipe', 'echo x | cat - ~/.ssh/id_ed25519'],
    ['in a substitution', 'echo $(cat ~/.ssh/id_ed25519)'],
    ['in a quoted substitution', 'echo "$(cat ~/.ssh/id_ed25519)"'],
    ['in a script string', `python3 -c "open('~/.ssh/id_ed25519').read()"`],
    ['in a heredoc', `python3 - <<'EOF'\nopen('../home/.ssh/id_ed25519')\nEOF`],
    ['a variable set first', 'D=~/.ssh; cat $D/id_ed25519'],
    ['a variable set to home', 'D=~; cat $D/.ssh/id_ed25519'],
    ['cd, then relative', 'cd ~ && cat .ssh/id_ed25519'],
    ['two cds', 'cd ~/.. && cd home && cat .ssh/id_ed25519'],
    ['.. climbing', 'cat ../home/.ssh/id_ed25519'],
    ['a link to a secret', 'cat key-link'],
    ['a link to a folder', 'cat dir-link/id_ed25519'],
    ['a secret name anywhere', 'cat ../with-env/sub/.env'],
    ['a bracket glob', 'cat ~/.ss[!x]/id_*'],
    ['a zsh tree glob', 'cat ../with-env/**/.e*'],
    ['a default value', 'cat ${NOPE:-$HOME}/.ssh/id_ed25519'],
    ['a for list', 'for f in ~/.ssh/id_ed25519; do cat "$f"; done'],
    ['inside if', 'if true; then cat ~/.ssh/id_ed25519; fi'],
    ['inside braces', '{ cat ~/.ssh/id_ed25519; }'],
    ['after a quote with an escape', 'echo "a \\"b\\" c" && cat ~/.ssh/id_ed25519'],
    ['after a comment with an apostrophe', "# don't\ncat ~/.ssh/id_ed25519"],
    ['inside sh -c', `sh -c 'cat ~/.ssh/id_ed25519'`],
    ['inside eval', `eval 'cat ~/.ssh/id_ed25519'`],
    ['a Claude sign-in', `cat ${'$'}HOME/../account/.credentials.json`],
    ['the database', 'sed -n 1p $DORK_HOME/dork.db'],
  ])('sees %s', async (_label, command) => {
    expect(await commandReachesProtectedRead(command, roots)).toBe(true);
  });

  it.each([
    ['the home', 'grep -r x ~'],
    ['the data folder', 'grep -R x $DORK_HOME'],
    ['a folder above a nested .env', () => `grep -r x ${root}/with-env`],
    ['rg -uu over a .env', () => `rg -uu x ${root}/with-env`],
    ['rg over a visible secret name', () => `rg x ${root}/with-pem`],
    ['a tar of a folder with a secret', () => `tar czf /tmp/x.tgz ${root}/with-env`],
    ['find -exec', () => `find ${root}/with-env -type f -exec cat {} +`],
    ['a folder inside the data folder', 'grep -r x $DORK_HOME/relay'],
    ['a folder inside the home', 'grep -r x ~/.config/gh'],
    ['a folder reached by cd', 'cd ~/.config && grep -r x .'],
    ['the folder after a cd, none named', () => `cd ${root}/with-env && rg -uu x`],
    ['grep -d recurse', () => `grep -d recurse x ${root}/with-env`],
    ['--directories=recurse', () => `grep --directories=recurse x ${root}/with-env`],
    ['rg -u -u', () => `rg -u -u x ${root}/with-env`],
    ['rg -.n', () => `rg -.n x ${root}/with-env`],
    ['timeout', () => `timeout 5 grep -r x ${root}/with-env`],
    ['a negated search', () => `! grep -r x ${root}/with-env`],
    ['git grep --no-index', () => `cd ${root}/with-env && git grep --no-index x`],
    ['grep -R through a linked folder', () => `grep -R x ${root}/linked`],
    ['a line continuation', () => `ls && \\\ngrep -r x ${root}/with-env`],
    ['find into xargs', () => `find ${root}/with-env | xargs cat`],
    ['cat of a find', () => `cat $(find ${root}/with-env)`],
    ['a flag value before the pattern', () => `cd ${root}/with-env && grep -r -A 1 x`],
    ['rg with a glob flag', () => `cd ${root}/with-env && rg -uu -g '*' x`],
    ['a quoted pwd', () => `cd ${root}/with-env/sub && cat "$(pwd)/.env"`],
  ])('sees a search of %s', async (_label, command) => {
    const line = typeof command === 'function' ? command() : command;
    expect(await commandReachesProtectedRead(line, roots)).toBe(true);
  });

  it.each([
    ['a file in the working folder', 'cat notes.md'],
    ['a chain of plain reads', 'ls -la && cat notes.md | wc -l'],
    ['a search of a clean folder', 'grep -r x src'],
    ['a template', 'cat .env.example'],
    ['a public key', 'cat ~/.ssh.pub'],
    ['a plain file elsewhere in the home', 'cat ~/notes.md'],
    ['a list of names in a clean folder', 'find . -name "*.ts"'],
    ['a search that only lists names over a secret', () => `find ${root}/with-env -type d`],
    ['rg, which skips a hidden .env', () => `rg x ${root}/with-env`],
    ['an env file inside node_modules', () => `grep -r x ${root}/modules`],
    ['a secret name that isn’t there', 'cat /no/such/place/.env'],
    ['a jq key', 'jq -r .key notes.md'],
    ['a commit message naming a secret', 'git commit -m "remove deploy.pem and id_rsa"'],
    ['a pattern that names a folder', () => `grep -r src ${root}/work/src`],
    ['a search of one named file', 'grep -r x src/a.ts'],
    ['a recursive copy of a clean folder', 'cp -a src /tmp/dor3300-copy'],
    ['an extract, which names no tree', 'tar -xzf /tmp/none.tgz'],
    ['a note in a heredoc', () => `cat > /tmp/n <<'EOF'\n${root}/with-pem/server.pem\nEOF`],
    ['a long token', () => `echo ${'a'.repeat(300)} | wc -c`],
    ['a test bracket', '[ -f notes.md ] && echo y'],
    ['a double test bracket', '[[ -n "$X" ]] && echo y'],
    ['a tr class', `echo x | tr '[:upper:]' '[:lower:]'`],
    ['a script list', `python3 -c "print([1,2])"`],
  ])('leaves %s alone', async (_label, command) => {
    const line = typeof command === 'function' ? command() : command;
    expect(await commandReachesProtectedRead(line, roots)).toBe(false);
  });

  it('searches the working folder when a search names no folder', async () => {
    const clean = { ...roots, cwd: path.join(roots.cwd, 'src') };
    expect(await commandReachesProtectedRead('rg x', clean)).toBe(false);
    expect(await commandReachesProtectedRead('grep -r x .', clean)).toBe(false);
    const withEnv = { ...roots, cwd: path.join(root, 'with-env') };
    expect(await commandReachesProtectedRead('grep -r x', withEnv)).toBe(true);
  });

  it('sees a link to a secret inside a searched folder', async () => {
    expect(await commandReachesProtectedRead('grep -r x .', roots)).toBe(true);
  });

  it('records the known limit: a path built while the command runs gets through', async () => {
    // A string check cannot see these. The boundary is a separate OS user (DOR-3053), and the
    // PR says so. If one ever starts failing, the guard got better: update the header too.
    const built = 'cat "$(printf \'%s/.ssh/id_ed25519\' "$(cd ~ && pwd)")"';
    const hidden = 'cat $(echo fi9zc2gvaWRfZWQyNTUxOQ== | base64 -d)';
    expect(await commandReachesProtectedRead(hidden, roots)).toBe(false);
    expect(await commandReachesProtectedRead(built, roots)).toBe(false);
  });

  it('asks about a read too big to check, with the same limits a write refuses at', async () => {
    const lists = nestedFor(6, 30);
    const started = Date.now();
    expect(await commandReachesProtectedRead(`${lists}; cat ${LOOP_WORD(6)}`, roots)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('never stalls on a huge command, and asks about one too long to read', async () => {
    const started = Date.now();
    const braces = `echo '{${'a,'.repeat(20_000)}'`;
    const repeated = `echo ${'service-account'.repeat(30_000)}`;
    const imports = `cat > /tmp/n <<'EOF'\n${'import { a, b } from "c";\n'.repeat(2_000)}EOF`;
    await commandReachesProtectedRead(braces, roots);
    await commandReachesProtectedRead(repeated, roots);
    await commandReachesProtectedRead(imports, roots);
    commandWritesAgentSetup(imports, roots);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await commandReachesProtectedRead('x'.repeat(300_000), roots)).toBe(true);
  });

  it('treats a glob that opens into too much as protected', async () => {
    expect(await commandReachesProtectedRead(`cat ${root}/many/*`, roots)).toBe(true);
  });
});

describe('a command too big to read (Security, #3487)', () => {
  // M1: about 700 bytes of nested `for` loops used to build millions of strings in the server, and
  // five levels ran it out of memory, before any card, at every level.
  it.each([
    [4, 30],
    [5, 20],
    [6, 30],
  ])('refuses %i nested lists of %i, quickly and without building them', (lists, values) => {
    const command = `${nestedFor(lists, values)}; echo hi > ${LOOP_WORD(lists)}`;
    const started = Date.now();
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
    expect(Date.now() - started).toBeLessThan(500);
  });

  // Security's three on `1fcc57dfaa`, then the same family: shapes the first caps didn't count. Each
  // froze the server, at every level, before any card.
  it('refuses a loop list times braces without building them', () => {
    const list = Array.from({ length: 5_000 }, (_, i) => `x${i}`).join(' ');
    const alternatives = Array.from({ length: 2_000 }, () => 'a').join(',');
    const command = `for d in ${list}; do :; done; echo x > $d{${alternatives}}`;
    const started = Date.now();
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('refuses short loop values opening into many braces each', () => {
    const list = Array.from({ length: 5_000 }, (_, i) => `x${i}`).join(' ');
    const alternatives = Array.from({ length: 200 }, (_, i) => `a${i}`).join(',');
    const command = `for d in ${list}; do :; done; echo x > $d{${alternatives}}`;
    const started = Date.now();
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('pays for a loop in bytes: a few long values can’t build gigabytes', () => {
    const long = 'x'.repeat(10_000);
    const lists = Array.from({ length: 11 }, (_, i) => `for v${i} in ${long} y; do :; done`);
    const command = `${lists.join('; ')}; echo x > ${LOOP_WORD(11)}`;
    const started = Date.now();
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it.each([
    ['one star', '*a'],
    ['four stars', '*a*a*a*ab'],
    ['five stars', '*a*a*a*a*ab'],
    ['twenty stars', `${'*a'.repeat(20)}b`],
  ])('matches %s on a long name without backtracking', async (_label, pattern) => {
    const folder = path.join(root, 'long-name');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'a'.repeat(250)), '');
    const started = Date.now();
    expect(shellWriteVerdict(`rm ${folder}/${pattern}`, roots)).toBe('none');
    await commandReachesProtectedRead(`cat ${folder}/${pattern}`, roots);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it.each([
    ['*.json', 'a.json', true],
    ['*.json', 'a.txt', false],
    ['a?c', 'abc', true],
    ['a?c', 'ac', false],
    ['*', 'anything', true],
    ['a*b*c', 'a1b2c', true],
    ['a*b*c', 'a1c2b', false],
    ['[ab]x', 'bx', true],
    ['[!ab]x', 'bx', false],
    ['[^ab]x', 'cx', true],
    ['[a-c]x', 'bx', true],
    ['[a-c]x', 'dx', false],
    ['[]]x', ']x', true],
    ['[x', '[x', true],
    ['[x', 'x', false],
    ['A*', 'abc', true],
  ])('opens %s against %s as a shell would: %s', async (pattern, name, fits) => {
    // Anything below a home's `.claude` is a setup file, so whether the glob found it shows in the
    // verdict.
    const home = mkdtempSync(path.join(root, 'glob-'));
    const setup = path.join(home, '.claude');
    mkdirSync(setup);
    writeFileSync(path.join(setup, name), '');
    const withHome = { ...roots, agentHomes: () => [home] };
    expect(shellWriteVerdict(`rm ${setup}/${pattern}`, withHome)).toBe(fits ? 'writes' : 'none');
  });

  it('asks about a long `cd` chain, and refuses a write after one, quickly', async () => {
    const chain = Array.from({ length: 4_000 }, (_, i) => `cd d${i}`).join(' && ');
    const started = Date.now();
    expect(await commandReachesProtectedRead(`${chain} && cat notes.md`, roots)).toBe(true);
    expect(shellWriteVerdict(`${chain} && echo x > y`, roots)).toBe('unreadable');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('leaves a few `cd`s alone', async () => {
    const chain = 'cd /tmp && cd /tmp/a && cd /tmp/b && cd /tmp/c';
    expect(await commandReachesProtectedRead(`${chain} && cat notes.md`, roots)).toBe(false);
    expect(shellWriteVerdict(`${chain} && echo x > y`, roots)).toBe('none');
  });

  it('stays linear on an unclosed run of defaults, 32 s before the bound', async () => {
    const defaults = `echo "${'${A:- '.repeat(40_000)}"`;
    const started = Date.now();
    await commandReachesProtectedRead(defaults, roots);
    // About 100 ms here and 250 ms on a busy CI runner, so this leaves room and still catches 32 s.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('shares one time allowance across every search in a command', async () => {
    const searches = Array.from({ length: 50 }, () => `grep -r x ${root}/work/src`).join(' && ');
    expect(await commandReachesProtectedRead(searches, roots)).toBe(false);
  });

  it('refuses a `for` list hiding a setup write past the limit', () => {
    const values = [...Array.from({ length: 5_001 }, (_, i) => `/tmp/n${i}`), `${other}/.claude`];
    const command = `for d in ${values.join(' ')}; do echo x > $d/settings.json; done`;
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
  });

  it('refuses braces that open past the limit', () => {
    const many = ['', ...Array.from({ length: 300 }, (_, i) => `a${i}`)].join(',');
    expect(shellWriteVerdict(`echo x | tee ${other}/{${many}}{x,.mcp.json}`, roots)).toBe(
      'unreadable'
    );
    // Security's own case fits the limit now, so it is read and found.
    const fits = ['', ...Array.from({ length: 63 }, (_, i) => `a${i}`)].join(',');
    expect(shellWriteVerdict(`echo x | tee ${other}/{${fits}}{x,.mcp.json}`, roots)).toBe('writes');
  });

  it('refuses a write padded past the length limit', () => {
    const padded = `${' '.repeat(256 * 1024)}\necho x > ${other}/.mcp.json`;
    expect(shellWriteVerdict(padded, roots)).toBe('unreadable');
  });

  it('runs out of budget across a whole command, not only one word', () => {
    const word = Array.from({ length: 4_000 }, (_, i) => `/tmp/n${i}`).join(' ');
    const lists = `for a in ${word}; do :; done`;
    const command = `${lists}; ${Array.from({ length: 5 }, () => 'echo x > $a').join('; ')}`;
    expect(shellWriteVerdict(command, roots)).toBe('unreadable');
  });

  it('reads every word of a `for` list, not every other one', () => {
    const command = `for f in /tmp/a /tmp/b; do :; done; rm $f/x $f/${''}y ${other}/.mcp.json`;
    expect(shellWriteVerdict(command, roots)).toBe('writes');
    const third = `for f in /tmp/a ${other}/.mcp.json; do rm $f; rm $f; rm $f; done`;
    expect(shellWriteVerdict(third, roots)).toBe('writes');
  });

  it.each(['bypassPermissions', 'default'])(
    'refuses and records at %s when the write check itself throws',
    async (permissionMode) => {
      const recordRefusal = vi.fn();
      const log = { info: vi.fn(), warn: vi.fn() };
      const hook = createShellPathGuardHook({ permissionMode } as never, {
        roots: () => ({
          ...roots,
          agentHomes: () => {
            throw new Error(`could not read ${other}`);
          },
        }),
        recordRefusal,
        log,
      });
      const result = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_use_id: 'toolu_throw',
        } as unknown as HookInput,
        undefined,
        { signal: new AbortController().signal }
      );
      expect(JSON.stringify(result)).toContain(SHELL_UNREADABLE_DENY_REASON);
      expect(JSON.stringify(result)).toContain('"permissionDecision":"deny"');
      expect(recordRefusal).toHaveBeenCalledOnce();
      // Neither the command nor a path from the error reaches the log.
      expect(log.warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain(other);
    }
  );

  it('tells the model plainly why, and records it', async () => {
    const recordRefusal = vi.fn();
    const hook = createShellPathGuardHook({ permissionMode: 'bypassPermissions' } as never, {
      roots: () => roots,
      recordRefusal,
      log: { info: () => {}, warn: () => {} },
    });
    const command = `${nestedFor(6, 30)}; echo hi > ${LOOP_WORD(6)}`;
    const result = await hook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_use_id: 'toolu_big',
      } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal }
    );
    expect(JSON.stringify(result)).toContain(SHELL_UNREADABLE_DENY_REASON);
    expect(recordRefusal).toHaveBeenCalledOnce();
  });

  // The other side of the limits: everyday work must not reach them.
  it.each([
    [
      'a long script that writes data',
      () => `python3 - <<'EOF'\nopen('o','w')\n${'x = 1\n'.repeat(9_000)}EOF`,
    ],
    [
      'a script padded with junk paths',
      () =>
        `python3 -c "open('o','w')\n${Array.from({ length: 6_000 }, (_, i) => `/tmp/n${i}`).join('\n')}"`,
    ],
    [
      'a dict in a writing script',
      () => `node -e "fs.writeFileSync('o', JSON.stringify(${'{a:1,b:2}'.repeat(400)}))"`,
    ],
    ['a long note in a heredoc', () => `cat > /tmp/n <<'EOF'\n${'word '.repeat(40_000)}\nEOF`],
    ['a glob over a big folder', () => `rm ${root}/many/*`],
    ['a chmod over a big folder', () => `chmod 644 ${root}/many/*.txt`],
    ['one `for` list of ordinary size', () => `for f in a b c; do rm /tmp/$f; done`],
    ['small braces', () => `mkdir -p /tmp/{a,b,c}/{d,e,f}`],
  ])('leaves %s alone', (_label, command) => {
    expect(shellWriteVerdict(command(), roots)).toBe('none');
  });

  it('still finds a setup file in a glob over a big folder', () => {
    const big = path.join(root, 'many');
    touch(path.join(big, '.mcp.json'));
    expect(
      commandWritesAgentSetup(`chmod 644 ${big}/*`, { ...roots, agentHomes: () => [big] })
    ).toBe(false);
    expect(
      commandWritesAgentSetup(`chmod 644 ${big}/.*`, { ...roots, agentHomes: () => [big] })
    ).toBe(true);
  });

  it('counts every name in the shared setup list as a setup name', () => {
    for (const entry of AGENT_HOME_SELF_GRANT_PATHS) expect(namesSetup(entry.path)).toBe(true);
    expect(namesSetup('.claude/settings.json')).toBe(true);
    expect(namesSetup('notes.md')).toBe(false);
  });
});

describe('commandWritesAgentSetup', () => {
  it.each([
    ['a redirect', () => `echo '{}' > ${agent}/.claude/settings.json`],
    ['an append', () => `echo x >> ${other}/.claude/settings.json`],
    ['tee', () => `echo x | tee ${other}/.claude/settings.local.json`],
    ['mv', () => `mv ${other}/.claude/settings.local.json /tmp/bak`],
    ['rm', () => `rm -rf ${other}/.claude`],
    ['cp onto it', () => `cp /tmp/x ${other}/.mcp.json`],
    ['sed -i', () => `sed -i '' s/a/b/ ${other}/.claude/settings.json`],
    ['the agent file', () => `echo x > ${other}/.dork/agent.json`],
    ['a skill', () => `echo x > ${other}/.claude/skills/a/SKILL.md`],
    ['.agents', () => `echo x > ${other}/.agents/skills/a/SKILL.md`],
    [
      'a python heredoc',
      () => `python3 - <<'EOF'\nopen('${other}/.claude/settings.json','w').write('{}')\nEOF`,
    ],
    ['relative, after a cd', () => `cd ${other} && echo x > .claude/settings.json`],
    ['git restoring it', () => `git checkout HEAD -- ${other}/.claude/settings.json`],
    ['behind sudo', () => `sudo rm ${other}/.mcp.json`],
    ['a home the registry hasn’t noticed', () => `echo x > ${root}/data/agents/new/.mcp.json`],
    ['inside if', () => `if true; then rm ${other}/.mcp.json; fi`],
    ['a for list', () => `for f in ${other}/.mcp.json; do rm "$f"; done`],
    ['inside braces', () => `{ rm ${other}/.mcp.json; }`],
    ['negated', () => `! rm ${other}/.mcp.json`],
    ['timeout', () => `timeout 5 rm ${other}/.mcp.json`],
    ['nice', () => `nice -n 5 rm ${other}/.mcp.json`],
    ['find -delete', () => `find ${other}/.claude -type f -delete`],
    ['find -exec rm', () => `find ${other}/.claude -exec rm {} +`],
    ['xargs rm', () => `echo ${other}/.mcp.json | xargs rm`],
    ['mkdir', () => `mkdir -p ${other}/.claude/skills/new`],
    ['unlink', () => `unlink ${other}/.mcp.json`],
    ['curl -o', () => `curl -o ${other}/.mcp.json https://example.com/x`],
    ['wget -O', () => `wget -O ${other}/.mcp.json https://example.com/x`],
    ['tar -C', () => `tar -xzf /tmp/x.tgz -C ${other}/.claude`],
    ['unzip -d', () => `unzip /tmp/x.zip -d ${other}/.claude/skills`],
    ['cp -t', () => `cp -t ${other}/.claude/skills /tmp/x`],
    ['dd of=', () => `dd if=/tmp/x of=${other}/.mcp.json`],
    ['git -C', () => `git -C . checkout -- ${other}/.mcp.json`],
    ['>|', () => `echo x >| ${other}/.mcp.json`],
    ['eval', () => `eval 'rm ${other}/.mcp.json'`],
    ['sh -c', () => `sh -c 'rm ${other}/.mcp.json'`],
    ['a quoted substitution', () => `echo "$(rm ${other}/.mcp.json)"`],
    ['a folder copied into a home', () => `cp -r ${root}/evil/.claude ${other}/`],
    ['a file copied into a home', () => `cp ${root}/evil/.mcp.json ${other}/`],
    ['a folder moved into a home', () => `mv ${root}/evil/.claude ${other}/`],
    ['rsync of what a folder holds', () => `rsync -a ${root}/evil/ ${other}/`],
    ['find -delete by name', () => `find ${other} -name .mcp.json -delete`],
    ['git -C', () => `git -C ${other} rm .mcp.json`],
    ['a line continuation', () => `ls && \\\nrm ${other}/.mcp.json`],
    ['perl -pi', () => `perl -pi -e s/a/b/ ${other}/.mcp.json`],
    ['xargs -I', () => `echo x | xargs -I {} rm ${other}/.mcp.json`],
    ['sudo -u', () => `sudo -u root rm ${other}/.mcp.json`],
    ['after arithmetic', () => `echo $((1<<2))\nrm ${other}/.mcp.json`],
    ['open with a write mode', () => `python3 -c "open('${other}/.mcp.json','r+')"`],
    ['open with wt', () => `python3.12 -c "open('${other}/.mcp.json','wt')"`],
    ['a for list with an odd name', () => `for '*' in a; do :; done; rm '*' ${other}/.mcp.json`],
    ['a very long comment after it', () => `rm ${other}/.mcp.json # ${'x'.repeat(300_000)}`],
    ['removing the whole home', () => `rm -rf ${other}`],
    ['after a quote with an escape', () => `echo "a \\"b\\" c" && rm ${other}/.mcp.json`],
    ['after a comment with an apostrophe', () => `# don't\nrm ${other}/.mcp.json`],
  ])('sees %s', (_label, command) => {
    expect(commandWritesAgentSetup(command(), roots)).toBe(true);
  });

  it.each([
    ['cat', () => `cat ${other}/.claude/settings.json`],
    ['grep', () => `grep x ${other}/.claude/settings.json`],
    ['a copy out', () => `cp ${other}/.claude/settings.json /tmp/copy`],
    ['a commit message', () => `git commit -m "change ${other}/.claude/settings.json"`],
    ['a PR body', () => `gh pr create --body "see ${other}/.claude/settings.json"`],
    ['a note about it', () => `cat > /tmp/note <<'EOF'\n${other}/.claude/settings.json\nEOF`],
    ['CLAUDE.md', () => `echo x > ${other}/CLAUDE.md`],
    ['a worktree’s own settings', () => `echo x > ${root}/work/.claude/settings.json`],
    ['a script that only reads one', () => `python3 -c "print(open('${other}/.mcp.json').read())"`],
    ['node requiring one', () => `node -e "require('${other}/.dork/agent.json')"`],
    ['bash -c cat', () => `bash -c 'cat ${other}/.claude/settings.json'`],
    [
      'a validator given one',
      () => `python3 scripts/validate.py ${other}/.claude/skills/x/SKILL.md`,
    ],
    ['git restore --staged', () => `git restore --staged ${other}/.mcp.json`],
    ['a heredoc to cat', () => `cat <<\\EOF\nrm ${other}/.mcp.json\nEOF`],
    ['a plain copy into a home', () => `cp /tmp/notes.md ${other}/`],
    ['a folder copied into a home', () => `cp -r ${root}/with-env ${other}/`],
    ['rsync of a clean folder', () => `rsync -a ${root}/with-env/ ${other}/`],
    ['a glob that skips dot files', () => `cd ${other} && rm *.json`],
    ['chmod of everything visible', () => `cd ${other} && chmod 644 *`],
    ['the same name elsewhere after a cd', () => `cd ${root}/work && echo x > .mcp.json`],
    ['find -exec that only reads', () => `find ${other}/.claude -name x -exec grep -l foo {} +`],
    ['stdout.write', () => `node -e "process.stdout.write(require('${other}/.mcp.json').a)"`],
    ['replace on a string', () => `node -e "require('${other}/.mcp.json').a.replace('x','y')"`],
    ['arithmetic in a writing script', () => `python3 -c "open('o','w').write(str(2 * 3))"`],
    ['git rm --cached', () => `git rm --cached ${other}/.mcp.json`],
    ['git restore -S', () => `git restore -S ${other}/.mcp.json`],
    ['a shell mentioning it', () => `bash -c 'cat ${other}/.mcp.json; echo remove'`],
  ])('leaves %s alone', (_label, command) => {
    expect(commandWritesAgentSetup(command(), roots)).toBe(false);
  });

  it('lets an agent a person opened its own folder to write only its own', () => {
    const open = { ...roots, openHome: agent };
    expect(commandWritesAgentSetup(`echo x > ${agent}/.claude/settings.json`, open)).toBe(false);
    expect(commandWritesAgentSetup(`echo x > ${other}/.claude/settings.json`, open)).toBe(true);
  });

  it('keeps an opened home’s agent file with a person', () => {
    const open = { ...roots, openHome: agent };
    expect(commandWritesAgentSetup(`echo x > ${agent}/.dork/agent.json`, open)).toBe(true);
    expect(commandWritesAgentSetup(`rm ${agent}/.mcp.json`, open)).toBe(false);
  });
});

describe('createShellPathGuardHook', () => {
  const log = { info: () => {}, warn: () => {} };
  const signal = { signal: new AbortController().signal };
  const call = (command: unknown) =>
    ({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_1',
    }) as unknown as HookInput;
  const decisionOf = (result: unknown) =>
    (result as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
      ?.permissionDecision;

  it.each(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])(
    'asks at %s for a protected read',
    async (permissionMode) => {
      const hook = createShellPathGuardHook({ permissionMode } as never, {
        roots: () => roots,
        recordRefusal: vi.fn(),
        log,
      });
      const result = await hook(call('cat ~/.ssh/id_ed25519'), undefined, signal);
      expect(decisionOf(result)).toBe('ask');
      expect(JSON.stringify(result)).toContain(SHELL_READ_ASK_REASON);
    }
  );

  it('answers nothing at Full for a read', async () => {
    const hook = createShellPathGuardHook({ permissionMode: 'bypassPermissions' } as never, {
      roots: () => roots,
      recordRefusal: vi.fn(),
      log,
    });
    expect(await hook(call('cat ~/.ssh/id_ed25519'), undefined, signal)).toEqual({});
  });

  it.each(['default', 'bypassPermissions'])(
    'refuses and records a setup write at %s',
    async (permissionMode) => {
      const recordRefusal = vi.fn();
      const hook = createShellPathGuardHook({ permissionMode } as never, {
        roots: () => roots,
        recordRefusal,
        log,
      });
      const command = `echo x > ${other}/.claude/settings.json`;
      const result = await hook(call(command), undefined, signal);
      expect(decisionOf(result)).toBe('deny');
      expect(JSON.stringify(result)).toContain(SHELL_WRITE_DENY_REASON);
      expect(recordRefusal).toHaveBeenCalledWith({
        toolName: 'Bash',
        toolUseId: 'toolu_1',
        command,
      });
    }
  );

  it.each(['Monitor', 'PowerShell'])(
    'guards %s, which also takes a shell command',
    async (tool) => {
      const recordRefusal = vi.fn();
      const hook = createShellPathGuardHook({ permissionMode: 'bypassPermissions' } as never, {
        roots: () => roots,
        recordRefusal,
        log,
      });
      const input = { ...call(`rm ${other}/.mcp.json`), tool_name: tool } as HookInput;
      expect(decisionOf(await hook(input, undefined, signal))).toBe('deny');
      expect(recordRefusal).toHaveBeenCalledWith(expect.objectContaining({ toolName: tool }));
    }
  );

  it('answers nothing for a plain command, another tool, or no command', async () => {
    const hook = createShellPathGuardHook({ permissionMode: 'default' } as never, {
      roots: () => roots,
      recordRefusal: vi.fn(),
      log,
    });
    expect(await hook(call('ls'), undefined, signal)).toEqual({});
    expect(await hook(call(undefined), undefined, signal)).toEqual({});
    const read = { ...call('x'), tool_name: 'Read' } as HookInput;
    expect(await hook(read, undefined, signal)).toEqual({});
  });
});
