/**
 * A script file a command runs is read for the network (DOR-5240): `python3 fetch.py`, `node x.mjs`,
 * `bash x.sh`, `./x.sh` by its `#!` line, and the rest of the interpreters the command line rules
 * already read.
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';
import { toolReadsOutsideText } from '../outside-text-tools.js';

// The agent's own folder, in the temp folder, so its own files stay its own.
const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'made-up-scripts-'));
const PLACE = { cwd: PROJECT, agentHome: PROJECT };
const marks = (command: string) => commandReadsOutsideText(command, PLACE);

const FILES: Record<string, string> = {
  'fetch.py': 'import urllib.request\nprint(urllib.request.urlopen(URL).read())\n',
  'get.py': '#!/usr/bin/env python3\nimport requests\nrequests.get(URL)\n',
  'fetch.js': 'const page = await fetch(process.argv[2]);\nconsole.log(await page.text());\n',
  'fetch.mjs': "import https from 'node:https';\nhttps.get(process.argv[2]);\n",
  'fetch.ts': 'const page = await fetch(Deno.args[0]);\n',
  'fetch.sh': '#!/bin/sh\ncurl -s "$1"\n',
  'nobang.sh': 'set -e\ngh issue list\n',
  'fetch.rb': "require 'net/http'\nputs Net::HTTP.get(URI(ARGV[0]))\n",
  'fetch.pl': 'use LWP::Simple;\nprint get($ARGV[0]);\n',
  'fetch.php': '<?php echo file_get_contents($argv[1]);\n',
  'sub/fetch.py': 'import socket\n',
  'local.py': 'print(sum([1, 2]))  # https://docs.example.com/sum\n',
  'local.js': '// https://docs.example.com/log\n/* https://example.com */\nconsole.log(1);\n',
  'local.sh': '#!/bin/sh\n# https://example.com/notes\necho "see https://example.com"\nls\n',
  'build.ts': 'export const total = 1 + 1;\n',
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

mkdirSync(path.join(PROJECT, 'sub'));
for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(PROJECT, name), text);

describe('a script file that fetches marks', () => {
  it.each([
    'python3 fetch.py',
    'python fetch.py',
    'python3 -u fetch.py https-less-argument',
    'python3 -W ignore fetch.py',
    './get.py',
    'node fetch.js https-less-argument',
    'node --require ./setup.cjs fetch.mjs',
    'bun fetch.js',
    'bun run fetch.js',
    'deno run --allow-net fetch.ts',
    'bash fetch.sh',
    'sh fetch.sh',
    'zsh fetch.sh',
    './fetch.sh',
    './nobang.sh',
    'ruby fetch.rb',
    'perl fetch.pl',
    'php fetch.php',
    'php -f fetch.php',
    'cd sub && python3 fetch.py',
    `python3 ${PROJECT}/fetch.py`,
    'ls && bash fetch.sh',
    'env DEBUG=1 python3 fetch.py',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it('through each runtime shell tool', () => {
    for (const [runtime, name] of [
      ['claude-code', 'Bash'],
      ['codex', 'Shell'],
      ['opencode', 'bash'],
    ] as const) {
      expect(toolReadsOutsideText(runtime, name, { command: 'python3 fetch.py' }, PLACE)).toBe(
        true
      );
    }
  });
});

describe('a script file that stays local does not mark', () => {
  it.each([
    'python3 local.py',
    'node local.js',
    'bash local.sh',
    './local.sh',
    'node build.ts',
    'python3 missing.py',
    'bash .',
    'python3 -c "print(1)"',
    'python3 -m pytest',
    'node -e "console.log(1)"',
    'bun test',
    'deno fmt',
  ])('%s', (command) => {
    expect(marks(command)).toBe(false);
  });
});
