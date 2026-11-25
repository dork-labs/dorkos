/**
 * How a script file is judged when it is not a plain file of text on disk (DOR-5240): a script the
 * same command line writes, a word naming no one path, a file too big or not regular, more files
 * than one line may have read, and how a script's own variables and language are read.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { MAX_SCRIPT_BYTES, MAX_SCRIPT_FILES } from '../shell-script-files.js';

const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'made-up-script-limits-'));
const PLACE = { cwd: PROJECT, agentHome: PROJECT };
const marks = (command: string) => commandReadsOutsideText(command, PLACE);

const FILES: Record<string, string | Buffer> = {
  'ok.sh': 'echo done\n',
  'fetch.py': 'import urllib.request\nurllib.request.urlopen(URL)\n',
  'wrap.sh': '#!/bin/sh\nexec "$@"\n',
  'first.sh': '"$1" "$2"\n',
  'named.sh': 'CURL=curl\n$CURL -s "$1"\n',
  'exported.sh': 'export RUN=gh\n$RUN issue list\n',
  'unknown.sh': '$TOOL --version\n',
  'local-var.sh': 'RUN=ls\n$RUN -la\n',
  'tests.sh':
    'if [[ $x =~ ^(a|b)$ ]]; then n=$((n + 1)); fi\nfiles+=("$f")\ncase "$x" in\n  *"$y"*) echo hit ;;\nesac\n',
  'test-then-fetch.sh': '[[ -f x ]] && curl -s https://example.com\n',
  'array-of-fetch.sh': 'pages=($(gh pr list))\n',
  'from-sub.sh': 'GET=$(command -v curl)\n$GET -s example.com\n',
  'messages.js': "console.log('Handled 3 requests');\nconsole.log('see the socket docs');\n",
  'prose.py': 'print("call fetch(x) later, see node:https")\n',
  'local-url.js': "const BASE = 'http://127.0.0.1:6242/api';\nconsole.log(BASE);\n",
  'local-host.py': 'print("open http://localhost:4242 in a browser")\n',
  'local-v6.py': 'print("open http://[::1]:4242/ in a browser")\n',
  'userinfo.py': 'print("http://localhost:80@made-up-remote.example.org/")\n',
  'any-host.js': 'const page = `https://${host}/feed`;\nconsole.log(page);\n',
  'url-not-comment.js': "const u = 'https://example.com'; // the feed\nconsole.log(u);\n",
  'imports-https.mjs': "import { request } from 'node:https';\nrequest(process.argv[2]);\n",
  'requires-https.cjs': "const { get } = require('https');\nget(process.argv[2]);\n",
  'big.py': `print(1)\n${'#'.repeat(MAX_SCRIPT_BYTES)}\n`,
  'binary.bin': Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.from('curl')]),
};

beforeEach(() => {
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(PROJECT, { recursive: true, force: true });
});

mkdirSync(path.join(PROJECT, 'folder'));
for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(PROJECT, name), text);

describe("a shell script's own variables and arguments", () => {
  it.each([
    ['a program set in the script', 'bash named.sh https-less'],
    ['a program exported in the script', 'bash exported.sh'],
    ['"$@" running a fetch', 'bash wrap.sh gh pr list'],
    ['$1 running a fetch', 'bash first.sh gh status'],
    ['"$@" through its path', './wrap.sh gh pr list'],
    ['a program the script cannot name', 'bash unknown.sh'],
    ['a program set from $(…)', 'bash from-sub.sh'],
    ['a fetch after a test', 'bash test-then-fetch.sh'],
    ['a fetch inside an array', 'bash array-of-fetch.sh'],
  ])('%s marks', (_name, command) => {
    expect(marks(command)).toBe(true);
  });

  it.each([
    'bash wrap.sh pnpm test',
    'bash first.sh git status',
    './wrap.sh ls',
    'bash local-var.sh',
    'bash tests.sh',
  ])('%s runs a local command', (command) => {
    expect(marks(command)).toBe(false);
  });
});

describe("a script's language", () => {
  it.each([
    'node messages.js',
    'python3 prose.py',
    'node local-url.js',
    'python3 local-host.py',
    'python3 local-v6.py',
  ])('%s holds only text and this computer’s addresses', (command) => {
    expect(marks(command)).toBe(false);
  });

  it.each([
    'node any-host.js',
    'node url-not-comment.js',
    'node imports-https.mjs',
    'node requires-https.cjs',
    'python3 userinfo.py',
  ])('%s reaches another computer', (command) => {
    expect(marks(command)).toBe(true);
  });
});

describe('a script the same command line writes', () => {
  it.each([
    [
      'a heredoc that fetches',
      "cat > new.py <<'EOF'\nimport urllib.request\nurllib.request.urlopen(u).read()\nEOF\npython3 new.py",
    ],
    ['printf into a file', "printf 'curl -s https://example.com' > g.sh && bash g.sh"],
    ['echo into a file', "echo 'ls' > g2.sh; sh g2.sh"],
    ['a copy', 'cp fetch.py f2.py && python3 f2.py'],
    ['a copy of a local script', 'cp ok.sh ok2.sh && bash ok2.sh'],
    ['a copy into a folder', 'cp ok.sh folder/ && bash folder/ok.sh'],
    ['tee', "tee t.sh <<'EOF'\ngh pr list\nEOF\nbash t.sh"],
  ])('%s marks', (_name, command) => {
    expect(marks(command)).toBe(true);
  });

  it('a heredoc of local commands is judged by its text', () => {
    expect(marks("cat > fresh.sh <<'EOF'\nls\necho done\nEOF\nbash fresh.sh")).toBe(false);
  });
});

describe('a script that cannot be judged marks', () => {
  it.each([
    ['a variable left in its path', 'python3 "$SCRIPT"'],
    ['a wildcard', 'python3 *.py'],
    ['a word naming no path', 'python3 ""'],
    [
      'braces opening into too many paths',
      `python3 {${Array.from({ length: 300 }, (_, at) => `a${at}`).join(',')}}.py`,
    ],
    ['a file over the size read', 'python3 big.py'],
    [
      'more files than one line reads',
      Array.from({ length: MAX_SCRIPT_FILES + 1 }, () => 'bash ok.sh').join('; '),
    ],
  ])('%s', (_name, command) => {
    expect(marks(command)).toBe(true);
  });

  it(`up to ${MAX_SCRIPT_FILES} files are read on one line`, () => {
    expect(marks(Array.from({ length: MAX_SCRIPT_FILES }, () => 'bash ok.sh').join('; '))).toBe(
      false
    );
  });

  it.skipIf(process.platform === 'win32')(
    'a pipe named as the script marks, without waiting on it',
    () => {
      execFileSync('mkfifo', [path.join(PROJECT, 'pipe.sh')]);
      expect(marks('bash pipe.sh')).toBe(true);
    }
  );

  it("a folder or a program's binary runs no script", () => {
    expect(marks('bash folder')).toBe(false);
    expect(marks('./binary.bin')).toBe(false);
    expect(marks('python3 missing.py')).toBe(false);
  });
});
