/**
 * More ways a command runs a script (DOR-5261): `source`, TypeScript runners, launchers such as
 * `pnpm exec` and `uv run`, a script read on an interpreter's input, a shell script's `shift` and
 * `eval`, and a script the same line writes with `dd` or inline code.
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandReadsOutsideText } from '../shell-outside-text.js';

// The agent's own folder, in the temp folder, so its own files stay its own.
const PROJECT = mkdtempSync(path.join(os.tmpdir(), 'made-up-runners-'));
const marks = (command: string) =>
  commandReadsOutsideText(command, { cwd: PROJECT, agentHome: PROJECT });

const FILES: Record<string, string> = {
  'fetch.sh': '#!/bin/sh\ncurl -s "$1"\n',
  'fetch.ts': 'const page = await fetch(process.argv[2]);\n',
  'fetch.py': 'import urllib.request\nurllib.request.urlopen(URL)\n',
  'local.sh': 'echo "built"\nls\n',
  'local.ts': 'export const total = 1 + 1;\n',
  'local.py': 'print(sum([1, 2]))\n',
  'dispatch.sh': 'mode=$1\nshift\n"$@"\n',
  'evals.sh': 'eval "$1"\n',
  'guarded.sh': '[ -n "$NOPE" ] && shift\n"$@"\n',
  'either.sh': 'true || shift\n"$@"\n',
  'branch.sh': 'if [ "$1" = made-up ]; then\n  shift\nfi\n"$@"\n',
  'func.sh': 'drop() { shift; }\ndrop\n"$@"\n',
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

for (const [name, text] of Object.entries(FILES)) writeFileSync(path.join(PROJECT, name), text);

describe('a script that fetches, however it is run, marks', () => {
  it.each([
    'source ./fetch.sh',
    '. ./fetch.sh',
    'source fetch.sh made-up-argument',
    'tsx fetch.ts',
    'tsx watch fetch.ts',
    'ts-node fetch.ts',
    'pnpm tsx fetch.ts',
    'pnpm exec tsx fetch.ts',
    'pnpm --filter @made-up/app exec tsx fetch.ts',
    'yarn exec tsx fetch.ts',
    'uv run fetch.py',
    'uv run --with rich python fetch.py',
    'poetry run python fetch.py',
    'pipenv run python fetch.py',
    'poetry run gh issue list',
    'uv run -- curl -s made-up-host',
  ])('%s', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each(['source local.sh', 'tsx local.ts', 'pnpm tsx local.ts', 'uv run local.py'])(
    '%s stays local',
    (command) => {
      expect(marks(command)).toBe(false);
    }
  );
});

describe('a script read on an interpreter’s input', () => {
  it.each([
    'cat fetch.py | python3',
    'cat fetch.sh | bash',
    'bash -s < fetch.sh',
    'bash -s -- made-up-argument < fetch.sh',
    "echo 'gh issue list' | sh",
    'printf "curl -s %s" made-up-host | bash',
    'git show HEAD:fetch.py | python3',
    'cat fetch.sh |& bash',
    'cat fetch.sh |\n  bash',
    'made-up-tool "$(cat local.sh)" | sh',
    'echo $(cat local.sh) | sh',
  ])('%s marks', (command) => {
    expect(marks(command)).toBe(true);
  });

  it.each([
    'cat local.py | python3',
    'bash -s < local.sh',
    'echo ls | sh',
    'ls | wc -l',
    'cat local.py | python3 -c "import sys; print(len(sys.stdin.read()))"',
    'git diff || python3 local.py',
    'cat local.sh |& bash',
    'cat local.sh |\n  bash',
  ])('%s does not', (command) => {
    expect(marks(command)).toBe(false);
  });
});

describe('a shell script’s own arguments', () => {
  it('follows shift', () => {
    expect(marks('bash dispatch.sh fetch curl -s made-up-host')).toBe(true);
    expect(marks('bash dispatch.sh list ls -la')).toBe(false);
  });

  it.each(['guarded.sh', 'either.sh', 'branch.sh', 'func.sh'])(
    'reads %s with the arguments a shift may or may not have dropped',
    (script) => {
      expect(marks(`bash ${script} gh api made-up`)).toBe(true);
      expect(marks(`bash ${script} ls -la`)).toBe(false);
    }
  );

  it('reads eval with the arguments put in', () => {
    expect(marks("bash evals.sh 'gh issue list'")).toBe(true);
    expect(marks("bash evals.sh 'ls -la'")).toBe(false);
  });
});

describe('a script the same line writes, then runs', () => {
  it('dd writes its heredoc', () => {
    expect(marks("dd of=made.sh <<'EOF'\ncurl -s made-up-host\nEOF\nbash made.sh")).toBe(true);
    expect(marks("dd of=made.sh <<'EOF'\necho hi\nEOF\nbash made.sh")).toBe(false);
  });

  it('inline code may write anything to a file it names', () => {
    expect(marks(`python3 -c "open('made.sh', 'w').write(text)" && bash made.sh`)).toBe(true);
    expect(marks(`node -e "require('fs').writeFileSync('made.js', s)" && node made.js`)).toBe(true);
    expect(marks(`python3 -c "print(1)" && bash local.sh`)).toBe(false);
  });
});
