/** The actual nested main owns its deliberate exit after pinned readiness. */
import { lstat, readFile } from 'node:fs/promises';
import { fstatSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { openPosixGuardian, validateDarwinObserver } from '@dorkos/test-utils/run-custody/posix';
import { createCustodySetup } from '../global-setup.js';
export type RunnerExitMode = 'self-exit' | 'silent-worker';

export interface RunnerExitFixture {
  mode: RunnerExitMode;
  root: string;
  deadline: number;
  mainPid: number;
}
declare module 'vitest' {
  export interface ProvidedContext {
    runnerExitFixture: RunnerExitFixture;
  }
}
export default async function setup(project: TestProject) {
  const root = process.env.DORKOS_TEST_RUNNER_EXIT_ROOT;
  if (!root || process.env.DORKOS_TEST_RUNNER_EXIT_CHILD !== '1')
    throw new Error('Missing fixture context');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('Fixture root is not owned and private');
  const bytes = await readFile(join(root, 'context.json'));
  if (bytes.length > 1024) throw new Error('Fixture context exceeds bound');
  const context = JSON.parse(bytes.toString()) as {
    deadline: number;
    socketDirectory: string;
    mode: RunnerExitMode;
  };
  if (
    !Number.isFinite(context.deadline) ||
    context.deadline <= Date.now() ||
    dirname(context.socketDirectory) !== root ||
    (context.mode !== 'self-exit' && context.mode !== 'silent-worker')
  )
    throw new Error('Invalid fixture context');
  // Outer fixture owns this single private allocation and output descriptor.
  const stop = await createCustodySetup(async (request, signal) => {
    const current = () => {
      if (signal.aborted || (request.deadline !== null && request.deadline <= Date.now()))
        throw new Error('Fixture acquisition expired');
    };
    current();
    let observer: string | undefined;
    if (process.platform === 'darwin') {
      const directory = process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_DIR;
      const manifestSha256 = process.env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_MANIFEST_SHA256;
      if (!directory || !manifestSha256) throw new Error('Missing normal reviewed observer');
      observer = (await validateDarwinObserver({ directory, manifestSha256 })).path;
      current();
    }
    const handle = await openPosixGuardian({
      directory: context.socketDirectory,
      observer,
      signal,
      terminalCleanupReceiptFd: 3,
    });
    return {
      ...handle,
      connection: { ...handle.connection, transport: 'posix', directory: context.socketDirectory },
    };
  }, root)(project);
  project.provide('runnerExitFixture', {
    root,
    mode: context.mode,
    deadline: context.deadline,
    mainPid: process.pid,
  });
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void readFile(join(root, 'pinned-ready.json'))
      .then(async (ready) => {
        if (ready.length > 4096) throw new Error('Ready receipt exceeds bound');
        const record = JSON.parse(ready.toString());
        if (record.mainPid !== process.pid || record.starts !== 1 || record.ready !== true)
          throw new Error('Invalid readiness receipt');
        if (
          !Number.isSafeInteger(record.workerPid) ||
          record.workerPid <= 0 ||
          record.workerParentPid !== process.pid ||
          record.workerPid === process.pid
        )
          throw new Error('Readiness is not from this runner worker');
        if (context.mode === 'silent-worker') {
          const accepted = await readFile(join(root, 'outer-authorized.json'));
          if (accepted.length > 1024) throw new Error('Outer observation exceeds bound');
          const authorization = JSON.parse(accepted.toString());
          if (
            authorization.mainPid !== process.pid ||
            authorization.workerPid !== record.workerPid ||
            authorization.targetPid !== record.target?.pid
          )
            throw new Error('Outer observation does not match the owned fixture subjects');
          if (Date.now() >= context.deadline - 6000)
            throw new Error('Outer observation arrived after the fixture transition budget');
        }
        if (fstatSync(3).size !== 0) throw new Error('Cleanup preceded the fixture transition');
        writeFileSync(
          join(root, 'runner-transition.json'),
          JSON.stringify({
            kind: context.mode,
            code: 23,
            mainPid: process.pid,
            workerPid: record.workerPid,
          }) + '\n',
          { flag: 'wx', mode: 0o600 }
        );
        process.exit(23);
      })
      .catch((error) => {
        if (error.code !== 'ENOENT') process.exit(24);
        // Keep the existing5s custody cleanup allowance plus1s observation margin.
        if (Date.now() >= context.deadline - 6000) process.exit(24);
      })
      .finally(() => {
        checking = false;
      });
  }, 25);
  timer.unref();
  return async () => {
    clearInterval(timer);
    writeFileSync(join(root, 'normal-teardown-ran'), '', { flag: 'wx', mode: 0o600 });
    await stop();
  };
}
