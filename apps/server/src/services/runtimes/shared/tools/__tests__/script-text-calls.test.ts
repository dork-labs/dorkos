/**
 * What in a script file's text reaches the network (DOR-5261): a network program run from code,
 * a network module anywhere on a Python import line, `node:http` imported under another name, and
 * a module whose name is built. Comments are left out with strings and regexes read as such.
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutComments } from '../script-comments.js';
import { commandReadsOutsideText } from '../shell-outside-text.js';

const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'made-up-script-text-'));
/** Whether running a file holding this text, by this interpreter, marks. */
const runMarks = (name: string, text: string, runner: string): boolean => {
  writeFileSync(path.join(PROJECT, name), text);
  return commandReadsOutsideText(`${runner} ${name}`, { cwd: PROJECT, agentHome: PROJECT });
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

describe('code that runs a network program marks', () => {
  it.each([
    ['run-gh.py', 'import subprocess\nsubprocess.run(["gh", "issue", "list"])\n', 'python3'],
    ['system.py', 'import os\nos.system("curl " + address)\n', 'python3'],
    [
      'exec.js',
      "const { execSync } = require('node:child_process');\nexecSync('gh issue view 1');\n",
      'node',
    ],
    [
      'spawn.mjs',
      "import { spawn } from 'node:child_process';\nspawn('wget', [address]);\n",
      'node',
    ],
    ['run.rb', 'system("ssh " + host)\n', 'ruby'],
  ])('%s', (name, text, runner) => {
    expect(runMarks(name, text, runner)).toBe(true);
  });

  it.each([
    ['words.py', 'fields = ["host", "port"]\nprint("ghost story")\n', 'python3'],
    ['words.js', "const kinds = ['http', 'ftp'];\nconsole.log('ghost');\n", 'node'],
    ['names.mjs', "const WRAPPERS = new Set([\n  'watch',\n  'ssh',\n  'gh',\n]);\n", 'node'],
    ['fake.mjs', "const fake = join(bin, 'gh');\nwriteFileSync(fake, script);\n", 'node'],
  ])('%s, naming no program at a string start, does not', (name, text, runner) => {
    expect(runMarks(name, text, runner)).toBe(false);
  });
});

describe('inline code that runs a network program marks', () => {
  it.each([
    `python3 -c "import subprocess; subprocess.run(['gh', 'issue', 'list'])"`,
    `node -e "require('child_process').execSync('curl -s made-up-host')"`,
  ])('%s', (command) => {
    expect(commandReadsOutsideText(command, { cwd: PROJECT, agentHome: PROJECT })).toBe(true);
  });
});

describe('Python imports and calls', () => {
  it.each([
    ['imports.py', 'import os, requests\nrequests.get(address)\n'],
    ['later.py', 'import os, sys, socket\n'],
    ['call.py', 'import os\nhttpx.post(address)\n'],
    ['built.py', 'module = __import__(name)\n'],
    ['named.py', 'module = __import__("requests")\n'],
  ])('%s marks', (name, text) => {
    expect(runMarks(name, text, 'python3')).toBe(true);
  });

  it.each([
    ['plain.py', 'import os, sys\nprint(os.getcwd())\n'],
    ['os-only.py', 'module = __import__("os")\n'],
    ['helper.py', 'from made_up.requests_helper import load\n'],
  ])('%s does not', (name, text) => {
    expect(runMarks(name, text, 'python3')).toBe(false);
  });
});

describe('node:http under another name', () => {
  it.each([
    ['get.mjs', "import { get } from 'node:http';\nget(process.argv[2]);\n"],
    ['alias.mjs', "import { request as send } from 'node:http';\nsend(address);\n"],
    ['required.cjs', "const h = require('node:http');\nh.get(address);\n"],
    ['picked.cjs', "const { get: grab } = require('http');\ngrab(address);\n"],
    ['chained.cjs', "require('node:http').get(address);\n"],
    ['socket.mjs', "import * as net from 'node:net';\nnet.connect(80, host);\n"],
  ])('%s marks', (name, text) => {
    expect(runMarks(name, text, 'node')).toBe(true);
  });

  it.each([
    [
      'server.mjs',
      "import { createServer } from 'node:http';\ncreateServer((q, r) => r.end('ok')).listen(3000);\n",
    ],
    [
      'routes.cjs',
      "const http = require('node:http');\nconst app = makeApp();\napp.get('/x', handler);\nhttp.createServer(app).listen(3000);\n",
    ],
  ])('%s, a server, does not', (name, text) => {
    expect(runMarks(name, text, 'node')).toBe(false);
  });
});

describe('comments, read past strings and regexes', () => {
  it.each([
    ['hash.py', 'label = "a #b"; urlopen(address)\n', 'python3'],
    ['triple.py', 'doc = """\n# not a comment\n"""\nurlopen(address)\n', 'python3'],
    ['regex.js', 'const re = /\\/*x/; fetch(address);\nconst y = 1; // */\n', 'node'],
    ['string.js', 'const s = "/*"; fetch(address); // */\n', 'node'],
    ['template.js', 'const s = `// ${x}`; fetch(address);\n', 'node'],
  ])('%s keeps the call after it', (name, text, runner) => {
    expect(runMarks(name, text, runner)).toBe(true);
  });

  it('still leaves real comments out', () => {
    expect(withoutComments('x = 1  # https://made-up.example.com\ny = "#"\n', 'hash')).toBe(
      'x = 1  \ny = "#"\n'
    );
    expect(withoutComments('a(); // fetch(u)\n/* fetch(u) */ b(4 / 2);\n', 'slash')).toBe(
      'a(); \n b(4 / 2);\n'
    );
  });

  it('reads a long run of would-be regexes in one pass', () => {
    const text = `${'(/'.repeat(30_000)}\nfetch(address);\n`;
    const started = performance.now();
    expect(withoutComments(text, 'slash')).toContain('fetch(address)');
    expect(performance.now() - started).toBeLessThan(500);
  });
});
