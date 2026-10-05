import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../', import.meta.url));
const mutations = [
  {
    file: 'ownership.mjs',
    from: "record.state === 'live' ||",
    to: "record.state === 'reaped' || record.state === 'live' ||",
    name: 'post-reap ownership bypass',
    expected: 'opaque current-owned',
  },
  {
    file: 'ack.mjs',
    from: 'd.value === expected[key]',
    to: "(key === 'challenge' || d.value === expected[key])",
    name: 'challenge binding bypass',
    expected: 'every ACK binding',
  },
  {
    file: 'policy.mjs',
    from: 'this.signals >= LIMITS.signals',
    to: 'this.signals > LIMITS.signals',
    name: 'one extra signal',
    expected: 'caps permit exact boundary',
  },
];
for (const mutation of mutations)
  test(`actual isolated mutant is red: ${mutation.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'dork-darwin-mutant-'));
    try {
      cpSync(source, root, { recursive: true });
      const path = join(root, mutation.file);
      const text = readFileSync(path, 'utf8');
      assert.equal(text.split(mutation.from).length, 2, 'exact mutation match required');
      writeFileSync(path, text.replace(mutation.from, mutation.to));
      const environment = { ...process.env };
      // A fresh test runner must not inherit the parent's internal child-runner protocol.
      delete environment.NODE_TEST_CONTEXT;
      const result = spawnSync(
        process.execPath,
        ['--test', '--test-reporter=tap', join(root, '__tests__/controls.test.mjs')],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 1_000_000, env: environment }
      );
      if (process.env.DORKOS_DARWIN_PORTABLE_EVIDENCE_DIR) {
        const evidence = process.env.DORKOS_DARWIN_PORTABLE_EVIDENCE_DIR;
        mkdirSync(evidence, { recursive: true, mode: 0o700 });
        const name = mutation.name.replaceAll(' ', '-');
        writeFileSync(join(evidence, name + '.stdout.log'), result.stdout);
        writeFileSync(join(evidence, name + '.stderr.log'), result.stderr);
        writeFileSync(
          join(evidence, name + '.json'),
          JSON.stringify(
            {
              name: mutation.name,
              executable: process.execPath,
              reporter: 'tap',
              status: result.status,
              error: result.error?.message ?? null,
              nativeSubjects: 0,
              nativeSignals: 0,
            },
            null,
            2
          ) + '\n'
        );
      }
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stdout, new RegExp('not ok .*' + mutation.expected));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
