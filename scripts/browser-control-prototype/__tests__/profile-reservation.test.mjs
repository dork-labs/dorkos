import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { once } from 'node:events';
import { startTestChild } from './child-startup.mjs';
import { reserveProfile, processIdentity, chromiumHolder } from '../profile-reservation.mjs';

const moduleUrl = new URL('../profile-reservation.mjs', import.meta.url).href;
async function root(t) {
  const path = await mkdtemp(join(tmpdir(), 'profile-reservation-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function childHolder(t, path, options) {
  const source = `import {reserveProfile} from ${JSON.stringify(moduleUrl)}; const r=reserveProfile(${JSON.stringify(path)},'worker'); r.createDirectory(); console.log('ready'); process.stdin.once('data',()=>{r.release();process.exit(0)});`;
  const worker = startTestChild(t, ['--input-type=module', '-e', source], options);
  const line = await worker.ready;
  assert.equal(line, 'ready');
  return worker.child;
}

test('live separate-process holder refuses a loser without changing profile bytes', async (t) => {
  // The competing process, not an in-memory map, must guard the exact profile.
  const path = await root(t);
  const child = await childHolder(t, path);
  const marker = join(path, 'worker', 'unchanged');
  await writeFile(marker, 'fixture-state', { mode: 0o600 });
  const before = await readdir(join(path, 'worker'));
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'PROFILE_IN_USE' });
  assert.equal(await readFile(marker, 'utf8'), 'fixture-state');
  assert.deepEqual(await readdir(join(path, 'worker')), before);
  const exited = once(child, 'exit');
  child.stdin.write('close');
  await exited;
  const reservation = reserveProfile(path, 'worker');
  reservation.release();
  reservation.release();
});

test('known-dead owner is recovered, corrupt unknown owner and abandoned recovery guard refuse', async (t) => {
  // A corrupt record is not evidence that its browser owner is dead.
  const path = await root(t);
  const child = await childHolder(t, path);
  const dead = once(child, 'exit');
  child.kill('SIGKILL');
  await dead;
  assert.equal(processIdentity(child.pid), null);
  const reservation = reserveProfile(path, 'worker');
  reservation.release();
  const file = join(path, '.reservations', 'worker.json');
  await writeFile(file, '{invalid', { mode: 0o600 });
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'UNKNOWN_OWNER' });
  await rm(file);
  await mkdir(join(path, '.reservations', 'worker.recovery'), { mode: 0o700 });
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'RECOVERY_BUSY' });
});

test('surviving Chromium singleton refuses a dead-manager reservation and is never removed', async (t) => {
  // A live process positive control makes unsafe SingletonLock removal observable.
  const path = await root(t);
  const reservation = reserveProfile(path, 'worker');
  reservation.createDirectory();
  reservation.release();
  const worker = startTestChild(t, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
  await worker.ready;
  const child = worker.child;
  const lock = join(path, 'worker', 'SingletonLock');
  await symlink(`${hostname()}-${child.pid}`, lock);
  assert.ok(processIdentity(child.pid));
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'BROWSER_STILL_RUNNING' });
  assert.ok((await readdir(join(path, 'worker'))).includes('SingletonLock'));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(() => chromiumHolder(join(path, 'worker')), {
      code: 'PROCESS_IDENTITY_UNAVAILABLE',
    });
  } finally {
    process.env.PATH = savedPath;
  }
});

test('recorded live browser refuses stale recovery and release after SingletonLock disappears', async (t) => {
  // A real owned child remains alive independently of Chromium's removable native lock.
  const path = await root(t);
  const holder = await childHolder(t, path);
  const worker = startTestChild(t, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
  await worker.ready;
  const browser = processIdentity(worker.child.pid);
  assert.ok(browser?.birth);
  const file = join(path, '.reservations', 'worker.json');
  const owner = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...owner, phase: 'running', browser }), { mode: 0o600 });
  const ended = once(holder, 'exit');
  holder.kill('SIGKILL');
  await ended;
  assert.equal(processIdentity(holder.pid), null);
  assert.deepEqual(await readdir(join(path, 'worker')), []);
  const before = await readFile(file, 'utf8');
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'BROWSER_STILL_RUNNING' });
  assert.equal(await readFile(file, 'utf8'), before);
  const browserEnded = once(worker.child, 'exit');
  worker.child.kill('SIGKILL');
  await browserEnded;
  const reservation = reserveProfile(path, 'worker');
  const live = startTestChild(t, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
  await live.ready;
  reservation.beginLaunch();
  reservation.recordBrowser(processIdentity(live.child.pid));
  assert.deepEqual(
    JSON.parse(await readFile(file, 'utf8')).browser,
    processIdentity(live.child.pid)
  );
  assert.throws(() => reservation.release(), { code: 'BROWSER_STILL_RUNNING' });
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(() => reservation.release(), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
  } finally {
    process.env.PATH = savedPath;
  }
  const stopped = once(live.child, 'exit');
  live.child.kill('SIGKILL');
  await stopped;
  reservation.release();
});

test('interrupted launch and legacy stale records require manual repair; reused PID births recover', async (t) => {
  // Missing native lock cannot prove that an interrupted launch never spawned a browser.
  const path = await root(t);
  const child = await childHolder(t, path);
  const file = join(path, '.reservations', 'worker.json');
  const owner = JSON.parse(await readFile(file, 'utf8'));
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  for (const prior of [
    { ...owner, phase: 'launching' },
    { pid: owner.pid, birth: owner.birth, nonce: owner.nonce },
  ]) {
    await writeFile(file, JSON.stringify(prior));
    assert.throws(() => reserveProfile(path, 'worker'), { code: 'BROWSER_IDENTITY_UNAVAILABLE' });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), prior);
  }
  await writeFile(
    file,
    JSON.stringify({
      ...owner,
      phase: 'running',
      browser: { pid: process.pid, birth: 'old-reused-birth' },
    })
  );
  const recovered = reserveProfile(path, 'worker');
  recovered.beginLaunch();
  assert.throws(() => recovered.recordBrowser({ pid: process.pid, birth: 'old-reused-birth' }), {
    code: 'BROWSER_IDENTITY_UNAVAILABLE',
  });
  assert.throws(() => recovered.release(), { code: 'BROWSER_IDENTITY_UNAVAILABLE' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).phase, 'launching');
  await writeFile(
    file,
    JSON.stringify({ ...owner, phase: 'running', browser: { pid: -1, birth: 'invalid' } })
  );
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'UNKNOWN_OWNER' });
});

test('traversal, symlink roots/profiles and public directories refuse', async (t) => {
  // Profile names cannot redirect storage into another person's tree.
  const path = await root(t);
  assert.throws(() => reserveProfile(path, '../escape'), { code: 'INVALID_PROFILE' });
  const target = join(path, 'target');
  await mkdir(target, { mode: 0o700 });
  const alias = join(path, 'alias');
  await symlink(target, alias);
  assert.throws(() => reserveProfile(alias, 'worker'), { code: 'UNSAFE_DIRECTORY' });
  await symlink(target, join(path, 'worker'));
  assert.throws(() => reserveProfile(path, 'worker'), { code: 'UNSAFE_DIRECTORY' });
  const publicDir = join(path, 'public');
  await mkdir(publicDir, { mode: 0o755 });
  assert.throws(() => reserveProfile(publicDir, 'worker'), { code: 'UNSAFE_DIRECTORY' });
});

test('child startup failures and missing readiness are bounded and leave no owned child', async (t) => {
  // Missing ps reproduces the reviewer failure before the child can publish a ready line.
  const path = await root(t);
  const source = `import {reserveProfile} from ${JSON.stringify(moduleUrl)};reserveProfile(${JSON.stringify(path)},'startup-failure');console.log('ready');`;
  const failed = startTestChild(t, ['--input-type=module', '-e', source], {
    env: { ...process.env, PATH: '' },
  });
  await assert.rejects(failed.ready, { code: 'EXIT_BEFORE_READY' });
  assert.notEqual(failed.child.exitCode, 0);
  assert.throws(() => process.kill(failed.child.pid, 0), { code: 'ESRCH' });
  const silent = startTestChild(t, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  await assert.rejects(silent.ready, { code: 'STARTUP_TIMEOUT' });
  assert.equal(silent.child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(silent.child.pid, 0), { code: 'ESRCH' });
  const spawnFailure = startTestChild(t, ['-e', "console.log('ready')"], {
    cwd: join(path, 'absent-directory'),
  });
  await assert.rejects(spawnFailure.ready, { code: 'SPAWN_FAILED' });
  assert.equal(spawnFailure.child.pid, undefined);
});
