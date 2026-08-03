import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Validates the load-bearing premise every watcher-error handler in this repo
 * depends on: that a REAL chokidar `FSWatcher`, watching with the same options
 * `session-list-watcher.ts` uses, actually emits an `error` event when it hits
 * a real EMFILE — as opposed to crashing the process, hanging, or (per
 * chokidar's own `// TODO: emit errors properly` note in `handler.js`) silently
 * dropping the failure.
 *
 * Every other watcher-error test in this repo either mocks chokidar or
 * hand-emits `'error'` on a real `FSWatcher` instance (`.emit('error', ...)`
 * from the test). Those prove our handlers work when chokidar does its part,
 * but none of them would catch a future chokidar upgrade that silently stopped
 * emitting `error` for EMFILE — which would make every one of those handlers
 * inert with an all-green suite. This test proves the premise directly.
 *
 * Mechanics: runs entirely inside an isolated child process (`bash -c "ulimit
 * -n 64 && node <script-file>"`). The low fd ceiling is a `ulimit` applied to
 * that one child and its own children — it never touches this test process,
 * other vitest workers, or the host machine's fd table. The script is written
 * to a real temp file rather than passed inline via `node -e "<script>"`:
 * `JSON.stringify`'s escaping (`\n`, `\"`, …) is JS/JSON syntax, not bash
 * double-quote syntax, so embedding a multi-line script directly in a `bash -c`
 * string silently corrupts it — a file path has no such ambiguity. The child
 * pre-exhausts its own fd budget with disposable dummy opens, frees a small
 * margin, then starts a real chokidar watch over a directory tree sized well
 * past that margin — reproducing the same "many watchers, low headroom" shape
 * as the real incident (a ~/.claude/projects with 183 dirs). If a margin
 * doesn't reproduce EMFILE (fd accounting varies by platform and chokidar
 * version), it retries with a larger one before giving up.
 *
 * Skips outright — never fails — on Windows (no `ulimit`) or wherever
 * `bash`/`ulimit` isn't available, since the goal is validating the real
 * mechanism where it can run, not asserting every CI sandbox supports it.
 */

const require = createRequire(import.meta.url);

const bashProbe = spawnSync('bash', ['-c', 'ulimit -n'], { encoding: 'utf-8' });
const canRunUlimit = process.platform !== 'win32' && !bashProbe.error && bashProbe.status === 0;

let root: string | undefined;

afterAll(() => {
  // The script file lives inside `root` (see below), so removing root
  // recursively already takes it with it.
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!canRunUlimit)('chokidar real EMFILE (isolated child process)', () => {
  it('emits a real error event with code EMFILE under genuine fd pressure', () => {
    const chokidarEntry = require.resolve('chokidar');

    root = mkdtempSync(join(tmpdir(), 'session-list-watcher-real-emfile-'));
    for (let i = 0; i < 300; i++) {
      mkdirSync(join(root, `d${i}`));
    }

    // Runs inside the child: exhausts this process's own fd budget, frees a
    // small margin, then starts a real chokidar watch with the same options
    // session-list-watcher.ts uses. Retries with a larger margin if the
    // previous one didn't reproduce EMFILE (fd accounting is platform- and
    // chokidar-version-sensitive).
    const script = `
        const fs = require('fs');
        const chokidar = require(${JSON.stringify(chokidarEntry)});
        const root = ${JSON.stringify(root)};

        function attempt(margin) {
          return new Promise((resolve) => {
            const dummies = [];
            try {
              for (let i = 0; i < 100000; i++) dummies.push(fs.openSync('/dev/null', 'r'));
            } catch (e) { /* fd budget exhausted, as intended */ }
            for (let i = 0; i < margin; i++) {
              const fd = dummies.pop();
              if (fd !== undefined) fs.closeSync(fd);
            }

            const w = chokidar.watch(root, {
              persistent: true,
              ignoreInitial: true,
              depth: 1,
              awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
            });
            const cleanup = () => {
              for (const fd of dummies) { try { fs.closeSync(fd); } catch (e) {} }
            };
            const timer = setTimeout(() => {
              w.close();
              cleanup();
              resolve(undefined);
            }, 3000);
            w.on('error', (err) => {
              clearTimeout(timer);
              w.close();
              cleanup();
              resolve(err && err.code);
            });
            w.on('ready', () => {
              clearTimeout(timer);
              w.close();
              cleanup();
              resolve(undefined);
            });
          });
        }

        (async () => {
          for (const margin of [1, 2, 3, 5, 8, 13, 21]) {
            const code = await attempt(margin);
            if (code) {
              console.log('RESULT:' + code);
              process.exit(0);
            }
          }
          console.log('RESULT:NONE');
          process.exit(1);
        })();
      `;

    // Written inside `root` (a 0700 mkdtempSync dir), not loose in the shared
    // system tmpdir: a predictable path in a world-writable /tmp on a
    // multi-user Linux box is a symlink-overwrite surface.
    const scriptPath = join(root, 'run.cjs');
    writeFileSync(scriptPath, script);

    // The path is passed as a real argv element ($1), not interpolated into the
    // command string: bash expands `$`, backticks, and `\` inside double
    // quotes, and TMPDIR may legally contain any of them — JSON.stringify-ing a
    // path into the command string is the same class of bug this file's
    // script-as-a-real-file design already avoids for the script contents.
    const result = spawnSync('bash', ['-c', 'ulimit -n 64 && exec node "$1"', 'bash', scriptPath], {
      encoding: 'utf-8',
      timeout: 60_000,
    });

    // Only skip on an actual inability to run the shell/ulimit combination
    // (unusual sandbox) — never on ETIMEDOUT. spawnSync sets `.error` for both,
    // and a future chokidar that hangs instead of erroring must fail this test
    // loudly, not read as "couldn't run here".
    if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') return;

    expect(result.stdout).toContain('RESULT:EMFILE');
  }, 60_000);
});
